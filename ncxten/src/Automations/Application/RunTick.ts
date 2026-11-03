import type { AutomationsSource, EventLog } from "~/Automations/Application/AutomationsPorts.ts";
import type { RunPass } from "~/Automations/Application/RunPass.ts";
import type { ProjectContext } from "~/Automations/Application/StartProject.ts";
import type { Automations } from "~/Automations/Domain/Automations.ts";
import type { Event, TickTrigger } from "~/Automations/Domain/Event.ts";
import { utcDay } from "~/Automations/Domain/Project.ts";
import type { Clock } from "~/Shared/Clock.ts";

/**
 * The tick: load the automations, drain pass by pass until one is empty.
 * Every tick ends with exactly one of `ProjectIdled` | `TickSkipped`
 * (data-model invariant). Sessions are strictly sequential (FR-023); a tick
 * during a drain is skipped, never queued (FR-026); a tick on a paused
 * project is skipped without any input check (FR-024).
 */
export class RunTick {
  private draining = false;
  /** Last valid version in effect — replace-on-valid (FR-012). */
  private lastValid: Automations | undefined;

  constructor(
    private readonly ports: {
      readonly automationsSource: AutomationsSource;
      readonly log: EventLog;
      readonly clock: Clock;
    },
    private readonly context: ProjectContext,
    private readonly runPass: RunPass,
  ) {}

  async run(trigger: TickTrigger): Promise<void> {
    const project = this.context.project;
    if (project.state() === "paused") {
      await this.record({
        name: "TickSkipped",
        at: this.ports.clock.now(),
        reason: "paused",
        trigger,
      });
      return;
    }
    if (this.draining || project.state() === "running") {
      await this.record({
        name: "TickSkipped",
        at: this.ports.clock.now(),
        reason: "running",
        trigger,
      });
      return;
    }
    const policy = this.context.policy;
    if (policy === undefined) throw new Error("tick before start: no policy in effect");

    this.draining = true;
    try {
      const automations = await this.loadAutomations();
      if (automations !== undefined) {
        // drain: pass, session, next pass — until an empty pass (FR-023),
        // the per-drain cap (FR-082) or the day's budget (FR-083) ends it.
        let ran = 0;
        while (true) {
          if (ran >= policy.limits.sessionsPerDrain) {
            // Normal operation under load (info): remaining input was not
            // consumed and becomes the next tick's first hits.
            await this.record({
              name: "DrainBounded",
              at: this.ports.clock.now(),
              cap: policy.limits.sessionsPerDrain,
            });
            break;
          }
          const result = await this.runPass.run(automations, policy.limits);
          if (result === "session-ran") {
            ran += 1;
            continue;
          }
          if (result === "budget-exhausted") {
            // Once per tick, never per pass — a 15-minute tick pages nobody
            // (FR-093); the hit's input is not consumed (FR-083).
            const now = this.ports.clock.now();
            await this.record({
              name: "BudgetExhausted",
              at: now,
              day: utcDay(now),
              started: this.context.project.startedToday(now),
              cap: policy.limits.sessionsPerDay,
            });
            break;
          }
          break; // empty pass — the drain found nothing (FR-023)
        }
      }
      // The tick-ending invariant holds: limits end the drain, not the tick.
      await this.record({ name: "ProjectIdled", at: this.ports.clock.now() });
    } finally {
      this.draining = false;
    }
  }

  /** The lifecycle of `contracts/automations.md`: loaded / invalid / never valid. */
  private async loadAutomations(): Promise<Automations | undefined> {
    const at = () => this.ports.clock.now();
    const reading = await this.ports.automationsSource.read();

    if ("automations" in reading) {
      if (reading.automations.commit !== this.lastValid?.commit) {
        // Appended before the new version takes effect (FR-043).
        await this.record({
          name: "AutomationsLoaded",
          at: at(),
          commit: reading.automations.commit,
        });
      }
      this.lastValid = reading.automations;
      return this.lastValid;
    }

    const kept = this.lastValid?.commit ?? this.context.project.lastValidAutomationsCommit();
    if (kept !== undefined) {
      await this.record({
        name: "AutomationsInvalid",
        at: at(),
        problem: reading.problem,
        commit: reading.commit,
        keptCommit: kept,
      });
      // After a restart the kept commit is known from the replay but its
      // content is not in memory — the tick then idles until a valid commit.
      return this.lastValid;
    }
    await this.record({
      name: "AutomationsNeverValid",
      at: at(),
      problem: reading.problem,
      commit: reading.commit,
    });
    return undefined;
  }

  private async record(event: Event): Promise<void> {
    await this.ports.log.append(event);
    this.context.project.apply(event);
  }
}
