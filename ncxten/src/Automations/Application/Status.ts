import type {
  EventLog,
  InstanceLock,
  PolicySource,
} from "~/Automations/Application/AutomationsPorts.ts";
import type { SkipReason } from "~/Automations/Domain/Event.ts";
import { Policy } from "~/Automations/Domain/Policy.ts";
import {
  type DrainLimit,
  type LastSession,
  type OpenSession,
  Project,
  type ProjectState,
} from "~/Automations/Domain/Project.ts";

export interface StatusReport {
  readonly kind: "report";
  readonly state: ProjectState;
  readonly pauseReason: string | undefined;
  /** The lock probe: whether a project process is alive right now. */
  readonly processAlive: boolean;
  /** Still open in the log — a dead one is aborted at the next start. */
  readonly openSession: OpenSession | undefined;
  readonly lastTick: Date | undefined;
  readonly lastTickSkipped: SkipReason | undefined;
  readonly lastSession: LastSession | undefined;
  /** The newest drain-ending bound — a capped project never looks quiet (FR-084). */
  readonly lastDrainLimit: DrainLimit | undefined;
  readonly lastError: string | undefined;
}

export type StatusResult = StatusReport | { readonly kind: "unknown-project" };

/**
 * The status query (FR-042): replays the log — the CLI never reads JSONL —
 * and combines it with a non-blocking `InstanceLock.isHeld()` probe, because
 * a crashed process leaves a log ending in `SessionStarted` and status must
 * never show `running` for a dead session (FR-025).
 */
export class Status {
  constructor(
    private readonly ports: {
      readonly log: EventLog;
      readonly lock: InstanceLock;
      readonly policySource: PolicySource;
    },
  ) {}

  async run(): Promise<StatusResult> {
    const { log, lock, policySource } = this.ports;
    const project = new Project();
    let logExists = false;
    for await (const event of log.replay()) {
      logExists = true;
      project.apply(event);
    }
    if (!logExists) {
      const reading = await policySource.read();
      if (!(reading instanceof Policy) && reading.missing) return { kind: "unknown-project" };
    }

    const processAlive = lock.isHeld();
    const replayed = project.state();
    return {
      kind: "report",
      state: replayed === "running" && !processAlive ? "idle" : replayed,
      pauseReason: project.pauseReason(),
      processAlive,
      openSession: project.openSession(),
      lastTick: project.lastTick(),
      lastTickSkipped: project.lastTickSkipped(),
      lastSession: project.lastSession(),
      lastDrainLimit: project.lastDrainLimit(),
      lastError: project.lastError(),
    };
  }
}
