/**
 * The event catalog (data-model.md). Domain events keep their past-tense
 * names in code; on disk every event is one schema v1 line — the contract
 * the observability pipeline already consumes (infra/) — whose identity is
 * `kind` + `outcome`. `JsonlEventLog` translates in both directions; the
 * mapping itself lives here, next to the events it describes.
 */

import type {
  AutomationName,
  CommitId,
  Revision,
  SessionId,
  SubjectId,
} from "~/Automations/Domain/Ids.ts";

import type { ReportedUsage } from "~/Automations/Domain/Usage.ts";

export type Level = "info" | "warn" | "error";
export type TickTrigger = "schedule" | "manual";
export type SkipReason = "running" | "paused";
export type SessionOutcome = "succeeded" | "failed" | "aborted" | "limit";

/**
 * The fixed failure classes (FR-090): the class, never the text, is what the
 * level derives from (FR-093) — `spawn` means the automation's command itself
 * is broken (a human must act), `exit` means the work failed (the reason is
 * in the session's output file; the factory cannot tell a failing task from
 * a logged-out agent, spec Non-Goals).
 */
export type FailureCause = "spawn" | "exit";

/** The only dimension the factory can observe from outside (FR-080/081). */
export type LimitDimension = "time";

/**
 * The session's process group: group id + the leader's start time in kernel
 * clock ticks (`/proc/<pid>/stat` field 22) — pids are recycled, so the pair
 * is what re-verifies the unit later (FR-066). The audit identity; the
 * operative cleanup identity is the environment mark pair.
 */
export interface ProcessUnit {
  readonly group: number;
  readonly startedAt: number;
}

/** The limits a session runs under, as the policy declares them. */
export interface SessionLimits {
  readonly turns: number;
  /** ISO 8601 duration, e.g. `PT20M`. */
  readonly time: string;
}

/** Marks a process generation; no state change. */
export interface ProjectStarted {
  readonly name: "ProjectStarted";
  readonly at: Date;
}

/** The policy in effect — the log says which limits a session ran under. */
export interface PolicyLoaded {
  readonly name: "PolicyLoaded";
  readonly at: Date;
  /** ISO 8601 duration, e.g. `PT15M`. */
  readonly tick: string;
  readonly limits: SessionLimits;
}

export interface ProjectPaused {
  readonly name: "ProjectPaused";
  readonly at: Date;
  readonly reason: string;
}

export interface ProjectResumed {
  readonly name: "ProjectResumed";
  readonly at: Date;
}

export interface ResumeFailed {
  readonly name: "ResumeFailed";
  readonly at: Date;
  readonly reason: string;
}

export interface ResumeIgnored {
  readonly name: "ResumeIgnored";
  readonly at: Date;
}

export interface AutomationsLoaded {
  readonly name: "AutomationsLoaded";
  readonly at: Date;
  readonly commit: CommitId;
}

/** An invalid revision; the last valid one (`keptCommit`) stays in effect. */
export interface AutomationsInvalid {
  readonly name: "AutomationsInvalid";
  readonly at: Date;
  readonly problem: string;
  readonly commit: CommitId;
  readonly keptCommit: CommitId;
}

/** No revision was ever valid — the project keeps ticking without automations. */
export interface AutomationsNeverValid {
  readonly name: "AutomationsNeverValid";
  readonly at: Date;
  readonly problem: string;
  readonly commit: CommitId;
}

/** The tick-ending event of an empty pass (FR-024's counterpart: a tick ran). */
export interface ProjectIdled {
  readonly name: "ProjectIdled";
  readonly at: Date;
}

/** The tick-ending event of a tick that did not run (FR-024). */
export interface TickSkipped {
  readonly name: "TickSkipped";
  readonly at: Date;
  readonly reason: SkipReason;
  readonly trigger: TickTrigger;
}

/** Liveness only (FR-028): never a state change, never "last tick". */
export interface HeartbeatRecorded {
  readonly name: "HeartbeatRecorded";
  readonly at: Date;
}

/** Written before dispatch (FR-043) — starting is what consumes the input (FR-035). */
export interface SessionStarted {
  readonly name: "SessionStarted";
  readonly at: Date;
  readonly automation: AutomationName;
  readonly subject: SubjectId;
  readonly revision: Revision;
  readonly sessionId: SessionId;
}

/**
 * Written directly **after** the command started (FR-066): the start record
 * precedes the launch (FR-092) and cannot know the unit. The recorded unit is
 * the reap's audit identity and verified fast path.
 */
export interface SessionLaunched {
  readonly name: "SessionLaunched";
  readonly at: Date;
  readonly automation: AutomationName;
  readonly subject: SubjectId;
  readonly sessionId: SessionId;
  readonly unit: ProcessUnit;
}

export interface SessionFinished {
  readonly name: "SessionFinished";
  readonly at: Date;
  readonly automation: AutomationName;
  readonly subject: SubjectId;
  readonly sessionId: SessionId;
  readonly outcome: "succeeded" | "failed";
  /** Only on `failed` — the fixed class the level derives from (FR-093). */
  readonly cause?: FailureCause;
  /** The exit code, the spawn reason, or a result-file problem (FR-067). */
  readonly detail?: string;
  /** What the result file reported — omitted where unknown (FR-067). */
  readonly usage?: ReportedUsage;
}

/**
 * The factory ended the session at the time limit — the whole process group
 * (FR-081). No usage: a killed command's result file is not read.
 */
export interface SessionLimited {
  readonly name: "SessionLimited";
  readonly at: Date;
  readonly automation: AutomationName;
  readonly subject: SubjectId;
  readonly sessionId: SessionId;
  readonly dimension: LimitDimension;
}

/**
 * The day's session budget is spent (FR-083): written **once per tick** — it
 * ends the drain, so a 15-minute tick pages nobody (FR-093). The hit's input
 * is not consumed.
 */
export interface BudgetExhausted {
  readonly name: "BudgetExhausted";
  readonly at: Date;
  /** The UTC calendar day the budget counts, e.g. `2026-11-03`. */
  readonly day: string;
  readonly started: number;
  readonly cap: number;
}

/** The drain reached the per-drain cap (FR-082): remaining input stays due. */
export interface DrainBounded {
  readonly name: "DrainBounded";
  readonly at: Date;
  readonly cap: number;
}

export function budgetDetail(event: BudgetExhausted): string {
  return `started today ${event.started} of ${event.cap}`;
}

export function drainDetail(event: DrainBounded): string {
  return `ran ${event.cap} sessions this drain`;
}

/** Orphan cleanup at start (FR-025): the previous generation died mid-session. */
export interface SessionAborted {
  readonly name: "SessionAborted";
  readonly at: Date;
  readonly automation: AutomationName;
  readonly subject: SubjectId;
  readonly sessionId: SessionId;
}

export type Event =
  | ProjectStarted
  | PolicyLoaded
  | ProjectPaused
  | ProjectResumed
  | ResumeFailed
  | ResumeIgnored
  | AutomationsLoaded
  | AutomationsInvalid
  | AutomationsNeverValid
  | ProjectIdled
  | TickSkipped
  | HeartbeatRecorded
  | SessionStarted
  | SessionLaunched
  | SessionFinished
  | SessionLimited
  | SessionAborted
  | BudgetExhausted
  | DrainBounded;

/** Event identity on disk: schema v1 has no `type`, only `kind` + `outcome`. */
export interface LineIdentity {
  readonly kind: string;
  readonly outcome: string;
}

const IDENTITIES = {
  ProjectStarted: { kind: "project", outcome: "started" },
  PolicyLoaded: { kind: "policy", outcome: "loaded" },
  ProjectPaused: { kind: "project", outcome: "paused" },
  ProjectResumed: { kind: "project", outcome: "resumed" },
  ResumeFailed: { kind: "resume", outcome: "failed" },
  ResumeIgnored: { kind: "resume", outcome: "ignored" },
  AutomationsLoaded: { kind: "automations", outcome: "loaded" },
  AutomationsInvalid: { kind: "automations", outcome: "invalid" },
  AutomationsNeverValid: { kind: "automations", outcome: "never-valid" },
  ProjectIdled: { kind: "tick", outcome: "idle" },
  TickSkipped: { kind: "tick", outcome: "skipped" },
  HeartbeatRecorded: { kind: "project", outcome: "heartbeat" },
  SessionStarted: { kind: "session", outcome: "started" },
  SessionLaunched: { kind: "session", outcome: "launched" },
  SessionLimited: { kind: "session", outcome: "limit" },
  SessionAborted: { kind: "session", outcome: "aborted" },
  BudgetExhausted: { kind: "limit", outcome: "sessions-per-day" },
  DrainBounded: { kind: "limit", outcome: "sessions-per-drain" },
} as const satisfies Record<Exclude<Event["name"], "SessionFinished">, LineIdentity>;

export function identityOf(event: Event): LineIdentity {
  // The one event whose outcome is not fixed by its name: a change of meaning
  // gets a new kind/outcome combination, never a reused one (append-only rule).
  if (event.name === "SessionFinished") return { kind: "session", outcome: event.outcome };
  return IDENTITIES[event.name];
}

/**
 * `error` = a human must act (Better Stack pushes on it), `warn` = something
 * failed but the project continues, `info` = the rest.
 */
export function levelOf(event: Event): Level {
  switch (event.name) {
    case "ProjectPaused":
    case "ResumeFailed":
    case "AutomationsInvalid":
    case "AutomationsNeverValid":
      return "error";
    case "SessionAborted":
    case "SessionLimited":
    case "BudgetExhausted":
      return "warn";
    case "SessionFinished":
      // The level derives from the cause class, never the text (FR-093):
      // `spawn` = the automation's command itself is broken, a human must act.
      if (event.outcome !== "failed") return "info";
      return event.cause === "spawn" ? "error" : "warn";
    default:
      return "info";
  }
}
