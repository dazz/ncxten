import { Command } from "@cliffy/command";
import { EventLogUnwritable } from "~/Automations/Application/EventLogUnwritable.ts";
import type { ResumeRequestOutcome } from "~/Automations/Application/RequestResume.ts";
import type { TickRequestOutcome } from "~/Automations/Application/RequestTick.ts";
import type { RunHandle } from "~/Automations/Application/RunProject.ts";
import type { StatusResult } from "~/Automations/Application/Status.ts";

/** Exit codes (contracts/cli.md). */
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_UNKNOWN_PROJECT = 69;
const EXIT_LOG_UNWRITABLE = 74;
const EXIT_LOCK_HELD = 75;

const PROJECT_ID = /^[^/\s]+\/[^/\s]+$/;
const UNKNOWN_PROJECT = "project unknown: no policy file and no event log";
const NO_PID = "running, but the pidfile holds no PID yet — try again";

/** Status output: label column width of the contracts/cli.md example. */
const STATUS_LABEL_WIDTH = 15;

/** What one project's wiring hands the flows: the use-case entry points, nothing else. */
export interface Assembly {
  /** The foreground process: start sequence, ticks, heartbeat, signals. */
  run(): Promise<RunHandle>;
  /** Tick now: nudge the running process, or run a one-shot generation. */
  tick(): Promise<TickRequestOutcome>;
  /** Lift a pause: via the running process, or a one-shot generation. */
  resume(): Promise<ResumeRequestOutcome>;
  status(): Promise<StatusResult>;
}

/** The `--config-dir` / `--state-dir` flags — main resolves env vars and XDG defaults. */
export interface RootOptions {
  readonly configDir?: string;
  readonly stateDir?: string;
}

export type Compose = (project: string, options: RootOptions) => Assembly;
export type Print = (line: string) => void;

/** `ncxten start <project>`: print the handle, then wait for its end (contracts/cli.md). */
export async function startFlow(a: Assembly, print: Print): Promise<number> {
  let handle: RunHandle;
  try {
    handle = await a.run();
  } catch (error) {
    print(String(error));
    return exitCodeOf(error);
  }
  if (handle.kind === "lock-held") {
    print("already running — the lock is held (exactly one process per project)");
    return EXIT_LOCK_HELD;
  }
  if (handle.kind === "unknown-project") {
    print(UNKNOWN_PROJECT);
    return EXIT_UNKNOWN_PROJECT;
  }
  print(handle.pauseReason === undefined ? "started" : `started paused — ${handle.pauseReason}`);
  try {
    await handle.finished;
    return EXIT_OK;
  } catch (error) {
    print(String(error));
    return exitCodeOf(error);
  }
}

export async function tickFlow(a: Assembly, print: Print): Promise<number> {
  let outcome: TickRequestOutcome;
  try {
    outcome = await a.tick();
  } catch (error) {
    print(String(error));
    return exitCodeOf(error);
  }
  switch (outcome.kind) {
    case "ticked":
      print("tick ran — outcome in the event log (ncxten status)");
      return EXIT_OK;
    case "nudged":
      print(
        `tick requested — SIGUSR1 sent to ${outcome.pid}; outcome in the event log (ncxten status)`,
      );
      return EXIT_OK;
    case "no-pid":
      print(NO_PID);
      return EXIT_ERROR;
    case "unknown-project":
      print(UNKNOWN_PROJECT);
      return EXIT_UNKNOWN_PROJECT;
  }
}

export async function resumeFlow(a: Assembly, print: Print): Promise<number> {
  let outcome: ResumeRequestOutcome;
  try {
    outcome = await a.resume();
  } catch (error) {
    print(String(error));
    return exitCodeOf(error);
  }
  switch (outcome.kind) {
    case "resumed":
      print("resumed");
      return EXIT_OK;
    case "failed":
      print(`still paused: ${outcome.reason}`);
      return EXIT_OK;
    case "ignored":
      print("not paused");
      return EXIT_OK;
    case "requested":
      print("resume requested — SIGHUP sent; result not yet in the log (ncxten status)");
      return EXIT_OK;
    case "no-pid":
      print(NO_PID);
      return EXIT_ERROR;
    case "unknown-project":
      print(UNKNOWN_PROJECT);
      return EXIT_UNKNOWN_PROJECT;
  }
}

/** `ncxten status <project>`: the report, formatted per contracts/cli.md. */
export async function statusFlow(a: Assembly, project: string, print: Print): Promise<number> {
  const result = await a.status();
  if (result.kind === "unknown-project") {
    print(UNKNOWN_PROJECT);
    return EXIT_UNKNOWN_PROJECT;
  }
  const line = (label: string, value: string) =>
    print(`${`${label}:`.padEnd(STATUS_LABEL_WIDTH)}${value}`);
  line("project", project);
  line(
    "state",
    result.state === "paused" ? `paused — ${result.pauseReason ?? "unknown"}` : result.state,
  );
  line(
    "process",
    result.processAlive
      ? "running"
      : result.openSession === undefined
        ? "not running"
        : "not running (open session will be aborted at next start)",
  );
  line(
    "last tick",
    result.lastTick === undefined
      ? "never"
      : `${result.lastTick.toISOString()}${
          result.lastTickSkipped === undefined ? "" : ` (skipped — ${result.lastTickSkipped})`
        }`,
  );
  line(
    "last session",
    result.lastSession === undefined
      ? "none yet"
      : `${result.lastSession.automation} → ${result.lastSession.outcome} (${result.lastSession.at.toISOString()})`,
  );
  if (result.lastDrainLimit !== undefined) {
    line(
      "last limit",
      `${result.lastDrainLimit.bound} — ${result.lastDrainLimit.detail} (${result.lastDrainLimit.at.toISOString()})`,
    );
  }
  if (result.lastError !== undefined) line("last error", result.lastError);
  return EXIT_OK;
}

function exitCodeOf(error: unknown): number {
  return error instanceof EventLogUnwritable ? EXIT_LOG_UNWRITABLE : EXIT_ERROR;
}

type ProjectAction = (assembly: Assembly, project: string) => Promise<number>;

function projectCommand(description: string, compose: Compose, action: ProjectAction) {
  // Return type inferred: cliffy's generics track options and arguments.
  return new Command()
    .description(description)
    .arguments("<project:string>")
    .option("--config-dir <path:string>", "Root of the policy files (NCXTEN_CONFIG_DIR).")
    .option("--state-dir <path:string>", "Root of event logs and project state (NCXTEN_STATE_DIR).")
    .action(async (options, project: string) => {
      if (!PROJECT_ID.test(project)) {
        console.error(`not a project ID: ${JSON.stringify(project)} — expected owner/repo`);
        process.exit(2);
      }
      const assembly = compose(project, options);
      process.exit(await action(assembly, project));
    });
}

/** The four commands of contracts/cli.md, wired onto the root command. */
export function automationsCommands(root: Command, compose: Compose): Command {
  // The chain re-types with every subcommand; the root reference stays the root.
  root
    .command(
      "start",
      projectCommand("Run the project process in the foreground.", compose, (assembly) =>
        startFlow(assembly, console.log),
      ),
    )
    .command(
      "tick",
      projectCommand("Tick now: nudge the running process, or run one tick.", compose, (assembly) =>
        tickFlow(assembly, console.log),
      ),
    )
    .command(
      "resume",
      projectCommand("Lift a pause: re-read and re-validate the policy.", compose, (assembly) =>
        resumeFlow(assembly, console.log),
      ),
    )
    .command(
      "status",
      projectCommand(
        "Replayed state, lock probe, last tick and error.",
        compose,
        (assembly, project) => statusFlow(assembly, project, console.log),
      ),
    );
  return root;
}
