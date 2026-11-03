import {
  END_GRACE_MS,
  type EventLog,
  type GroupInvocation,
  type ProcessGroups,
  type RunResult,
  type Scheduler,
} from "~/Automations/Application/AutomationsPorts.ts";
import type { ProjectContext } from "~/Automations/Application/StartProject.ts";
import type { Event } from "~/Automations/Domain/Event.ts";
import { sessionId } from "~/Automations/Domain/Ids.ts";
import type { Hit } from "~/Automations/Domain/Pass.ts";
import type { Limits } from "~/Automations/Domain/Policy.ts";
import { Session } from "~/Automations/Domain/Session.ts";
import { isReported } from "~/Automations/Domain/Usage.ts";
import type { Clock } from "~/Shared/Clock.ts";

export interface SessionConfig {
  /** `owner/repo` — the project mark (FR-066), independent of the policy. */
  readonly repository: string;
  /** `<state-root>/projects/<o>/<r>/sessions` — output and result files derive from the id. */
  readonly sessionsDir: string;
  /** TERM → KILL grace when the deadline ends the group. */
  readonly endGraceMs?: number;
}

/**
 * One session (FR-092 order): `SessionStarted` → start the `run:` command as
 * a marked group in the checkout (env per contracts/run.md) →
 * `SessionLaunched {unit}` → watchdog vs exit → result file → closing event.
 * The deadline-vs-exit race lives here: the time limit is policy, the group
 * kill is mechanics (plan). A session whose start cannot be recorded does not
 * start (FR-053 — the append throws out of this method).
 */
export class RunSession {
  constructor(
    private readonly ports: {
      readonly runner: ProcessGroups;
      readonly runResult: RunResult;
      readonly log: EventLog;
      readonly clock: Clock;
      readonly scheduler: Scheduler;
    },
    private readonly context: ProjectContext,
    private readonly config: SessionConfig,
  ) {}

  async run(hit: Hit, limits: Limits): Promise<void> {
    const { runner, runResult, clock, scheduler } = this.ports;
    const checkout = this.context.policy?.checkout;
    if (checkout === undefined) throw new Error("session before start: no policy in effect");

    const session = new Session(sessionId(crypto.randomUUID()), hit.automation, hit.input, limits);
    await this.record({
      name: "SessionStarted",
      at: clock.now(),
      automation: session.automation.name,
      subject: session.input.subject,
      revision: session.input.revision,
      sessionId: session.sessionId,
    });

    const resultPath = `${this.config.sessionsDir}/${session.sessionId}.result.json`;
    const invocation: GroupInvocation = {
      run: session.automation.run,
      cwd: checkout,
      environment: {
        NCXTEN_PROJECT: this.config.repository,
        NCXTEN_SESSION: session.sessionId,
        NCXTEN_AUTOMATION: session.automation.name,
        NCXTEN_SUBJECT: session.input.subject,
        NCXTEN_REVISION: session.input.revision,
        NCXTEN_TIME_LIMIT: limits.time.text,
        NCXTEN_TURNS: String(limits.turns),
        NCXTEN_RESULT: resultPath,
      },
      outputPath: `${this.config.sessionsDir}/${session.sessionId}.out`,
    };

    const started = await runner.startGroup(invocation);
    if (started.kind === "spawn-failure") {
      // The automation's command itself is broken — error, a human must act
      // (FR-064/093); the input stays consumed (FR-035 holds uniformly).
      await this.record({
        name: "SessionFinished",
        at: clock.now(),
        automation: session.automation.name,
        subject: session.input.subject,
        sessionId: session.sessionId,
        outcome: "failed",
        cause: "spawn",
        detail: started.reason,
      });
      return;
    }

    // Directly after the start (FR-066): the start record precedes the launch
    // and cannot know the unit.
    await this.record({
      name: "SessionLaunched",
      at: clock.now(),
      automation: session.automation.name,
      subject: session.input.subject,
      sessionId: session.sessionId,
      unit: started.unit,
    });

    // The race (FR-081): deadline first ⇒ end the group — fully awaited, the
    // children write between TERM and KILL — record limit/time, ignore the
    // late exit and never read the result file (it may be half-written).
    let deadline = false;
    let ending: Promise<void> = Promise.resolve();
    const grace = this.config.endGraceMs ?? END_GRACE_MS;
    const cancel = scheduler.once(limits.time, () => {
      deadline = true;
      ending = runner.endGroup(started.unit, grace);
    });
    const { code } = await started.exited;
    cancel();

    if (deadline) {
      await ending;
      await this.record({
        name: "SessionLimited",
        at: clock.now(),
        automation: session.automation.name,
        subject: session.input.subject,
        sessionId: session.sessionId,
        dimension: "time",
      });
      return;
    }

    // A non-killed exit: the exit code is the contract (FR-063); the result
    // file is read and recorded — self-reported, trusted for nothing (FR-067).
    const reading = await runResult.read(resultPath);
    const usage =
      reading.kind === "reported" && isReported(reading.usage) ? reading.usage : undefined;
    const detail =
      code === 0
        ? reading.kind === "reported"
          ? reading.detail
          : reading.kind === "unreadable"
            ? reading.problem
            : undefined
        : `exit ${code}`;
    await this.record({
      name: "SessionFinished",
      at: clock.now(),
      automation: session.automation.name,
      subject: session.input.subject,
      sessionId: session.sessionId,
      outcome: code === 0 ? "succeeded" : "failed",
      ...(code === 0 ? {} : { cause: "exit" as const }),
      ...(detail === undefined ? {} : { detail }),
      ...(usage === undefined ? {} : { usage }),
    });
  }

  private async record(event: Event): Promise<void> {
    await this.ports.log.append(event);
    this.context.project.apply(event);
  }
}
