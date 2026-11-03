import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutomationsSource } from "~/Automations/Application/AutomationsPorts.ts";
import { Resume } from "~/Automations/Application/Resume.ts";
import { RunPass } from "~/Automations/Application/RunPass.ts";
import { RunSession } from "~/Automations/Application/RunSession.ts";
import { RunTick } from "~/Automations/Application/RunTick.ts";
import { freshContext, StartProject } from "~/Automations/Application/StartProject.ts";
import { Status } from "~/Automations/Application/Status.ts";
import type { Event, TickTrigger } from "~/Automations/Domain/Event.ts";
import { FlockInstanceLock } from "~/Automations/Infrastructure/FlockInstanceLock.ts";
import { GitAutomationsSource } from "~/Automations/Infrastructure/GitAutomationsSource.ts";
import { InMemoryTracker } from "~/Automations/Infrastructure/InMemoryTracker.ts";
import { JsonlEventLog } from "~/Automations/Infrastructure/JsonlEventLog.ts";
import { YamlPolicy } from "~/Automations/Infrastructure/YamlPolicy.ts";
import { BunProcessRunner } from "~/Process/BunProcessRunner.ts";
import { ManualClock } from "~/Shared/Clock.ts";
import { FakeRunResult, FakeScheduler, finding, settle } from "../Composition.ts";
import { FakeProcessRunner } from "../Fakes/FakeProcessRunner.ts";
import { gitFixtureRepo } from "../Fakes/GitFixtureRepo.ts";

/**
 * The 9 acceptance scenarios through the whole hexagon with the real adapters
 * (quickstart): `JsonlEventLog` in a temp dir, the git fixture repo behind
 * `GitAutomationsSource`, a real `YamlPolicy` file, the fake process runner, seeded
 * tracker stub — zero network, zero model cost, directly fired ticks (FR-020).
 * "Restart" = compose again over the same root; "crash" = release the flock,
 * which is what process death does.
 */

const PROJECT = "dazz/foo";

function validYaml(checkout: string, tick = "PT15M"): string {
  return [
    "repo:",
    "  repository: dazz/foo",
    "  paths:",
    `    checkout: ${checkout}`,
    "policy:",
    `  tick: ${tick}`,
    "  limits:",
    "    turns: 50",
    "    time: PT20M",
    "    sessions-per-day: 1000",
    "",
  ].join("\n");
}

/** `limitz` — the unknown key a strict schema must name with its path. */
function invalidYaml(checkout: string): string {
  return validYaml(checkout).replace("  limits:", "  limitz:");
}

let fixture: Awaited<ReturnType<typeof gitFixtureRepo>>;
const roots: string[] = [];
const logs: JsonlEventLog[] = [];
const locks: FlockInstanceLock[] = [];

beforeEach(async () => {
  fixture ??= await gitFixtureRepo();
  await fixture.advanceTo(fixture.commits.c1);
});

afterAll(async () => {
  for (const lock of locks) {
    try {
      lock.release();
    } catch {
      // never acquired — nothing to release
    }
  }
  for (const log of logs) await log.close();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  await fixture?.remove();
});

interface WorldOptions {
  readonly policy?: string;
  /** Compose again over an existing root — the restart (quickstart). */
  readonly root?: string;
}

/** The production wiring of `main.ts`, the run commands scripted and clock manual. */
async function world(options: WorldOptions = {}) {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), "ncxten-e2e-")));
  const policyPath = join(root, "config", "dazz", "foo.yaml");
  if (options.root === undefined) {
    roots.push(root);
    await mkdir(join(root, "config", "dazz"), { recursive: true });
    await writeFile(policyPath, options.policy ?? validYaml(fixture.path));
  }

  const context = freshContext();
  const clock = new ManualClock(new Date("2026-10-31T12:00:00.000Z"));
  const eventsPath = join(root, "state", "events", "dazz", "foo.jsonl");
  const log = new JsonlEventLog(eventsPath, PROJECT, () => context.policy?.forge);
  const policySource = new YamlPolicy(policyPath);
  const lock = new FlockInstanceLock(join(root, "state", "projects", "dazz", "foo", "ncxten.pid"));
  const gitRunner = new BunProcessRunner();
  const automationsSource: AutomationsSource = {
    read: () => {
      const checkout = context.policy?.checkout;
      if (checkout === undefined) throw new Error("no policy in effect");
      return new GitAutomationsSource(checkout, gitRunner).read();
    },
  };
  // The run commands and the reaper stay fake here (quickstart: fake runner);
  // the real-runner leg with tiny real commands lives in session.test.ts.
  const runner = new FakeProcessRunner();
  const runResult = new FakeRunResult();
  const scheduler = new FakeScheduler();
  const tracker = new InMemoryTracker();
  const runSession = new RunSession({ runner, runResult, log, clock, scheduler }, context, {
    repository: PROJECT,
    sessionsDir: join(root, "state", "projects", "dazz", "foo", "sessions"),
  });
  const runPass = new RunPass({ tracker, clock }, context, runSession);
  const runTick = new RunTick({ automationsSource, log, clock }, context, runPass);
  const startProject = new StartProject(
    { lock, log, policySource, clock, runner },
    context,
    PROJECT,
  );
  const resumeProject = new Resume({ policySource, log, clock }, context);
  const statusQuery = new Status({ log, lock, policySource });
  logs.push(log);
  locks.push(lock);

  return {
    root,
    policyPath,
    eventsPath,
    runner,
    runResult,
    scheduler,
    tracker,
    lock,
    log,
    start: () => startProject.run(),
    tick: (trigger: TickTrigger = "schedule") => runTick.run(trigger),
    resume: () => resumeProject.run(),
    status: () => statusQuery.run(),
  };
}

/** Replayed through the real adapter — what a restart would see. */
async function replayed(log: JsonlEventLog): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of log.replay()) events.push(event);
  return events;
}

async function names(log: JsonlEventLog): Promise<string[]> {
  return (await replayed(log)).map((event) => event.name);
}

/** The real git source needs real time — poll the log instead of guessing. */
async function untilAppended(log: JsonlEventLog, name: string): Promise<void> {
  const attempts = 200;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if ((await names(log)).includes(name)) return;
    await settle();
  }
  throw new Error(`event ${name} never appended`);
}

describe("the factory heartbeat, end to end", () => {
  test("scenario 1 — an idle tick: no findings, no session, no command started", async () => {
    const w = await world();
    await w.start();

    await w.tick();

    expect(await names(w.log)).toEqual([
      "ProjectStarted",
      "PolicyLoaded",
      "AutomationsLoaded",
      "ProjectIdled",
    ]);
    expect(w.runner.invocations()).toEqual([]);
  });

  test("scenario 2 — one finding, one session; the limits arrive in the environment; schema v1 on disk", async () => {
    const w = await world();
    w.tracker.present("board-walker", finding("ticket-42", "r1"));
    await w.start();

    await w.tick();

    expect(await names(w.log)).toEqual([
      "ProjectStarted",
      "PolicyLoaded",
      "AutomationsLoaded",
      "SessionStarted",
      "SessionLaunched",
      "SessionFinished",
      "ProjectIdled",
    ]);
    const invocation = w.runner.invocations()[0];
    expect(invocation?.environment.NCXTEN_TURNS).toBe("50");
    expect(invocation?.environment.NCXTEN_TIME_LIMIT).toBe("PT20M");
    expect(invocation?.cwd).toBe(fixture.path);

    const lines = (await readFile(w.eventsPath, "utf8")).trim().split("\n");
    const started = JSON.parse(lines[3] ?? "{}") as Record<string, unknown>;
    expect(started["schema"]).toBe(1);
    expect(started["kind"]).toBe("session");
    expect(started["outcome"]).toBe("started");
    expect(started["repository"]).toBe("dazz/foo");
    expect(started["forge"]).toBe("github.com");
    expect(started["automation"]).toBe("board-walker");
    expect(started["issue"]).toBe("ticket-42");
  });

  test("scenario 3 — automations turn invalid: the last valid commit stays in effect", async () => {
    const w = await world();
    await w.start();
    await w.tick(); // c1 loaded

    await fixture.advanceTo(fixture.commits.c2);
    w.tracker.present("board-walker", finding("ticket-42", "r1"));
    await w.tick();

    const events = await replayed(w.log);
    const invalid = events.find((event) => event.name === "AutomationsInvalid");
    expect(invalid?.name === "AutomationsInvalid" && String(invalid.keptCommit)).toBe(
      fixture.commits.c1,
    );
    // the c1 automations still ran, and the tick ended normally
    expect(events.map((event) => event.name).slice(-4)).toEqual([
      "SessionStarted",
      "SessionLaunched",
      "SessionFinished",
      "ProjectIdled",
    ]);
  });

  test("scenario 4 — an invalid policy pauses; a tick checks no input", async () => {
    const w = await world({ policy: invalidYaml(fixture.path) });
    await w.start();

    const report = await w.status();
    expect(report.kind).toBe("report");
    if (report.kind !== "report") return;
    expect(report.state).toBe("paused");
    expect(report.pauseReason).toContain("limitz");

    await w.tick();
    const events = await replayed(w.log);
    const last = events.at(-1);
    expect(last?.name === "TickSkipped" && last.reason).toBe("paused");
    expect(w.runner.invocations()).toEqual([]);
  });

  test("scenario 5 — no parallel session; a crash orphans it, the next start aborts and consumes it", async () => {
    const w = await world();
    w.runner.scriptGroup("board-walker", { kind: "hang" });
    w.tracker.present("board-walker", finding("ticket-42", "r1"));
    await w.start();
    void w.tick(); // hangs in the session
    await untilAppended(w.log, "SessionStarted");

    await w.tick("manual"); // while the session is open
    let events = await replayed(w.log);
    const skipped = events.at(-1);
    expect(skipped?.name === "TickSkipped" && skipped.reason).toBe("running");
    expect(events.filter((event) => event.name === "SessionStarted")).toHaveLength(1);

    w.lock.release(); // the crash — the kernel drops the flock with the process
    const restarted = await world({ root: w.root });
    await restarted.start();

    events = await replayed(restarted.log);
    expect(events.map((event) => event.name).slice(-3)).toEqual([
      "ProjectStarted",
      "SessionAborted",
      "PolicyLoaded",
    ]);
    const aborted = events.find((event) => event.name === "SessionAborted");
    expect(aborted?.name === "SessionAborted" && String(aborted.subject)).toBe("ticket-42");
    const lines = (await readFile(restarted.eventsPath, "utf8")).trim().split("\n");
    const abortedLine = lines.find((line) => line.includes('"outcome":"aborted"'));
    expect(abortedLine).toContain('"detail":"orphaned"');

    // the input is consumed: the same finding starts no second session
    restarted.tracker.present("board-walker", finding("ticket-42", "r1"));
    await restarted.tick();
    expect((await names(restarted.log)).at(-1)).toBe("ProjectIdled");
    expect(restarted.runner.invocations()).toEqual([]);
    // The start-up reap ran, scoped to the own project's mark (FR-070).
    expect(restarted.runner.markEnds.map((end) => end.mark)).toEqual([PROJECT]);
  });

  test("scenario 6 — resume re-validates: failed while the cause persists, resumed after the fix", async () => {
    const w = await world({ policy: invalidYaml(fixture.path) });
    await w.start();
    await w.tick();
    expect((await names(w.log)).at(-1)).toBe("TickSkipped");

    expect((await w.resume()).kind).toBe("failed"); // the cause persists

    await writeFile(w.policyPath, validYaml(fixture.path));
    expect((await w.resume()).kind).toBe("resumed");

    expect((await names(w.log)).slice(-3)).toEqual([
      "ResumeFailed",
      "PolicyLoaded",
      "ProjectResumed",
    ]);
    const report = await w.status();
    expect(report.kind === "report" && report.state).toBe("idle");
  });

  test("a resume when not paused is ignored without a policy re-read (FR-051)", async () => {
    const w = await world();
    await w.start();

    expect((await w.resume()).kind).toBe("ignored");
    expect((await names(w.log)).at(-1)).toBe("ResumeIgnored");
  });

  test("scenario 7 — a pause survives the restart: replay rebuilds it from the log", async () => {
    const w = await world({ policy: invalidYaml(fixture.path) });
    await w.start();
    w.lock.release(); // the paused process stopped

    const second = await world({ root: w.root });
    await second.start();

    const report = await second.status();
    expect(report.kind === "report" && report.state).toBe("paused");

    await second.tick();
    const events = await replayed(second.log);
    const last = events.at(-1);
    expect(last?.name === "TickSkipped" && last.reason).toBe("paused");
    expect(events.some((event) => event.name === "AutomationsLoaded")).toBe(false);
  });

  test("scenario 8 — two findings drain sequentially in list order", async () => {
    const w = await world();
    w.tracker.present("board-walker", finding("ticket-42", "r1"));
    w.tracker.present("pull-request-reactor", finding("pr-7", "r2"));
    await w.start();

    await w.tick();

    expect(
      w.runner.invocations().map((invocation) => invocation.environment.NCXTEN_AUTOMATION),
    ).toEqual(["pull-request-reactor", "board-walker"]);
    expect((await names(w.log)).slice(-7)).toEqual([
      "SessionStarted",
      "SessionLaunched",
      "SessionFinished",
      "SessionStarted",
      "SessionLaunched",
      "SessionFinished",
      "ProjectIdled",
    ]);
  });

  test("scenario 9 — a failed session consumes its input: no retry loop (FR-035)", async () => {
    const w = await world();
    w.runner.scriptGroup("board-walker", { kind: "exit", code: 2 });
    w.tracker.present("board-walker", finding("ticket-42", "r1"));
    await w.start();

    await w.tick();
    await w.tick(); // the finding is still presented

    const events = await replayed(w.log);
    const finished = events.find((event) => event.name === "SessionFinished");
    expect(finished?.name === "SessionFinished" && finished.outcome).toBe("failed");
    expect(finished?.name === "SessionFinished" && finished.cause).toBe("exit");
    expect(w.runner.invocations()).toHaveLength(1);
    expect(events.map((event) => event.name).slice(-2)).toEqual(["ProjectIdled", "ProjectIdled"]);
  });

  test("never-valid automations report per tick and heal on a valid commit (FR-013)", async () => {
    await fixture.advanceTo(fixture.commits.c2); // invalid from the first load on
    const w = await world();
    await w.start();

    await w.tick();
    expect((await names(w.log)).slice(-2)).toEqual(["AutomationsNeverValid", "ProjectIdled"]);

    await fixture.advanceTo(fixture.commits.c3);
    await w.tick();
    const events = await replayed(w.log);
    const healed = events.findLast((event) => event.name === "AutomationsLoaded");
    expect(healed?.name === "AutomationsLoaded" && String(healed.commit)).toBe(fixture.commits.c3);
    expect(events.at(-1)?.name).toBe("ProjectIdled");
  });
});
