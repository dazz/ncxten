import type { Tracker } from "~/Automations/Application/AutomationsPorts.ts";
import type { RunSession } from "~/Automations/Application/RunSession.ts";
import type { ProjectContext } from "~/Automations/Application/StartProject.ts";
import type { Automations } from "~/Automations/Domain/Automations.ts";
import type { Finding } from "~/Automations/Domain/ConsumedInput.ts";
import { DailyBudget } from "~/Automations/Domain/DailyBudget.ts";
import type { AutomationName } from "~/Automations/Domain/Ids.ts";
import { findHit } from "~/Automations/Domain/Pass.ts";
import type { Limits } from "~/Automations/Domain/Policy.ts";
import type { Clock } from "~/Shared/Clock.ts";

export type PassResult = "session-ran" | "empty-pass" | "budget-exhausted";

/**
 * One pass: gather the findings, let the domain decide (`Pass.findHit`), run
 * at most one session. The daily budget is checked **before the hit
 * launches** (FR-083): an exhausted budget starts nothing and consumes
 * nothing — the input becomes due again when the day rolls over. The session
 * itself — record, launch, race, closing event — is `RunSession`'s.
 */
export class RunPass {
  constructor(
    private readonly ports: {
      readonly tracker: Tracker;
      readonly clock: Clock;
    },
    private readonly context: ProjectContext,
    private readonly runSession: RunSession,
  ) {}

  async run(automations: Automations, limits: Limits): Promise<PassResult> {
    const { tracker, clock } = this.ports;
    const project = this.context.project;

    const findings = new Map<AutomationName, readonly Finding[]>();
    for (const automation of automations.inOrder()) {
      findings.set(automation.name, await tracker.findings(automation.name));
    }
    const hit = findHit(automations, findings, (automation, subject) =>
      project.consumedRevision(automation, subject),
    );
    if (hit === undefined) return "empty-pass";

    // Counted from the replayed starts, the UTC day at read time (FR-044).
    const budget = new DailyBudget(limits.sessionsPerDay, project.startedToday(clock.now()));
    if (!budget.allows()) return "budget-exhausted";

    await this.runSession.run(hit, limits);
    return "session-ran";
  }
}
