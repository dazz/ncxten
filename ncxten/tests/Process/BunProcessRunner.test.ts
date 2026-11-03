import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunProcessRunner } from "~/Process/BunProcessRunner.ts";
import { Command } from "~/Process/ProcessRunner.ts";

const runner = new BunProcessRunner();

describe("BunProcessRunner", () => {
  test("runs a real program and captures code and stdout", async () => {
    const result = await runner.run(Command.of("echo", ["hello"]));

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello\n");
  });

  test("a non-zero exit is a result, not an exception", async () => {
    const result = await runner.run(Command.of("false"));

    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
  });

  test("the extra environment reaches the child", async () => {
    const result = await runner.run(
      Command.of("printenv", ["FACTORY_PROBE"], { FACTORY_PROBE: "it-works" }),
    );

    expect(result.stdout.trim()).toBe("it-works");
  });

  test("a missing program names itself", async () => {
    expect(runner.run(Command.of("definitely-not-installed-xyz"))).rejects.toThrow(
      "definitely-not-installed-xyz is not installed or not on PATH",
    );
  });
});

/** Real child processes — the spike patterns (STACK Process model), still zero network. */
describe("marked process groups (002)", () => {
  // Distinct marks per test run: parallel test files must not reap each other.
  const project = `dazz/group-test-${process.pid}`;
  let sessions = 0;
  let tempDirs: string[] = [];
  const GRACE_MS = 150;

  async function outDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ncxten-group-"));
    tempDirs.push(dir);
    return dir;
  }

  function invocation(run: string, session: string, outputPath: string) {
    return {
      run,
      cwd: tmpdir(),
      environment: { NCXTEN_PROJECT: project, NCXTEN_SESSION: session, NCXTEN_AUTOMATION: "t" },
      outputPath,
    };
  }

  async function startGroup(run: string) {
    sessions += 1;
    const session = `s${process.pid}-${sessions}`;
    const outputPath = join(await outDir(), `${session}.out`);
    const started = await runner.startGroup(invocation(run, session, outputPath));
    if (started.kind !== "started") throw new Error(`spawn failed: ${JSON.stringify(started)}`);
    return { ...started, session, outputPath };
  }

  async function markedPids(session: string): Promise<number[]> {
    const probe = Bun.spawnSync([
      "sh",
      "-c",
      `grep -l "NCXTEN_SESSION=${session}" /proc/*/environ 2>/dev/null || true`,
    ]);
    return probe.stdout
      .toString()
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => Number(line.split("/")[2]));
  }

  afterEach(async () => {
    await runner.endMarked(project, GRACE_MS);
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
    tempDirs = [];
  });

  test("exit 0 and non-zero arrive as the exit code; output is teed to the file", async () => {
    const ok = await startGroup("echo out; echo err >&2; exit 0");
    const bad = await startGroup("exit 2");

    expect((await ok.exited).code).toBe(0);
    expect((await bad.exited).code).toBe(2);
    const transcript = await readFile(ok.outputPath, "utf8");
    expect(transcript).toContain("out");
    expect(transcript).toContain("err");
  });

  test("the unit is the group id plus the leader's start time, known before the exit", async () => {
    const started = await startGroup("sleep 30");

    expect(started.unit.group).toBeGreaterThan(0);
    expect(started.unit.startedAt).toBeGreaterThan(0);

    await runner.endGroup(started.unit, GRACE_MS);
    expect((await started.exited).code).not.toBe(0);
  });

  test("endGroup ends the whole group — the grandchild dies with it (FR-081)", async () => {
    const started = await startGroup("sh -c 'sleep 30' & sleep 30");
    expect((await markedPids(started.session)).length).toBeGreaterThanOrEqual(2);

    await runner.endGroup(started.unit, GRACE_MS);

    expect(await markedPids(started.session)).toEqual([]);
  });

  test("a TERM-trapping child needs KILL — also when the leader already exited", async () => {
    // The leader spawns a TERM-ignoring child into the group and exits 0.
    const started = await startGroup(`sh -c 'trap "" TERM; sleep 30' & exit 0`);
    expect((await started.exited).code).toBe(0);
    expect((await markedPids(started.session)).length).toBeGreaterThanOrEqual(1);

    await runner.endGroup(started.unit, GRACE_MS);

    // The direct signal verified a dead leader; the mark re-scan caught the child.
    expect(await markedPids(started.session)).toEqual([]);
  });

  test("a stale identity gets no signal (FR-066) — pids are recycled", async () => {
    const started = await startGroup("sleep 30");

    await runner.endGroup({ group: started.unit.group, startedAt: 1 }, GRACE_MS);

    // Wrong start time: the direct kill was refused — but the session mark
    // re-scan still ended the marked processes (the honest contract: endGroup
    // ends THIS session; the stale id is never signaled blind).
    expect(await markedPids(started.session)).toEqual([]);
  });

  test("endGroup refuses the factory's own group", async () => {
    const ownStat = await readFile(`/proc/${process.pid}/stat`, "utf8");
    const ownGroup = Number(
      ownStat
        .slice(ownStat.lastIndexOf(")") + 1)
        .trim()
        .split(" ")[2],
    );

    expect(runner.endGroup({ group: ownGroup, startedAt: 0 }, GRACE_MS)).rejects.toThrow(
      "own process group",
    );
  });

  test("endMarked reaps every group of the project and only those (FR-070, scenario 9)", async () => {
    const sibling = new BunProcessRunner();
    const own = await startGroup("sleep 30");
    // A sibling project's session on the same host.
    const siblingOut = join(await outDir(), "sibling.out");
    const siblingStarted = await sibling.startGroup({
      run: "sleep 30",
      cwd: tmpdir(),
      environment: {
        NCXTEN_PROJECT: `${project}-sibling`,
        NCXTEN_SESSION: `sib-${process.pid}`,
        NCXTEN_AUTOMATION: "t",
      },
      outputPath: siblingOut,
    });
    if (siblingStarted.kind !== "started") throw new Error("sibling spawn failed");

    await runner.endMarked(project, GRACE_MS);

    expect(await markedPids(own.session)).toEqual([]);
    // The sibling's mark was not touched.
    expect((await markedPids(`sib-${process.pid}`)).length).toBeGreaterThanOrEqual(1);
    await sibling.endMarked(`${project}-sibling`, GRACE_MS);
  });

  test("the output file holds both streams after a kill (FR-062)", async () => {
    const started = await startGroup("echo before; echo also-err >&2; sleep 30; echo never");

    // Give the tee a moment to flush the first chunks.
    await Bun.sleep(200);
    await runner.endGroup(started.unit, GRACE_MS);
    await started.exited;

    const transcript = await readFile(started.outputPath, "utf8");
    expect(transcript).toContain("before");
    expect(transcript).toContain("also-err");
    expect(transcript).not.toContain("never");
  });

  test("a spawn failure is a value, not a crash (FR-064)", async () => {
    const started = await runner.startGroup({
      run: "true",
      cwd: "/definitely/not/a/directory",
      environment: { NCXTEN_PROJECT: project, NCXTEN_SESSION: "sx", NCXTEN_AUTOMATION: "t" },
      outputPath: join(await outDir(), "sx.out"),
    });

    expect(started.kind).toBe("spawn-failure");
  });
});
