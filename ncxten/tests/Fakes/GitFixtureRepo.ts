import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunProcessRunner } from "~/Process/BunProcessRunner.ts";
import { Command } from "~/Process/ProcessRunner.ts";

const VALID_C1 = `automations:
  - name: pull-request-reactor
    run: bash scripts/automations/react.sh
  - name: board-walker
    run: bash scripts/automations/implement.sh
    gate: make ci
`;

const INVALID_C2 = `automationz:
  - name: board-walker
    run: bash scripts/automations/implement.sh
`;

const VALID_C3 = `automations:
  - name: pull-request-reactor
    run: bash scripts/automations/react.sh
  - name: board-walker
    run: bash scripts/automations/implement.sh
  - name: gardener
    run: bash scripts/automations/tend.sh
`;

/**
 * The git fixture repo (quickstart): c1 valid → c2 invalid → c3 valid again
 * (healing, FR-013), in a temp dir, zero network. `advanceTo` moves the
 * default branch — what a merge does. `origin/HEAD` is set as every clone
 * sets it: the source resolves the default branch from it (FR-068), and the
 * fixture's `git` is exposed for the switched-HEAD scenario (quickstart 9).
 */
export async function gitFixtureRepo() {
  const runner = new BunProcessRunner();
  const path = await mkdtemp(join(tmpdir(), "ncxten-git-"));
  const git = async (...args: string[]) => {
    const command = Command.of("git", ["-C", path, ...args]);
    return (await runner.run(command)).outputOf(command);
  };

  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "ncxten@test");
  await git("config", "user.name", "ncxten");
  // What `git clone` leaves behind; the source reads the branch it names.
  await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

  const commitFile = async (content: string, message: string) => {
    await writeFile(join(path, "automations.yml"), content);
    await git("add", "automations.yml");
    await git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };

  const c1 = await commitFile(VALID_C1, "c1 valid");
  const c2 = await commitFile(INVALID_C2, "c2 invalid");
  const c3 = await commitFile(VALID_C3, "c3 heals");

  return {
    path,
    git,
    commits: { c1, c2, c3 },
    advanceTo: async (commit: string) => {
      // Moves refs/heads/main like a merge would — wherever HEAD currently is
      // (git refuses `branch -f` on the checked-out branch).
      const head = await git("symbolic-ref", "-q", "HEAD").catch(() => "");
      if (head === "refs/heads/main") await git("reset", "-q", "--hard", commit);
      else await git("branch", "-f", "main", commit);
    },
    remove: () => rm(path, { recursive: true, force: true }),
  };
}
