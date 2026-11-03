import { mkdir, open, readdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  GroupInvocation,
  GroupStart,
  ProcessGroups,
} from "~/Automations/Application/AutomationsPorts.ts";
import type { ProcessUnit } from "~/Automations/Domain/Event.ts";
import { type Command, ProcessResult, type ProcessRunner } from "~/Process/ProcessRunner.ts";

/** The inherited marks (contracts/run.md) — the operative cleanup identity. */
const MARK_PROJECT = "NCXTEN_PROJECT";
const MARK_SESSION = "NCXTEN_SESSION";

/** A reap that cannot end the marks in this many rounds is a factory defect. */
const REAP_ATTEMPTS = 5;

/** How long a lingering pipe holder may delay the exit's flush, not the exit. */
const STREAM_FLUSH_MS = 500;

/**
 * The only file in `src/` that may spawn a process (enforced by the boundary
 * test, as in dazzhub). `Bun.spawn([program, ...args])` starts no shell for
 * `run()`; `startGroup` runs the automation's `run:` string through `sh -c`
 * as leader of its own process group (STACK Process model, spike 2026-11-02).
 * Linux-only from 002: the marks are scanned in `/proc/<pid>/environ`.
 */
export class BunProcessRunner implements ProcessRunner, ProcessGroups {
  /** The marks of groups this process started — the re-scan key for `endGroup`. */
  private readonly started = new Map<number, { session?: string }>();

  async run(command: Command): Promise<ProcessResult> {
    const child = spawn(command);
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return new ProcessResult(code, stdout, stderr);
  }

  async startGroup(invocation: GroupInvocation): Promise<GroupStart> {
    await mkdir(dirname(invocation.outputPath), { recursive: true });
    const output = await open(invocation.outputPath, "a");

    let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      child = Bun.spawn(["sh", "-c", invocation.run], {
        cwd: invocation.cwd,
        env: { ...process.env, ...invocation.environment },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        // The group leader: the time limit and the reaper end -pid (STACK).
        detached: true,
      });
    } catch (error) {
      await output.close();
      return { kind: "spawn-failure", reason: (error as Error).message ?? String(error) };
    }

    // Pids are recycled: the pair (group id, leader start time) re-verifies
    // the unit later (FR-066). A command that exited before the read gets 0 —
    // a stale unit that verification will refuse to signal.
    const startedAt = (await startTimeOf(child.pid)) ?? 0;
    const unit: ProcessUnit = { group: child.pid, startedAt };
    const session = invocation.environment[MARK_SESSION];
    this.started.set(child.pid, session === undefined ? {} : { session });

    // Live tee (FR-062): both streams, chunk by chunk — kill and crash cases
    // (the ones a human reads) have the transcript up to the last flush.
    let queue: Promise<unknown> = Promise.resolve();
    const tee = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) {
        queue = queue.then(() => output.write(chunk));
        await queue;
      }
    };
    const pumps = Promise.allSettled([tee(child.stdout), tee(child.stderr)]);
    // The pipes outlive the leader when a child keeps them open — close the
    // file when the last writer is gone, in the background.
    const flushed = pumps.then(async () => {
      await queue;
      await output.close();
    });
    flushed.catch(() => undefined);

    const exited = (async () => {
      const code = await child.exited;
      // The exit code is the contract; give lingering writers a bounded flush.
      await Promise.race([flushed, sleep(STREAM_FLUSH_MS)]);
      return { code };
    })();

    return { kind: "started", unit, exited };
  }

  async endGroup(unit: ProcessUnit, graceMs: number): Promise<void> {
    const own = (await ownProcessGroup()) ?? process.pid;
    if (unit.group === own) {
      throw new Error(`refusing to end the factory's own process group ${unit.group}`);
    }

    // Verified identity before the first signal (FR-066): a recycled id with
    // a different start time is somebody else — never signaled directly.
    if ((await startTimeOf(unit.group)) === unit.startedAt) {
      signalGroup(unit.group, "SIGTERM");
      await sleep(graceMs);
      // Unconditionally: a leader that died on TERM does not spare a child
      // that ignores it — the group outlives its leader.
      signalGroup(unit.group, "SIGKILL");
    }

    // Mark re-scan for strays — also the path when the leader already exited
    // but marked children remain (the group id alone is then unverifiable).
    const marks = this.started.get(unit.group);
    if (marks?.session !== undefined) {
      await this.reapByMark(MARK_SESSION, marks.session, graceMs, own);
    }
    this.started.delete(unit.group);
  }

  async endMarked(projectMark: string, graceMs: number): Promise<void> {
    await this.reapByMark(
      MARK_PROJECT,
      projectMark,
      graceMs,
      (await ownProcessGroup()) ?? process.pid,
    );
  }

  /**
   * TERM → grace → KILL every group with a marked member, re-scan, repeat
   * until no marked process remains (FR-070: repeatable until confirmed
   * dead). Never the factory's own group, never an unmarked process.
   */
  private async reapByMark(
    mark: string,
    value: string,
    graceMs: number,
    ownGroup: number,
  ): Promise<void> {
    for (let attempt = 0; attempt < REAP_ATTEMPTS; attempt += 1) {
      const groups = await markedGroups(mark, value, ownGroup);
      if (groups.length === 0) return;
      for (const group of groups) signalGroup(group, "SIGTERM");
      await sleep(graceMs);
      for (const group of groups) signalGroup(group, "SIGKILL");
    }
    if ((await markedGroups(mark, value, ownGroup)).length > 0) {
      throw new Error(
        `processes marked ${mark}=${value} survived ${REAP_ATTEMPTS} reap attempts — a factory defect`,
      );
    }
  }
}

function spawn(command: Command) {
  try {
    return Bun.spawn([command.program, ...command.args], {
      env: { ...process.env, ...command.environment },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      throw new Error(`${command.program} is not installed or not on PATH`);
    }
    throw error;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** `kill(-group)` addresses every member; a group already gone is fine. */
function signalGroup(group: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-group, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/**
 * `/proc/<pid>/stat` field 22 (starttime), parsed after the last `)` — the
 * comm field may itself contain spaces and parentheses (spike 2026-11-02).
 */
async function statFields(pid: number): Promise<string[] | undefined> {
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
  const rest = stat.slice(stat.lastIndexOf(")") + 1).trim();
  return rest.split(" ");
}

const AFTER_COMM = 3; // the first field after `pid (comm)` is field 3 (state)
const FIELD_PGRP = 5;
const FIELD_STARTTIME = 22;

async function startTimeOf(pid: number): Promise<number | undefined> {
  const fields = await statFields(pid);
  const raw = fields?.[FIELD_STARTTIME - AFTER_COMM];
  return raw === undefined ? undefined : Number(raw);
}

async function groupOf(pid: number): Promise<number | undefined> {
  const fields = await statFields(pid);
  const raw = fields?.[FIELD_PGRP - AFTER_COMM];
  return raw === undefined ? undefined : Number(raw);
}

function ownProcessGroup(): Promise<number | undefined> {
  return groupOf(process.pid);
}

/** The process groups with a member whose environ carries `mark=value`. */
async function markedGroups(
  mark: string,
  value: string,
  ownGroup: number | undefined,
): Promise<number[]> {
  const entry = `${mark}=${value}`;
  const groups = new Set<number>();
  let pids: string[];
  try {
    pids = await readdir("/proc");
  } catch {
    return [];
  }
  for (const name of pids) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    let environ: Buffer;
    try {
      environ = Buffer.from(await readFile(`/proc/${pid}/environ`));
    } catch {
      continue; // gone, or not ours to read — then not ours to signal either
    }
    const marked = environ.toString("utf8").split("\0").includes(entry);
    if (!marked) continue;
    const group = await groupOf(pid);
    if (group === undefined || group === ownGroup) continue;
    groups.add(group);
  }
  return [...groups];
}
