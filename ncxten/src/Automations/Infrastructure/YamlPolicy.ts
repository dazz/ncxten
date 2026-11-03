import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { PolicyProblem, PolicySource } from "~/Automations/Application/AutomationsPorts.ts";
import { IsoDuration } from "~/Automations/Domain/IsoDuration.ts";
import { Policy } from "~/Automations/Domain/Policy.ts";

/**
 * The policy schema (contracts/policy.md): every field declared exactly once
 * with type and default — the v2 UI form generates from this. Strict: an
 * unknown key fails with its path, because a typo must not silently remove a
 * limit. Most fields are declared and validated but unused in this slice
 * (FR-003), so a complete Zielbild policy passes unchanged.
 */
/** Pause after this many same-class errors in a row (a later slice uses it). */
const SAME_ERROR_CLASS_DEFAULT = 3;
/** The cost ceiling of one tick (002 FR-082, contracts/policy.md). */
const SESSIONS_PER_DRAIN_DEFAULT = 5;

const SCHEMA = z.strictObject({
  repo: z.strictObject({
    repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "must be owner/repo"),
    forge: z.enum(["github"]).default("github"),
    // `file` reads findings from the project state dir — the DoD seed source
    // until 003 brings GitHub (002 quickstart).
    tracker: z.enum(["github-issues", "file"]).default("github-issues"),
    paths: z.strictObject({
      checkout: z.string().startsWith("/", "must be an absolute path"),
    }),
  }),
  policy: z.strictObject({
    tick: z.string().default("PT15M"),
    harness: z.enum(["claude", "codex", "pi", "fake"]).default("claude"),
    models: z
      .strictObject({
        cheap: z.string().default("claude-sonnet"),
        default: z.string().default("claude-sonnet"),
        strong: z.string().default("claude-sonnet"),
      })
      .prefault({}),
    "session-model": z.enum(["per-step"]).default("per-step"),
    workspace: z.enum(["worktree", "clone", "container"]).default("worktree"),
    "gate-source": z.enum(["local", "container", "forge-pipeline"]).default("local"),
    limits: z.strictObject({
      turns: z.int().positive(),
      time: z.string(),
      tokens: z.int().positive().optional(),
      "same-error-class": z.int().positive().default(SAME_ERROR_CLASS_DEFAULT),
      "sessions-per-drain": z.int().positive().default(SESSIONS_PER_DRAIN_DEFAULT),
      // Required always (002 re-cut, FR-083): the factory cannot know whether
      // a run: command costs money, so every project carries the cap.
      "sessions-per-day": z.int().positive(),
      "rounds-per-pr": z.int().positive().optional(),
    }),
    "merge-policy": z
      .enum(["approved-is-approved", "path-lax", "patch-id", "strict"])
      .default("approved-is-approved"),
    "sensitive-paths": z.array(z.string()).default(["automations.yml"]),
    "trusted-authors": z.array(z.string()).default([]),
    credentials: z.string().optional(),
  }),
});

/** The forge enum names the adapter; event lines carry the host. */
const FORGE_HOSTS: Record<string, string> = { github: "github.com" };

/**
 * Reads `<config-dir>/<owner>/<repo>.yaml` — parsed `Policy` or a problem
 * with the failing path, never raw text. Read at start and on resume only
 * (FR-004).
 */
export class YamlPolicy implements PolicySource {
  constructor(private readonly path: string) {}

  async read(): Promise<Policy | PolicyProblem> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { problem: `no policy file at ${this.path}`, missing: true };
      }
      return { problem: `policy unreadable: ${String(error)}`, missing: false };
    }

    let data: unknown;
    try {
      data = Bun.YAML.parse(raw);
    } catch (error) {
      return { problem: `policy is not YAML: ${(error as Error).message}`, missing: false };
    }

    const parsed = SCHEMA.safeParse(data);
    if (!parsed.success) {
      // Prefer the unknown-key issue: the typo's own path says more than
      // the missing field it shadows (`policy.limitz`, not `limits missing`).
      const issue =
        parsed.error.issues.find((candidate) => candidate.code === "unrecognized_keys") ??
        parsed.error.issues[0];
      const path = issue?.path.join(".") || "policy";
      return { problem: `${path}: ${issue?.message ?? "invalid"}`, missing: false };
    }

    try {
      return new Policy({
        repository: parsed.data.repo.repository,
        forge: FORGE_HOSTS[parsed.data.repo.forge] ?? parsed.data.repo.forge,
        tracker: parsed.data.repo.tracker,
        checkout: parsed.data.repo.paths.checkout,
        tick: IsoDuration.parse(parsed.data.policy.tick, "policy.tick"),
        limits: {
          turns: parsed.data.policy.limits.turns,
          time: IsoDuration.parse(parsed.data.policy.limits.time, "policy.limits.time"),
          sessionsPerDrain: parsed.data.policy.limits["sessions-per-drain"],
          sessionsPerDay: parsed.data.policy.limits["sessions-per-day"],
        },
      });
    } catch (error) {
      // The domain's own validation (tick bounds, …) — same failure mode as the schema.
      return { problem: (error as Error).message, missing: false };
    }
  }
}
