import type { AutomationName } from "~/Automations/Domain/Ids.ts";

/**
 * One entry of `automations.yml` (contracts/automations.md). `run` is the
 * session (002 re-cut, STACK: The cut): the command the factory executes
 * through the system shell — which agent it calls, where it works and what
 * "verified" means are lines inside that command, never factory fields. The
 * gate is declared and validated, unused until 003. The automation's
 * deterministic precheck is the new-input check for exactly this automation
 * (FR-031) — answered by the tracker's findings and decided in `Pass`.
 */
export class Automation {
  constructor(
    readonly name: AutomationName,
    readonly run: string,
    readonly gate: string | undefined = undefined,
  ) {
    if (run.trim() === "") throw new Error(`automation ${name}: run must not be empty`);
    if (gate !== undefined && gate.trim() === "") {
      throw new Error(`automation ${name}: gate must not be empty when declared`);
    }
  }
}
