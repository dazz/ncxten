import { IsoDuration } from "~/Automations/Domain/IsoDuration.ts";

/**
 * The tick bounds (contracts/policy.md): they catch the two classic typos —
 * `PT15S` (every 15 seconds, hammers the forge's rate limits) and `P15M`
 * (fifteen months, effectively never).
 */
export const TICK_MINIMUM = IsoDuration.parse("PT1M", "tick minimum");
export const TICK_MAXIMUM = IsoDuration.parse("PT24H", "tick maximum");

/** What the policy declares in `~/.config/ncxten/<owner>/<repo>.yaml` when nothing is set. */
export const DEFAULT_TICK = IsoDuration.parse("PT15M", "tick default");

const MINIMUM_TURNS = 1;
const REPOSITORY = /^[^/\s]+\/[^/\s]+$/;

/** Where new input comes from: GitHub with 003; `file` seeds the DoD run (002). */
export type TrackerKind = "github-issues" | "file";

/**
 * The limits a session runs under (FR-032): `time` is enforced by the factory
 * (the whole process group ends, FR-081), the counts bound the drain and the
 * UTC day (FR-082/083), and `turns` is a **hint** handed to the run command
 * (`NCXTEN_TURNS`) — the factory cannot see turns (FR-080).
 */
export interface Limits {
  readonly turns: number;
  readonly time: IsoDuration;
  /** The cost ceiling of one tick (FR-082). */
  readonly sessionsPerDrain: number;
  /** Required always: the factory cannot know whether a command costs money (FR-083). */
  readonly sessionsPerDay: number;
}

export interface PolicyFields {
  /** `owner/repo` — the project ID itself; everything but the checkout derives from it. */
  readonly repository: string;
  /** The forge host for event lines (`github.com`) — omitted on lines without a valid policy. */
  readonly forge: string;
  /** Which tracker adapter answers the prechecks (contracts/policy.md). */
  readonly tracker: TrackerKind;
  /** The local clone; the only path in the policy (contracts/policy.md). */
  readonly checkout: string;
  readonly tick: IsoDuration;
  readonly limits: Limits;
}

/**
 * The validated policy value object — the fields this slice uses (FR-003);
 * the full schema with its defaults lives in `YamlPolicy` (zod,
 * Infrastructure), which hands over a parsed `Policy` or a problem.
 */
export class Policy {
  readonly repository: string;
  readonly forge: string;
  readonly tracker: TrackerKind;
  readonly checkout: string;
  readonly tick: IsoDuration;
  readonly limits: Limits;

  constructor(fields: PolicyFields) {
    const { repository, forge, tracker, checkout, tick, limits } = fields;
    if (!REPOSITORY.test(repository)) {
      throw new Error(`repo.repository: ${JSON.stringify(repository)} is not owner/repo`);
    }
    if (forge.trim() === "") {
      throw new Error("repo.forge: must not be empty");
    }
    if (!checkout.startsWith("/")) {
      throw new Error(`repo.paths.checkout: ${JSON.stringify(checkout)} is not an absolute path`);
    }
    if (tick.milliseconds < TICK_MINIMUM.milliseconds) {
      throw new Error(`policy.tick: ${tick.text} is below the minimum ${TICK_MINIMUM.text}`);
    }
    if (tick.milliseconds > TICK_MAXIMUM.milliseconds) {
      throw new Error(`policy.tick: ${tick.text} is above the maximum ${TICK_MAXIMUM.text}`);
    }
    if (!Number.isInteger(limits.turns) || limits.turns < MINIMUM_TURNS) {
      throw new Error(`policy.limits.turns: must be a positive integer, got ${limits.turns}`);
    }
    if (limits.time.milliseconds <= 0) {
      throw new Error(`policy.limits.time: ${limits.time.text} must be a positive duration`);
    }
    if (!Number.isInteger(limits.sessionsPerDrain) || limits.sessionsPerDrain < 1) {
      throw new Error(
        `policy.limits.sessions-per-drain: must be a positive integer, got ${limits.sessionsPerDrain}`,
      );
    }
    if (!Number.isInteger(limits.sessionsPerDay) || limits.sessionsPerDay < 1) {
      throw new Error(
        `policy.limits.sessions-per-day: must be a positive integer, got ${limits.sessionsPerDay}`,
      );
    }
    this.repository = repository;
    this.forge = forge;
    this.tracker = tracker;
    this.checkout = checkout;
    this.tick = tick;
    this.limits = limits;
  }
}
