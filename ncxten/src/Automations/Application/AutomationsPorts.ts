import type { Automation } from "~/Automations/Domain/Automation.ts";
import type { Automations } from "~/Automations/Domain/Automations.ts";
import type { ConsumedInput, Finding } from "~/Automations/Domain/ConsumedInput.ts";
import type { Event, ProcessUnit } from "~/Automations/Domain/Event.ts";
import type { AutomationName, CommitId } from "~/Automations/Domain/Ids.ts";
import type { IsoDuration } from "~/Automations/Domain/IsoDuration.ts";
import type { Limits, Policy } from "~/Automations/Domain/Policy.ts";
import type { ReportedUsage } from "~/Automations/Domain/Usage.ts";

/**
 * The ports of the Automations module (data-model.md): concepts, no suffix.
 * External systems stay behind them; tests use the in-memory adapters, never
 * mocks. `Clock` is the shared one (`~/Shared/Clock.ts`).
 */

export type Stop = () => void;

/** Fires the tick on its interval; tests fire directly instead (FR-020). */
export interface Scheduler {
  start(interval: IsoDuration, fire: () => Promise<void>): Stop;
  /** The session deadline: a due date, not an interval (002). `Stop` cancels it. */
  once(delay: IsoDuration, fire: () => void): Stop;
  /** One bounded wait — polling loops go through the port, never `setTimeout`. */
  sleep(milliseconds: number): Promise<void>;
}

/**
 * How long TERM gets before KILL when the factory ends a group — a named
 * constant, not policy: the limit is policy, the grace is mechanics.
 */
export const END_GRACE_MS = 5_000;

/** The `run:` command as one marked process group goes in… (contracts/run.md) */
export interface GroupInvocation {
  /** The automation's `run:` string, executed through the system shell. */
  readonly run: string;
  /** The repo checkout (FR-060). */
  readonly cwd: string;
  /** Added to the factory's own environment — both marks included (FR-061/066). */
  readonly environment: Readonly<Record<string, string>>;
  /** stdout+stderr teed here live — kill cases included (FR-062). */
  readonly outputPath: string;
}

/** …and the unit (before the exit — launch record and watchdog need it) comes out. */
export type GroupStart =
  | {
      readonly kind: "started";
      readonly unit: ProcessUnit;
      readonly exited: Promise<{ readonly code: number }>;
    }
  | { readonly kind: "spawn-failure"; readonly reason: string };

/**
 * Marked process groups (STACK Process model) — the session's endable unit.
 * The real adapter is `BunProcessRunner`, still the ONE spawning file; the
 * fake is scriptable and never spawns. The port lives here because the
 * application may not import an outer layer (ARCHITECTURE.md).
 */
export interface ProcessGroups {
  startGroup(invocation: GroupInvocation): Promise<GroupStart>;
  /**
   * TERM the group → KILL after the grace, unconditionally (a leader that
   * dies on TERM does not spare a TERM-ignoring child) → mark re-scan for
   * strays. Verifies id + start time before the first signal; refuses the
   * factory's own group.
   */
  endGroup(unit: ProcessUnit, graceMs: number): Promise<void>;
  /**
   * End every group carrying the **own project's** mark, repeated until no
   * marked process remains (FR-070) — the start-up reaper, log-independent;
   * sibling projects untouched.
   */
  endMarked(projectMark: string, graceMs: number): Promise<void>;
}

export type RunResultReading =
  | { readonly kind: "reported"; readonly usage: ReportedUsage; readonly detail?: string }
  | { readonly kind: "none" }
  | { readonly kind: "unreadable"; readonly problem: string };

/**
 * The command's optional result file (FR-067): lenient by contract — missing
 * = none, broken = unreadable, never an error. Self-reported, trusted for
 * nothing.
 */
export interface RunResult {
  read(path: string): Promise<RunResultReading>;
}

/**
 * 001's harness outcomes, pinned: the port is retired by the 002 re-cut
 * (STACK: The cut) and never learns `limit` — the shim goes when the port's
 * last consumers migrate to the process runner.
 */
export type LegacyHarnessOutcome = "succeeded" | "failed" | "aborted";

/** Runs one session. The `FakeHarness` is a shipped adapter, not a test hack. */
export interface Harness {
  run(automation: Automation, input: ConsumedInput, limits: Limits): Promise<LegacyHarnessOutcome>;
}

/** The automation's deterministic precheck answers from here (slice 1). */
export interface Tracker {
  findings(automation: AutomationName): Promise<readonly Finding[]>;
}

/** The source of truth. Append is fsynced; replay tolerates a truncated last line. */
export interface EventLog {
  append(event: Event): Promise<void>;
  replay(): AsyncIterable<Event>;
}

/** Parsed value or problem — never raw text; parsing (YAML, zod) lives in Infrastructure. */
export interface PolicyProblem {
  /** Carries the failing path, e.g. `policy.limits.turns: expected number`. */
  readonly problem: string;
  /** No file at all — the unknown-project guard (exit 69) needs the difference. */
  readonly missing: boolean;
}

/** Read at start and on resume from a pause only (FR-004). */
export interface PolicySource {
  read(): Promise<Policy | PolicyProblem>;
}

export type AutomationsReading =
  | { readonly automations: Automations }
  | { readonly problem: string; readonly commit: CommitId };

/** Reads `automations.yml` at the default branch head — parsed, with its commit. */
export interface AutomationsSource {
  read(): Promise<AutomationsReading>;
}

/** SIGHUP = resume, SIGUSR1 = tick now (STACK: the control channel as signals). */
export type ControlSignal = "SIGHUP" | "SIGUSR1";

/** Both halves of the nudges; `SignalControlChannel` maps them onto Unix signals. */
export interface ControlChannel {
  onResume(fn: () => void): void;
  onTickNow(fn: () => void): void;
  /** SIGTERM / SIGINT — the clean end of the foreground process (contracts/cli.md). */
  onShutdown(fn: () => void): void;
  /** The sending half: nudge the process that holds the lock. */
  signal(pid: number, signal: ControlSignal): void;
}

/** One process per project (FR-027). `acquire` retries briefly (named constant). */
export interface InstanceLock {
  acquire(): Promise<boolean>;
  /** Whether some process holds it, without taking it — the `ncxten status` probe (FR-025). */
  isHeld(): boolean;
  /** The holder's PID from the pidfile — the signal address for the nudges. */
  holderPid(): Promise<number | undefined>;
}
