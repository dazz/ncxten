/**
 * The day's session budget (FR-083): cap from the policy, started-today from
 * the replayed log (`Project.startedToday` — FR-044: no second counter), the
 * day a UTC calendar day. Counts **started** sessions — launch attempts —
 * whatever their outcome.
 */
export class DailyBudget {
  constructor(
    readonly cap: number,
    readonly startedToday: number,
  ) {}

  allows(): boolean {
    return this.startedToday < this.cap;
  }
}
