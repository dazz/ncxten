import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunPass } from "~/Automations/Application/RunPass.ts";
import { RunSession } from "~/Automations/Application/RunSession.ts";
import { RunTick } from "~/Automations/Application/RunTick.ts";
import { freshContext } from "~/Automations/Application/StartProject.ts";
import { Automation } from "~/Automations/Domain/Automation.ts";
import { ConsumedInput } from "~/Automations/Domain/ConsumedInput.ts";
import type { Event } from "~/Automations/Domain/Event.ts";
import { automationName, revision, subjectId } from "~/Automations/Domain/Ids.ts";
import { IsoDuration } from "~/Automations/Domain/IsoDuration.ts";
import type { Hit } from "~/Automations/Domain/Pass.ts";
import { FileTracker } from "~/Automations/Infrastructure/FileTracker.ts";
import { FsRunResult } from "~/Automations/Infrastructure/FsRunResult.ts";
import { GitAutomationsSource } from "~/Automations/Infrastructure/GitAutomationsSource.ts";
import { JsonlEventLog } from "~/Automations/Infrastructure/JsonlEventLog.ts";
import { TimerScheduler } from "~/Automations/Infrastructure/TimerScheduler.ts";
import { BunProcessRunner } from "~/Process/BunProcessRunner.ts";
import { ManualClock, SystemClock } from "~/Shared/Clock.ts";
import { FakeRunResult, FakeScheduler, validPolicy } from "../Composition.ts";
import { FakeProcessRunner } from "../Fakes/FakeProcessRunner.ts";
import { gitFixtureRepo } from "../Fakes/GitFixtureRepo.ts";

const PROJECT = "dazz/foo";
const roots: string[] = [];
const logs: JsonlEventLog[] = [];

afterAll(async () => {
  for (const log of logs) await log.close();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ncxten-session-e2e-"));
  roots.push(root);
  return root;
}

async function replayed(log: JsonlEventLog): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of log.replay()) events.push(event);
  return events;
}

describe("the session end to end — fake runner, real log, file tracker (quickstart 10)", () => {
  test("a findings-file hit drains through the tick; the usage lands in the JSONL line", async () => {
    const fixture = await gitFixtureRepo();
    const root = await stateRoot();
    const eventsPath = join(root, "events", "dazz", "foo.jsonl");
    const log = new JsonlEventLog(eventsPath, PROJECT, () => "github.com");
    logs.push(log);
    const context = freshContext();
    context.policy = validPolicy({ checkout: fixture.path });
    const clock = new ManualClock(new Date("2026-11-03T12:00:00.000Z"));
    const runner = new FakeProcessRunner();
    const runResult = new FakeRunResult();
    runResult.set({
      kind: "reported",
      usage: { model: "claude-haiku-5-5", costUsd: 0.12, turns: 7 },
      detail: "gate green",
    });
    const scheduler = new FakeScheduler();
    await mkdir(join(root, "projects", "dazz", "foo"), { recursive: true });
    const findingsPath = join(root, "projects", "dazz", "foo", "findings.yaml");
    await writeFile(
      findingsPath,
      "findings:\n  - automation: board-walker\n    subject: spike-42\n    revision: r1\n",
    );
    const tracker = new FileTracker(findingsPath);
    const runSession = new RunSession({ runner, runResult, log, clock, scheduler }, context, {
      repository: PROJECT,
      sessionsDir: join(root, "projects", "dazz", "foo", "sessions"),
    });
    const runPass = new RunPass({ tracker, clock }, context, runSession);
    const automationsSource = new GitAutomationsSource(fixture.path, new BunProcessRunner());
    const runTick = new RunTick({ automationsSource, log, clock }, context, runPass);

    await runTick.run("manual");

    const names = (await replayed(log)).map((event) => event.name);
    expect(names).toEqual([
      "AutomationsLoaded",
      "SessionStarted",
      "SessionLaunched",
      "SessionFinished",
      "ProjectIdled",
    ]);
    // Schema v1 on disk: the closing line carries cost, model and detail.
    const lines = (await readFile(eventsPath, "utf8")).trim().split("\n");
    const closing = JSON.parse(lines[3] ?? "{}") as Record<string, unknown>;
    expect(closing.outcome).toBe("succeeded");
    expect(closing.costUsd).toBe(0.12);
    expect(closing.model).toBe("claude-haiku-5-5");
    expect(closing.detail).toBe("gate green");
    // Same revision = consumed = the next tick idles (001 rules unchanged).
    await runTick.run("manual");
    expect((await replayed(log)).at(-1)?.name).toBe("ProjectIdled");
    expect(runner.invocations()).toHaveLength(1);

    await fixture.remove();
  });
});

describe("the session end to end — real tiny commands, real runner (quickstart 10)", () => {
  // Real deadline, short: the kill path must not slow the suite down.
  const limits = {
    turns: 10,
    time: IsoDuration.parse("PT1S", "x"),
    sessionsPerDrain: 5,
    sessionsPerDay: 100,
  };

  async function world(run: string) {
    const root = await stateRoot();
    const checkout = join(root, "checkout");
    await mkdir(checkout, { recursive: true });
    const log = new JsonlEventLog(
      join(root, "events", "dazz", "foo.jsonl"),
      PROJECT,
      () => undefined,
    );
    logs.push(log);
    const context = freshContext();
    context.policy = validPolicy({ checkout });
    const sessionsDir = join(root, "projects", "dazz", "foo", "sessions");
    const runSession = new RunSession(
      {
        runner: new BunProcessRunner(),
        runResult: new FsRunResult(),
        log,
        clock: new SystemClock(),
        scheduler: new TimerScheduler(),
      },
      context,
      { repository: `${PROJECT}-e2e-${process.pid}`, sessionsDir, endGraceMs: 100 },
    );
    const walker = automationName("board-walker");
    const hit: Hit = {
      automation: new Automation(walker, run),
      input: new ConsumedInput(walker, subjectId('spike 42, quoted "subject"'), revision("r1")),
    };
    return { log, sessionsDir, runSession, hit };
  }

  test("exit 0 + a result file the command itself wrote — the shell contract holds", async () => {
    const w = await world(
      'echo "subject: $NCXTEN_SUBJECT"; printf \'{"costUsd":0.01,"detail":"done"}\' > "$NCXTEN_RESULT"',
    );

    await w.runSession.run(w.hit, limits);

    const events = await replayed(w.log);
    expect(events.map((event) => event.name)).toEqual([
      "SessionStarted",
      "SessionLaunched",
      "SessionFinished",
    ]);
    const finished = events.at(-1);
    expect(finished).toMatchObject({
      outcome: "succeeded",
      detail: "done",
      usage: { costUsd: 0.01 },
    });
    // The output file holds the transcript — env arrived through a real shell (FR-061/062).
    const started = events[0];
    const id = started?.name === "SessionStarted" ? String(started.sessionId) : "";
    const transcript = await readFile(join(w.sessionsDir, `${id}.out`), "utf8");
    expect(transcript).toContain('subject: spike 42, quoted "subject"');
  });

  test("a failing command is failed/exit with the code (FR-063)", async () => {
    const w = await world("false");

    await w.runSession.run(w.hit, limits);

    const finished = (await replayed(w.log)).at(-1);
    expect(finished).toMatchObject({ outcome: "failed", cause: "exit", detail: "exit 1" });
  });

  test("a runaway command dies at the time limit — the whole real group (FR-081)", async () => {
    const w = await world("sleep 30 & sleep 30");

    await w.runSession.run(w.hit, limits);

    const events = await replayed(w.log);
    const limited = events.at(-1);
    expect(limited?.name).toBe("SessionLimited");
    expect(limited?.name === "SessionLimited" && limited.dimension).toBe("time");
    // Nothing marked with this session survives (the DoD's grep, FR-066/070).
    const started = events[0];
    const id = started?.name === "SessionStarted" ? String(started.sessionId) : "";
    const probe = Bun.spawnSync([
      "sh",
      "-c",
      `grep -l "NCXTEN_SESSION=${id}" /proc/*/environ 2>/dev/null || true`,
    ]);
    expect(probe.stdout.toString().trim()).toBe("");
  }, 10_000);
});
