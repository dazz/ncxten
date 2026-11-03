import {
  budgetDetail,
  drainDetail,
  type Event,
  type ProcessUnit,
  type SessionOutcome,
  type SkipReason,
} from "~/Automations/Domain/Event.ts";
import type {
  AutomationName,
  CommitId,
  Revision,
  SessionId,
  SubjectId,
} from "~/Automations/Domain/Ids.ts";

export type ProjectState = "running" | "idle" | "paused";

export interface OpenSession {
  readonly sessionId: SessionId;
  readonly automation: AutomationName;
  readonly subject: SubjectId;
  readonly revision: Revision;
  /** The recorded process unit — set at launch, where the launch was reached. */
  readonly unit?: ProcessUnit;
}

/** What `ncxten status` says about the newest finished or aborted session. */
export interface LastSession {
  readonly automation: AutomationName;
  readonly outcome: SessionOutcome;
  readonly at: Date;
}

/**
 * The newest drain-ending bound (FR-084): shown by `ncxten status` beside the
 * last session — a capped project must never look like a quiet one. Superseded
 * by newer limit events, never cleared.
 */
export interface DrainLimit {
  readonly bound: "sessions-per-day" | "sessions-per-drain";
  readonly detail: string;
  readonly at: Date;
}

/**
 * The rebuilt state (data-model.md): a fold over the event log, all of it a
 * deletable cache — the log is the source of truth (FR-044). `paused` survives
 * restart because it is replayed, not held in memory (FR-051).
 */
export class Project {
  private currentState: ProjectState = "idle";
  private pauseReasonValue: string | undefined;
  private openSessionValue: OpenSession | undefined;
  private readonly consumed = new Map<string, Revision>();
  private lastValidAutomationsCommitValue: CommitId | undefined;
  private lastTickValue: Date | undefined;
  private lastTickSkippedValue: SkipReason | undefined;
  private lastSessionValue: LastSession | undefined;
  private lastErrorValue: string | undefined;
  private lastErrorFromAutomations = false;
  /** Sessions started per UTC day — derived at apply time, read per day (FR-044). */
  private readonly startedByDay = new Map<string, number>();
  private lastDrainLimitValue: DrainLimit | undefined;

  static replay(events: Iterable<Event>): Project {
    const project = new Project();
    for (const event of events) project.apply(event);
    return project;
  }

  apply(event: Event): void {
    switch (event.name) {
      case "ProjectPaused":
        this.currentState = "paused";
        this.pauseReasonValue = event.reason;
        this.recordError(event.reason, false);
        return;
      case "ProjectResumed":
        this.currentState = "idle";
        this.pauseReasonValue = undefined;
        return;
      case "ResumeFailed":
        // Stays paused; only the reason is updated.
        this.pauseReasonValue = event.reason;
        this.recordError(event.reason, false);
        return;
      case "AutomationsLoaded":
        this.lastValidAutomationsCommitValue = event.commit;
        // A valid load resolves an automations problem; a pause reason stays.
        if (this.lastErrorFromAutomations) this.recordError(undefined, false);
        return;
      case "AutomationsInvalid":
        // The kept commit stays in effect — only the error is recorded.
        this.recordError(event.problem, true);
        return;
      case "AutomationsNeverValid":
        this.currentState = "idle";
        this.recordError(event.problem, true);
        return;
      case "ProjectIdled":
        this.currentState = "idle";
        this.lastTickValue = event.at;
        this.lastTickSkippedValue = undefined;
        return;
      case "TickSkipped":
        this.lastTickValue = event.at;
        this.lastTickSkippedValue = event.reason;
        return;
      case "SessionStarted":
        this.currentState = "running";
        this.openSessionValue = {
          sessionId: event.sessionId,
          automation: event.automation,
          subject: event.subject,
          revision: event.revision,
        };
        // Starting consumes the input, whatever the outcome (FR-035, FR-043).
        this.consumed.set(consumedKey(event.automation, event.subject), event.revision);
        // Started counts toward the UTC day's budget (FR-083) — launch attempts.
        this.startedByDay.set(utcDay(event.at), (this.startedByDay.get(utcDay(event.at)) ?? 0) + 1);
        return;
      case "SessionLaunched":
        // The open session gains its unit — the reap's audit identity (FR-066).
        if (this.openSessionValue?.sessionId === event.sessionId) {
          this.openSessionValue = { ...this.openSessionValue, unit: event.unit };
        }
        return;
      case "SessionLimited":
        this.currentState = "idle";
        this.openSessionValue = undefined;
        this.lastSessionValue = { automation: event.automation, outcome: "limit", at: event.at };
        return;
      case "BudgetExhausted":
        this.lastDrainLimitValue = {
          bound: "sessions-per-day",
          detail: budgetDetail(event),
          at: event.at,
        };
        return;
      case "DrainBounded":
        this.lastDrainLimitValue = {
          bound: "sessions-per-drain",
          detail: drainDetail(event),
          at: event.at,
        };
        return;
      case "SessionFinished":
        // Back to idle: `running` means an open session, and only that. The
        // no-parallel-session guard during a drain is the tick's own flag —
        // a replayed `running` here would skip every tick after a restart.
        this.currentState = "idle";
        this.openSessionValue = undefined;
        this.lastSessionValue = {
          automation: event.automation,
          outcome: event.outcome,
          at: event.at,
        };
        return;
      case "SessionAborted":
        this.currentState = "idle";
        this.openSessionValue = undefined;
        this.lastSessionValue = { automation: event.automation, outcome: "aborted", at: event.at };
        return;
      default:
        // ProjectStarted, PolicyLoaded, ResumeIgnored, HeartbeatRecorded —
        // and every kind/outcome this version does not know (extension rule):
        // recorded, never folded.
        return;
    }
  }

  state(): ProjectState {
    return this.currentState;
  }

  pauseReason(): string | undefined {
    return this.pauseReasonValue;
  }

  openSession(): OpenSession | undefined {
    return this.openSessionValue;
  }

  /** The revision a session already consumed for automation + subject (FR-035). */
  consumedRevision(automation: AutomationName, subject: SubjectId): Revision | undefined {
    return this.consumed.get(consumedKey(automation, subject));
  }

  lastValidAutomationsCommit(): CommitId | undefined {
    return this.lastValidAutomationsCommitValue;
  }

  /** The newer of the tick-ending events — never a heartbeat. */
  lastTick(): Date | undefined {
    return this.lastTickValue;
  }

  /** Why the last tick was skipped; `undefined` when it ran (`ProjectIdled`). */
  lastTickSkipped(): SkipReason | undefined {
    return this.lastTickSkippedValue;
  }

  lastSession(): LastSession | undefined {
    return this.lastSessionValue;
  }

  /**
   * Sessions started in `now`'s UTC calendar day (FR-083) — counted from the
   * replayed starts, the day boundary computed at read time; nothing stored
   * beyond the fold (FR-044).
   */
  startedToday(now: Date): number {
    return this.startedByDay.get(utcDay(now)) ?? 0;
  }

  lastDrainLimit(): DrainLimit | undefined {
    return this.lastDrainLimitValue;
  }

  lastError(): string | undefined {
    return this.lastErrorValue;
  }

  private recordError(error: string | undefined, fromAutomations: boolean): void {
    this.lastErrorValue = error;
    this.lastErrorFromAutomations = fromAutomations;
  }
}

function consumedKey(automation: string, subject: string): string {
  // U+001F (unit separator) cannot appear in either part — no two pairs collide.
  return `${automation}\u001F${subject}`;
}

/** The UTC calendar day, `YYYY-MM-DD` (decision 2026-11-02). */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, "YYYY-MM-DD".length);
}
