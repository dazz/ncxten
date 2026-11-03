import { z } from "zod";
import type {
  AutomationsReading,
  AutomationsSource,
} from "~/Automations/Application/AutomationsPorts.ts";
import { Automation } from "~/Automations/Domain/Automation.ts";
import { Automations } from "~/Automations/Domain/Automations.ts";
import { automationName, commitId } from "~/Automations/Domain/Ids.ts";
import { Command, type ProcessRunner } from "~/Process/ProcessRunner.ts";

/**
 * The strict schema of `automations.yml` (contracts/automations.md): an
 * unknown key makes the file invalid, because "the repo proposes" must not
 * smuggle undeclared behavior past the schema.
 */
const SCHEMA = z.strictObject({
  automations: z
    .array(
      z.strictObject({
        name: z.string(),
        run: z.string(),
        gate: z.string().optional(),
      }),
    )
    .min(1, "at least one automation is required"),
});

/**
 * Reads `automations.yml` + commit from the **default-branch ref** of a
 * local repo — via the ProcessRunner (`git symbolic-ref`, `git rev-parse`,
 * `git show`), zero network. Never HEAD or the working tree (FR-068): since
 * 002 a session runs *in* the checkout and can switch branches or leave it
 * dirty — `refs/heads/<default>` moves only on merge (FR-010). A session can
 * also move local refs; reading from the **remote's** default branch is 003.
 * Returns parsed `Automations` or a problem, each with its commit.
 */
export class GitAutomationsSource implements AutomationsSource {
  constructor(
    private readonly checkout: string,
    private readonly runner: ProcessRunner,
  ) {}

  async read(): Promise<AutomationsReading> {
    const git = (...args: string[]) => Command.of("git", ["-C", this.checkout, ...args]);
    // A checkout that is no repo, or one whose origin/HEAD was never set
    // (every clone sets it), is a broken installation, not an invalid file:
    // outputOf throws and the error surfaces as exit 1.
    const originHead = git("symbolic-ref", "refs/remotes/origin/HEAD");
    const target = (await this.runner.run(originHead)).outputOf(originHead);
    const branch = target.split("/").at(-1) ?? "";
    const ref = `refs/heads/${branch}`;

    const revParse = git("rev-parse", ref);
    const commit = commitId((await this.runner.run(revParse)).outputOf(revParse));

    const shown = await this.runner.run(git("show", `${ref}:automations.yml`));
    if (!shown.ok) {
      return { problem: `automations.yml: ${shown.stderr.trim() || "not in the repo"}`, commit };
    }

    let data: unknown;
    try {
      data = Bun.YAML.parse(shown.stdout);
    } catch (error) {
      return { problem: `automations.yml is not YAML: ${(error as Error).message}`, commit };
    }

    const parsed = SCHEMA.safeParse(data);
    if (!parsed.success) {
      // Prefer the unknown-key issue — the typo's own path, not what it shadows.
      const issue =
        parsed.error.issues.find((candidate) => candidate.code === "unrecognized_keys") ??
        parsed.error.issues[0];
      const path = issue?.path.join(".") || "automations.yml";
      return { problem: `${path}: ${issue?.message ?? "invalid"}`, commit };
    }

    try {
      return {
        automations: Automations.of(
          parsed.data.automations.map(
            (entry) => new Automation(automationName(entry.name), entry.run, entry.gate),
          ),
          commit,
        ),
      };
    } catch (error) {
      // The domain's own validation: kebab-case names, uniqueness, non-empty refs.
      return { problem: (error as Error).message, commit };
    }
  }
}
