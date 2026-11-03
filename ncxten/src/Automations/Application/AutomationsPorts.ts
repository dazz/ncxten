import type { Automation } from "~/Automations/Domain/Automation.ts";
import type { Automations } from "~/Automations/Domain/Automations.ts";
import type { ConsumedInput, Finding } from "~/Automations/Domain/ConsumedInput.ts";
import type { Event } from "~/Automations/Domain/Event.ts";
import type { AutomationName, CommitId } from "~/Automations/Domain/Ids.ts";
import type { IsoDuration } from "~/Automations/Domain/IsoDuration.ts";
import type { Limits, Policy } from "~/Automations/Domain/Policy.ts";

/**
 * The eight ports of the Automations module (data-model.md): concepts, no
 * suffix. External systems stay behind them; tests use the in-memory
 * adapters, never mocks. `Clock` is the ninth, shared (`~/Shared/Clock.ts`).
 */

export type Stop = () => void;

/** Fires the tick on its interval; tests fire directly instead (FR-020). */
export interface Scheduler {
  start(interval: IsoDuration, fire: () => Promise<void>): Stop;
  /** One bounded wait — polling loops go through the port, never `setTimeout`. */
  sleep(milliseconds: number): Promise<void>;
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
