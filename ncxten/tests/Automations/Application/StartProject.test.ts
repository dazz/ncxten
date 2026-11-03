import { describe, expect, test } from "bun:test";
import type { Event } from "~/Automations/Domain/Event.ts";
import { automationName, revision, sessionId, subjectId } from "~/Automations/Domain/Ids.ts";
import { InMemoryEventLog } from "~/Automations/Infrastructure/InMemoryEventLog.ts";
import {
  composeTestProject,
  finding,
  invalidPolicy,
  missingPolicy,
  settle,
} from "../../Composition.ts";
import { FakeProcessRunner } from "../../Fakes/FakeProcessRunner.ts";

describe("the start sequence", () => {
  test("valid policy: lock → replay → ProjectStarted → PolicyLoaded, in that order", async () => {
    const { start, log, lock, context } = composeTestProject();

    const result = await start();

    expect(result).toEqual({ kind: "started" });
    expect(log.names()).toEqual(["ProjectStarted", "PolicyLoaded"]);
    expect(lock.isHeld()).toBe(true);
    expect(context.policy?.tick.text).toBe("PT15M");
    expect(context.project.state()).toBe("idle");
  });

  test("scenario 4 — invalid policy pauses with the failing path as reason", async () => {
    const { start, tick, log, context } = composeTestProject({ policy: invalidPolicy() });

    await start();

    expect(log.names()).toEqual(["ProjectStarted", "ProjectPaused"]);
    expect(context.project.state()).toBe("paused");
    expect(context.project.pauseReason()).toContain("policy.limitz");

    // No session possible: a due tick is skipped without any input check.
    await tick();
    expect(log.names().at(-1)).toBe("TickSkipped");
  });

  test("scenario 7 — a pause survives the restart because it is replayed (FR-051)", async () => {
    const first = composeTestProject({ policy: invalidPolicy() });
    await first.start();

    const second = composeTestProject({ policy: invalidPolicy(), log: first.log });
    await second.start();

    expect(second.context.project.state()).toBe("paused");

    await second.tick();
    const events = second.log.appended();
    const last = events.at(-1);
    expect(last?.name).toBe("TickSkipped");
    expect(last?.name === "TickSkipped" && last.reason).toBe("paused");
  });

  test("crash during a session: the next generation aborts the orphan, input stays consumed", async () => {
    const first = composeTestProject();
    first.runner.scriptGroup("board-walker", { kind: "hang" });
    first.tracker.present("board-walker", finding("ticket-42", "r1"));
    first.tick(); // never settles — the "crash"
    await settle();
    expect(first.log.names().at(-1)).toBe("SessionLaunched");

    const second = composeTestProject({ log: first.log });
    await second.start();

    const names = second.log.names();
    const startIndex = names.lastIndexOf("ProjectStarted");
    expect(names.slice(startIndex)).toEqual(["ProjectStarted", "SessionAborted", "PolicyLoaded"]);
    expect(second.context.project.openSession()).toBeUndefined();
    expect(second.context.project.lastSession()?.outcome).toBe("aborted");
    expect(
      second.context.project.consumedRevision(
        automationName("board-walker"),
        subjectId("ticket-42"),
      ),
    ).toBe(revision("r1"));
  });

  test("unknown project: no policy file and no log — refused without creating ghost state", async () => {
    const { start, log } = composeTestProject({ policy: missingPolicy() });

    const result = await start();

    expect(result).toEqual({ kind: "unknown-project" });
    expect(log.appended()).toEqual([]);
  });

  test("a missing policy with an existing log pauses — the project is known", async () => {
    const first = composeTestProject();
    await first.start();

    const second = composeTestProject({ policy: missingPolicy(), log: first.log });
    const result = await second.start();

    expect(result).toEqual({ kind: "started" });
    expect(second.context.project.state()).toBe("paused");
  });

  test("a held lock refuses the start (exit 75 at the UI)", async () => {
    const project = composeTestProject();
    await project.lock.acquire();

    expect(await project.start()).toEqual({ kind: "lock-held" });
    expect(project.log.appended()).toEqual([]);
  });
});

describe("the start-up reap (FR-070)", () => {
  const at = new Date("2026-10-31T12:00:00.000Z");

  function startedEvent(session = "s1"): Event {
    return {
      name: "SessionStarted",
      at,
      automation: automationName("board-walker"),
      subject: subjectId("ticket-42"),
      revision: revision("r1"),
      sessionId: sessionId(session),
    };
  }

  test("scenario 8 — record first, then every own-project mark ends (crash mid-session)", async () => {
    const runner = new FakeProcessRunner();
    const first = composeTestProject({ runner });
    runner.scriptGroup("board-walker", { kind: "hang" });
    first.tracker.present("board-walker", finding("ticket-42", "r1"));
    first.tick(); // the "crash": the generation dies with the session open
    await settle();
    expect(runner.running()).toHaveLength(1);

    const second = composeTestProject({ log: first.log, runner });
    await second.start();

    // The abort record precedes the reap (FR-043); the reap is mark-scoped.
    const names = second.log.names();
    expect(names.slice(names.lastIndexOf("ProjectStarted"))).toEqual([
      "ProjectStarted",
      "SessionAborted",
      "PolicyLoaded",
    ]);
    expect(runner.markEnds.map((end) => end.mark)).toEqual(["dazz/foo"]);
    expect(runner.running()).toEqual([]);
  });

  test("scenario 8b/9 — a sibling project's mark is never signaled", async () => {
    const runner = new FakeProcessRunner();
    runner.plant("dazz/other", "sibling-session");
    const project = composeTestProject({ runner });

    await project.start();

    expect(runner.markEnds.map((end) => end.mark)).toEqual(["dazz/foo"]);
    expect(runner.survivors()).toEqual([
      { project: "dazz/other", session: "sibling-session", group: 9000 },
    ]);
  });

  test("scenario 8c — a crash before the launch record: the scan is log-independent", async () => {
    const log = new InMemoryEventLog();
    await log.append(startedEvent()); // no SessionLaunched — crash between start and launch
    const project = composeTestProject({ log });

    await project.start();

    const names = project.log.names();
    expect(names.slice(1)).toEqual(["ProjectStarted", "SessionAborted", "PolicyLoaded"]);
    // No unit was ever recorded — the mark scan still ran (FR-070).
    expect(project.runner.markEnds.map((end) => end.mark)).toEqual(["dazz/foo"]);
  });

  test("scenario 8d — a second crash during cleanup: no open session, the scan still reaps", async () => {
    const log = new InMemoryEventLog();
    await log.append(startedEvent());
    await log.append({
      name: "SessionAborted",
      at,
      automation: automationName("board-walker"),
      subject: subjectId("ticket-42"),
      sessionId: sessionId("s1"),
    });
    const project = composeTestProject({ log });

    await project.start();

    // No new abort record — the replay shows no open session (idempotent)…
    const names = project.log.names();
    expect(names.filter((name) => name === "SessionAborted")).toHaveLength(1);
    // …but the reap runs regardless: cleanup is repeatable until confirmed dead.
    expect(project.runner.markEnds.map((end) => end.mark)).toEqual(["dazz/foo"]);
  });
});
