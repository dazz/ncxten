import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "@cliffy/command";
import type { AutomationsSource, Tracker } from "~/Automations/Application/AutomationsPorts.ts";
import { RecordHeartbeat } from "~/Automations/Application/RecordHeartbeat.ts";
import { RequestResume } from "~/Automations/Application/RequestResume.ts";
import { RequestTick } from "~/Automations/Application/RequestTick.ts";
import { Resume } from "~/Automations/Application/Resume.ts";
import { RunPass } from "~/Automations/Application/RunPass.ts";
import { RunProject } from "~/Automations/Application/RunProject.ts";
import { RunSession } from "~/Automations/Application/RunSession.ts";
import { RunTick } from "~/Automations/Application/RunTick.ts";
import { freshContext, StartProject } from "~/Automations/Application/StartProject.ts";
import { Status } from "~/Automations/Application/Status.ts";
import { FileTracker } from "~/Automations/Infrastructure/FileTracker.ts";
import { FlockInstanceLock } from "~/Automations/Infrastructure/FlockInstanceLock.ts";
import { FsRunResult } from "~/Automations/Infrastructure/FsRunResult.ts";
import { GitAutomationsSource } from "~/Automations/Infrastructure/GitAutomationsSource.ts";
import { JsonlEventLog } from "~/Automations/Infrastructure/JsonlEventLog.ts";
import { SignalControlChannel } from "~/Automations/Infrastructure/SignalControlChannel.ts";
import { TimerScheduler } from "~/Automations/Infrastructure/TimerScheduler.ts";
import { YamlPolicy } from "~/Automations/Infrastructure/YamlPolicy.ts";
import {
  type Assembly,
  automationsCommands,
  type RootOptions,
} from "~/Automations/UI/AutomationsRoute.ts";
import { BunProcessRunner } from "~/Process/BunProcessRunner.ts";
import { SystemClock } from "~/Shared/Clock.ts";

const VERSION = "0.1.0";

export interface Roots {
  readonly configDir: string;
  readonly stateDir: string;
}

/** Flag, then env var, then the XDG default (contracts/cli.md). */
export function resolveRoots(options: RootOptions): Roots {
  return {
    configDir:
      options.configDir ?? process.env.NCXTEN_CONFIG_DIR ?? join(homedir(), ".config/ncxten"),
    stateDir:
      options.stateDir ?? process.env.NCXTEN_STATE_DIR ?? join(homedir(), ".local/state/ncxten"),
  };
}

/**
 * The composition root: one project's hexagon from the real adapters. It
 * spawns nothing itself — processes go through the ProcessRunner adapter,
 * sessions through its marked groups (002). The tracker is the policy's
 * choice: the findings file, or an empty source until 003 brings GitHub.
 */
function composeProject(project: string, options: RootOptions): Assembly {
  const roots = resolveRoots(options);
  const context = freshContext();
  const clock = new SystemClock();
  const log = new JsonlEventLog(
    join(roots.stateDir, "events", `${project}.jsonl`),
    project,
    () => context.policy?.forge,
  );
  const policySource = new YamlPolicy(join(roots.configDir, `${project}.yaml`));
  const lock = new FlockInstanceLock(join(roots.stateDir, "projects", project, "ncxten.pid"));
  const scheduler = new TimerScheduler();
  const control = new SignalControlChannel();
  const runner = new BunProcessRunner();
  const automationsSource: AutomationsSource = {
    // The checkout comes from the policy, which is in effect only after
    // PolicyLoaded — and a paused project skips its ticks before any read.
    read: () => {
      const checkout = context.policy?.checkout;
      if (checkout === undefined) {
        throw new Error("no policy in effect — nothing to read automations from");
      }
      return new GitAutomationsSource(checkout, runner).read();
    },
  };
  const runResult = new FsRunResult();
  const fileTracker = new FileTracker(join(roots.stateDir, "projects", project, "findings.yaml"));
  // The policy chooses the tracker (repo.tracker, in effect after PolicyLoaded);
  // `github-issues` stays an empty source until 003 brings the forge.
  const tracker: Tracker = {
    findings: (automation) =>
      context.policy?.tracker === "file" ? fileTracker.findings(automation) : Promise.resolve([]),
  };
  const runSession = new RunSession({ runner, runResult, log, clock, scheduler }, context, {
    repository: project,
    sessionsDir: join(roots.stateDir, "projects", project, "sessions"),
  });
  const runPass = new RunPass({ tracker, clock }, context, runSession);
  const runTick = new RunTick({ automationsSource, log, clock }, context, runPass);
  const startProject = new StartProject(
    { lock, log, policySource, clock, runner },
    context,
    project,
  );
  const resumeProject = new Resume({ policySource, log, clock }, context);
  const statusQuery = new Status({ log, lock, policySource });
  const heartbeat = new RecordHeartbeat({ log, clock }, context);
  const runProject = new RunProject({ scheduler, control }, context, {
    start: startProject,
    tick: runTick,
    resume: resumeProject,
    heartbeat,
  });
  const requestTick = new RequestTick({ lock, control }, { start: startProject, tick: runTick });
  const requestResume = new RequestResume(
    { lock, control, scheduler },
    { start: startProject, resume: resumeProject, status: statusQuery },
  );
  return {
    run: () => runProject.run(),
    tick: () => requestTick.run(),
    resume: () => requestResume.run(),
    status: () => statusQuery.run(),
  };
}

export function cli(): Command {
  const root = new Command()
    .name("ncxten")
    .version(VERSION)
    .description("The software factory: one project process per repository.")
    .action(function (this: Command) {
      this.showHelp();
    });
  return automationsCommands(root, composeProject);
}

if (import.meta.main) {
  await cli().parse();
}
