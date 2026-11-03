import type { Harness, LegacyHarnessOutcome } from "~/Automations/Application/AutomationsPorts.ts";
import type { Automation } from "~/Automations/Domain/Automation.ts";
import type { ConsumedInput } from "~/Automations/Domain/ConsumedInput.ts";
import { type AutomationName, automationName } from "~/Automations/Domain/Ids.ts";
import type { Limits } from "~/Automations/Domain/Policy.ts";

/** What one scripted session does when the harness runs it. */
export type SessionScript = () => Promise<LegacyHarnessOutcome>;

export function succeed(): SessionScript {
  return () => Promise.resolve("succeeded");
}

export function fail(): SessionScript {
  return () => Promise.resolve("failed");
}

/** Never resolves — the crash case: only the next generation's orphan abort ends it. */
export function hangUntilAborted(): SessionScript {
  return () => new Promise<LegacyHarnessOutcome>(() => {});
}

export interface HarnessCall {
  readonly automation: Automation;
  readonly input: ConsumedInput;
  readonly limits: Limits;
}

/**
 * The fake harness — a **shipped adapter**, not a test hack (STACK): scripted
 * per automation, records every call with the limits it was handed (FR-032).
 * Unscripted automations succeed.
 */
export class FakeHarness implements Harness {
  private readonly scripts = new Map<AutomationName, SessionScript>();
  private readonly record: HarnessCall[] = [];

  script(automation: string, script: SessionScript): void {
    this.scripts.set(automationName(automation), script);
  }

  run(automation: Automation, input: ConsumedInput, limits: Limits): Promise<LegacyHarnessOutcome> {
    this.record.push({ automation, input, limits });
    const script = this.scripts.get(automation.name) ?? succeed();
    return script();
  }

  /** For assertions: every session the harness ran, in order. */
  calls(): readonly HarnessCall[] {
    return [...this.record];
  }
}
