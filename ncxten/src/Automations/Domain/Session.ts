import type { Automation } from "~/Automations/Domain/Automation.ts";
import type { ConsumedInput } from "~/Automations/Domain/ConsumedInput.ts";
import type { ProcessUnit, SessionOutcome } from "~/Automations/Domain/Event.ts";
import type { SessionId } from "~/Automations/Domain/Ids.ts";
import type { Limits } from "~/Automations/Domain/Policy.ts";
import type { ReportedUsage } from "~/Automations/Domain/Usage.ts";

/**
 * One session: an automation's `run:` command run once on its consumed input,
 * under the policy's limits (FR-032). Since 002 a marked process group: the
 * unit arrives at launch (FR-066), usage where the result file reported it
 * (FR-067); the outcome comes from how the group ends — until then the
 * session is open.
 */
export class Session {
  constructor(
    readonly sessionId: SessionId,
    readonly automation: Automation,
    readonly input: ConsumedInput,
    readonly limits: Limits,
    readonly outcome: SessionOutcome | undefined = undefined,
    readonly unit: ProcessUnit | undefined = undefined,
    readonly usage: ReportedUsage | undefined = undefined,
  ) {
    if (input.automation !== automation.name) {
      throw new Error(
        `session ${sessionId}: input belongs to ${input.automation}, not ${automation.name}`,
      );
    }
  }

  /** The command started: the session gains its unit (FR-066). */
  launched(unit: ProcessUnit): Session {
    return new Session(this.sessionId, this.automation, this.input, this.limits, undefined, unit);
  }

  finishedWith(outcome: SessionOutcome, usage?: ReportedUsage): Session {
    return new Session(
      this.sessionId,
      this.automation,
      this.input,
      this.limits,
      outcome,
      this.unit,
      usage,
    );
  }

  isOpen(): boolean {
    return this.outcome === undefined;
  }
}
