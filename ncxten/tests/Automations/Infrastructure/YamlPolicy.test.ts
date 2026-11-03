import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Policy } from "~/Automations/Domain/Policy.ts";
import { YamlPolicy } from "~/Automations/Infrastructure/YamlPolicy.ts";

const MINIMAL = `repo:
  repository: dazz/foo
  paths:
    checkout: /home/dazz/checkouts/foo
policy:
  limits:
    turns: 50
    time: PT20M
    sessions-per-day: 20
`;

const COMPLETE = `repo:
  repository: dazz/foo
  forge: github
  tracker: github-issues
  paths:
    checkout: /home/dazz/checkouts/foo
policy:
  tick: PT10M
  harness: claude
  models:
    cheap: claude-haiku
    default: claude-sonnet
    strong: claude-opus
  session-model: per-step
  workspace: worktree
  gate-source: local
  limits:
    turns: 50
    time: PT20M
    tokens: 1000000
    same-error-class: 3
    sessions-per-day: 20
    rounds-per-pr: 4
  merge-policy: approved-is-approved
  sensitive-paths:
    - automations.yml
  trusted-authors: []
  credentials: dazz/foo
`;

let tempDirs: string[] = [];

async function policyFile(content: string | undefined): Promise<YamlPolicy> {
  const dir = await mkdtemp(join(tmpdir(), "ncxten-policy-"));
  tempDirs.push(dir);
  const path = join(dir, "dazz/foo.yaml");
  if (content !== undefined) {
    await mkdir(join(dir, "dazz"), { recursive: true });
    await writeFile(path, content);
  }
  return new YamlPolicy(path);
}

afterEach(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("YamlPolicy", () => {
  test("a minimal policy parses with the schema defaults", async () => {
    const reading = await policyFile(MINIMAL).then((source) => source.read());

    expect(reading).toBeInstanceOf(Policy);
    if (!(reading instanceof Policy)) return;
    expect(reading.repository).toBe("dazz/foo");
    expect(reading.forge).toBe("github.com");
    expect(reading.tick.text).toBe("PT15M");
    expect(reading.limits.turns).toBe(50);
    expect(reading.limits.time.text).toBe("PT20M");
  });

  test("a complete Zielbild policy passes unchanged — declared fields are valid (FR-003)", async () => {
    const reading = await policyFile(COMPLETE).then((source) => source.read());

    expect(reading).toBeInstanceOf(Policy);
    if (!(reading instanceof Policy)) return;
    expect(reading.tick.text).toBe("PT10M");
  });

  test("an unknown key fails with its path — a typo must not remove a limit", async () => {
    const broken = MINIMAL.replace("  limits:", "  limitz:");
    const reading = await policyFile(broken).then((source) => source.read());

    expect(reading).not.toBeInstanceOf(Policy);
    if (reading instanceof Policy) return;
    expect(reading.problem).toContain("policy");
    expect(reading.problem).toContain("limitz");
    expect(reading.missing).toBe(false);
  });

  test("the tick bounds catch the classic typos through the same path", async () => {
    const seconds = await policyFile(MINIMAL.replace("policy:", "policy:\n  tick: PT15S"));
    const months = await policyFile(MINIMAL.replace("policy:", "policy:\n  tick: P15M"));

    const tooFast = await seconds.read();
    const tooSlow = await months.read();
    expect(!(tooFast instanceof Policy) && tooFast.problem).toContain("below the minimum PT1M");
    expect(!(tooSlow instanceof Policy) && tooSlow.problem).toContain("above the maximum PT24H");
  });

  test("a wrong type names the failing path", async () => {
    const broken = MINIMAL.replace("turns: 50", 'turns: "fifty"');
    const reading = await policyFile(broken).then((source) => source.read());

    expect(!(reading instanceof Policy) && reading.problem).toContain("policy.limits.turns");
  });

  test("a missing file is `missing` — the unknown-project guard needs the difference", async () => {
    const reading = await policyFile(undefined).then((source) => source.read());

    expect(!(reading instanceof Policy) && reading.missing).toBe(true);
  });

  test("a file that is not YAML is a problem, not a crash", async () => {
    const reading = await policyFile("\t{ not: yaml: [").then((source) => source.read());

    expect(reading).not.toBeInstanceOf(Policy);
    if (reading instanceof Policy) return;
    expect(reading.missing).toBe(false);
  });
});

describe("the 002 schema delta", () => {
  test("sessions-per-day is required — always, with its path (FR-083)", async () => {
    const broken = MINIMAL.replace("    sessions-per-day: 20\n", "");
    const reading = await policyFile(broken).then((source) => source.read());

    expect(reading).not.toBeInstanceOf(Policy);
    if (reading instanceof Policy) return;
    expect(reading.problem).toContain("policy.limits.sessions-per-day");
  });

  test("sessions-per-drain has the named schema default", async () => {
    const reading = await policyFile(MINIMAL).then((source) => source.read());

    expect(reading).toBeInstanceOf(Policy);
    if (!(reading instanceof Policy)) return;
    expect(reading.limits.sessionsPerDrain).toBe(5);
    expect(reading.limits.sessionsPerDay).toBe(20);
  });

  test("tracker file is a valid adapter choice — the DoD seed source until 003", async () => {
    const withFile = MINIMAL.replace("repo:", "repo:\n  tracker: file");
    const reading = await policyFile(withFile).then((source) => source.read());

    expect(reading).toBeInstanceOf(Policy);
    if (!(reading instanceof Policy)) return;
    expect(reading.tracker).toBe("file");
  });
});
