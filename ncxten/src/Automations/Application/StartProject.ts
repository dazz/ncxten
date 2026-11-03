import {
  END_GRACE_MS,
  type EventLog,
  type InstanceLock,
  type PolicySource,
  type ProcessGroups,
} from "~/Automations/Application/AutomationsPorts.ts";
import type { Event } from "~/Automations/Domain/Event.ts";
import { Policy } from "~/Automations/Domain/Policy.ts";
import { Project } from "~/Automations/Domain/Project.ts";
import type { Clock } from "~/Shared/Clock.ts";

/**
 * What one process generation shares: the replayed project and the policy in
 * effect. `StartProject` fills it; tick, resume and the drain read and apply
 * through it. All of it is a deletable cache of the log (FR-044).
 */
export interface ProjectContext {
  project: Project;
  policy: Policy | undefined;
}

export function freshContext(): ProjectContext {
  return { project: new Project(), policy: undefined };
}

export type StartResult =
  /** Running — possibly paused (FR-051): the policy was unreadable or invalid. */
  | { readonly kind: "started" }
  /** Another process holds the lock (exit 75) — without s6 nothing restarts it, so this refuses late (FR-027). */
  | { readonly kind: "lock-held" }
  /** No policy file and no event log (exit 69): a typo'd project ID must not create ghost state. */
  | { readonly kind: "unknown-project" };

/**
 * The start sequence of **every** process generation, one-shots included
 * (data-model): lock → replay → `ProjectStarted` → `SessionAborted(orphaned)`
 * per open session → mark reap (FR-070) → read policy → `PolicyLoaded` or
 * `ProjectPaused`. Execution order and event order are the same; lock, log
 * and reap need no path from the policy.
 */
export class StartProject {
  constructor(
    private readonly ports: {
      readonly lock: InstanceLock;
      readonly log: EventLog;
      readonly policySource: PolicySource;
      readonly clock: Clock;
      readonly runner: ProcessGroups;
    },
    private readonly context: ProjectContext,
    /** `owner/repo` — the project mark; the reap needs no policy (FR-070). */
    private readonly repository: string,
  ) {}

  async run(): Promise<StartResult> {
    const { lock, log, policySource, clock, runner } = this.ports;
    if (!(await lock.acquire())) return { kind: "lock-held" };

    const project = new Project();
    let logExists = false;
    for await (const event of log.replay()) {
      logExists = true;
      project.apply(event);
    }
    this.context.project = project;

    // The unknown-project guard peeks at the policy before the first append —
    // refusing must not create the very log whose absence it checks.
    let reading = logExists ? undefined : await policySource.read();
    if (reading !== undefined && !(reading instanceof Policy) && reading.missing) {
      return { kind: "unknown-project" };
    }

    await this.record({ name: "ProjectStarted", at: clock.now() });

    const orphan = project.openSession();
    if (orphan !== undefined) {
      // The record precedes the reap (FR-043); the logged unit stays the
      // audit identity — the scan below is what actually ends processes.
      await this.record({
        name: "SessionAborted",
        at: clock.now(),
        automation: orphan.automation,
        subject: orphan.subject,
        sessionId: orphan.sessionId,
      });
    }

    // End every process carrying the own project's mark (FR-070):
    // log-independent — with one process per project, nothing marked may
    // live at start, whatever the log says (a second crash during an
    // earlier cleanup changes nothing but the number of attempts). Never
    // the factory's own group, never a sibling project's marks.
    await runner.endMarked(this.repository, END_GRACE_MS);

    reading ??= await policySource.read();
    if (reading instanceof Policy) {
      // In effect before its announcement, so the line itself carries the forge.
      this.context.policy = reading;
      await this.record({
        name: "PolicyLoaded",
        at: clock.now(),
        tick: reading.tick.text,
        limits: { turns: reading.limits.turns, time: reading.limits.time.text },
      });
    } else {
      // Unreadable and invalid both pause (contracts/policy.md); a replayed
      // pause stays paused regardless (FR-051) — only `resume` lifts it.
      await this.record({ name: "ProjectPaused", at: clock.now(), reason: reading.problem });
      this.context.policy = undefined;
    }
    return { kind: "started" };
  }

  private async record(event: Event): Promise<void> {
    await this.ports.log.append(event);
    this.context.project.apply(event);
  }
}
