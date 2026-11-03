import { describe, expect, test } from "bun:test";
import { automationName, subjectId } from "~/Automations/Domain/Ids.ts";
import { IsoDuration } from "~/Automations/Domain/IsoDuration.ts";
import { InMemoryEventLog } from "~/Automations/Infrastructure/InMemoryEventLog.ts";
import { ManualClock } from "~/Shared/Clock.ts";
import {
  composeTestProject,
  finding,
  invalidAutomations,
  invalidPolicy,
  neverValid,
  settle,
  validAutomations,
  validPolicy,
} from "../../Composition.ts";

describe("the tick", () => {
  test("scenario 1 — idle tick: no findings, no session, no command started", async () => {
    const { tick, log, runner } = composeTestProject();

    await tick();

    expect(log.names()).toEqual(["AutomationsLoaded", "ProjectIdled"]);
    expect(runner.invocations()).toEqual([]);
  });

  test("scenario 2 — one input, one session, the limits arrive in the environment", async () => {
    const { tick, log, runner, tracker } = composeTestProject();
    tracker.present("board-walker", finding("ticket-42", "r1"));

    await tick();

    expect(log.names()).toEqual([
      "AutomationsLoaded",
      "SessionStarted",
      "SessionLaunched",
      "SessionFinished",
      "ProjectIdled",
    ]);
    const started = log.appended()[1];
    expect(started?.name === "SessionStarted" && started.automation).toBe(
      automationName("board-walker"),
    );
    expect(started?.name === "SessionStarted" && String(started.subject)).toBe("ticket-42");
    expect(started?.name === "SessionStarted" && String(started.revision)).toBe("r1");
    // The limits travel as environment, a hint and an enforced bound (FR-061/080/081).
    expect(runner.invocations()[0]?.environment.NCXTEN_TURNS).toBe("50");
    expect(runner.invocations()[0]?.environment.NCXTEN_TIME_LIMIT).toBe("PT20M");
  });

  test("scenario 3 — an invalid turn keeps the last valid version in effect", async () => {
    const { tick, log, tracker, automationsSource } = composeTestProject({
      automations: validAutomations("c1"),
    });
    await tick(); // loads c1

    automationsSource.advanceTo(invalidAutomations("c2"));
    tracker.present("board-walker", finding("ticket-42", "r1"));
    await tick();

    const names = log.names();
    expect(names).toContain("AutomationsInvalid");
    const invalid = log.appended().find((event) => event.name === "AutomationsInvalid");
    expect(invalid?.name === "AutomationsInvalid" && String(invalid.keptCommit)).toBe("c1");
    // the automations of c1 still run, and ticking continues
    expect(names.filter((name) => name === "SessionStarted")).toHaveLength(1);
    expect(names.at(-1)).toBe("ProjectIdled");
  });

  test("scenario 5 — no parallel session: a tick during a drain is skipped", async () => {
    const { tick, log, runner, tracker } = composeTestProject();
    runner.scriptGroup("board-walker", { kind: "hang" });
    tracker.present("board-walker", finding("ticket-42", "r1"));

    tick(); // hangs in the session
    await settle();
    await tick();

    const names = log.names();
    expect(names.filter((name) => name === "SessionStarted")).toHaveLength(1);
    const last = log.appended().at(-1);
    expect(last?.name).toBe("TickSkipped");
    expect(last?.name === "TickSkipped" && last.reason).toBe("running");
    expect(last?.name === "TickSkipped" && last.trigger).toBe("schedule");
  });

  test("scenario 8 — the drain runs automations in list order, strictly sequential", async () => {
    const { tick, log, tracker } = composeTestProject();
    tracker.present("board-walker", finding("ticket-42", "r1"));
    tracker.present("pull-request-reactor", finding("pr-7", "r1"));

    await tick();

    const sessions = log
      .appended()
      .filter((event) => event.name === "SessionStarted")
      .map((event) => (event.name === "SessionStarted" ? String(event.automation) : ""));
    expect(sessions).toEqual(["pull-request-reactor", "board-walker"]);
    expect(log.names().at(-1)).toBe("ProjectIdled");
  });

  test("scenario 9 — a failed session consumes its input: no retry loop", async () => {
    const { tick, log, runner, tracker } = composeTestProject();
    runner.scriptGroup("board-walker", { kind: "exit", code: 2 });
    tracker.present("board-walker", finding("ticket-42", "r1"));

    await tick();
    const afterFirst = log.names();
    expect(afterFirst).toEqual([
      "AutomationsLoaded",
      "SessionStarted",
      "SessionLaunched",
      "SessionFinished",
      "ProjectIdled",
    ]);

    await tick(); // the finding is still presented — but consumed
    expect(log.names().slice(afterFirst.length)).toEqual(["ProjectIdled"]);
  });

  test("a tick on a paused project is skipped without any input check (FR-024)", async () => {
    const { start, tick, log, tracker } = composeTestProject({ policy: invalidPolicy() });
    await start();
    tracker.present("board-walker", finding("ticket-42", "r1"));

    await tick("manual");

    const last = log.appended().at(-1);
    expect(last?.name).toBe("TickSkipped");
    expect(last?.name === "TickSkipped" && last.reason).toBe("paused");
    expect(last?.name === "TickSkipped" && last.trigger).toBe("manual");
  });

  test("never-valid automations: the project keeps ticking idle and heals on a valid commit", async () => {
    const { tick, log, automationsSource } = composeTestProject({ automations: neverValid() });

    await tick();
    expect(log.names()).toEqual(["AutomationsNeverValid", "ProjectIdled"]);

    automationsSource.advanceTo(validAutomations("c3"));
    await tick();
    expect(log.names().slice(2)).toEqual(["AutomationsLoaded", "ProjectIdled"]);
  });

  test("an unchanged commit loads nothing again", async () => {
    const { tick, log } = composeTestProject();

    await tick();
    await tick();

    expect(log.names()).toEqual(["AutomationsLoaded", "ProjectIdled", "ProjectIdled"]);
  });

  test("FR-053 — a failed append stops the factory before it acts: no session, error out", async () => {
    // Disk full, fsync failed: the append rejects before anything lands.
    class FullDisk extends InMemoryEventLog {
      override append(): Promise<void> {
        return Promise.reject(new Error("fsync failed: no space left on device"));
      }
    }
    const { tick, runner, tracker } = composeTestProject({ log: new FullDisk() });
    tracker.present("board-walker", finding("ticket-42", "r1"));

    // The error propagates — main translates it to the error exit (74),
    // the supervisor restarts, the replay catches up.
    expect(tick()).rejects.toThrow("no space left on device");
    expect(runner.invocations()).toEqual([]);
  });
});

describe("the drain bounds (002)", () => {
  function cappedPolicy(sessionsPerDrain: number, sessionsPerDay: number) {
    return validPolicy({
      limits: {
        turns: 50,
        time: IsoDuration.parse("PT20M", "x"),
        sessionsPerDrain,
        sessionsPerDay,
      },
    });
  }

  test("scenario 5 — the per-drain cap ends the drain; remaining input is next tick's first hit (FR-082)", async () => {
    const { tick, log, tracker, status } = composeTestProject({
      policy: cappedPolicy(2, 1000),
    });
    tracker.present("board-walker", finding("t1", "r1"));
    tracker.present("board-walker", finding("t2", "r1"));
    tracker.present("board-walker", finding("t3", "r1"));

    await tick();

    const names = log.names();
    expect(names.filter((name) => name === "SessionStarted")).toHaveLength(2);
    expect(names.at(-2)).toBe("DrainBounded");
    expect(names.at(-1)).toBe("ProjectIdled");
    // A capped project never looks like a quiet one (FR-084).
    const report = await status();
    expect(report.kind === "report" && report.lastDrainLimit?.bound).toBe("sessions-per-drain");

    await tick();
    expect(log.names().filter((name) => name === "SessionStarted")).toHaveLength(3);
  });

  test("scenario 6 — an exhausted day budget skips once per tick; input not consumed (FR-083)", async () => {
    const clock = new ManualClock(new Date("2026-10-31T12:00:00.000Z"));
    const { tick, log, tracker, context, status } = composeTestProject({
      policy: cappedPolicy(5, 1),
      clock,
    });
    tracker.present("board-walker", finding("t1", "r1"));
    tracker.present("board-walker", finding("t2", "r1"));

    await tick();

    const names = log.names();
    expect(names.filter((name) => name === "SessionStarted")).toHaveLength(1);
    // Once per tick, never per pass — the drain ends on the budget.
    expect(names.filter((name) => name === "BudgetExhausted")).toHaveLength(1);
    expect(names.at(-1)).toBe("ProjectIdled");
    expect(
      context.project.consumedRevision(automationName("board-walker"), subjectId("t2")),
    ).toBeUndefined();
    const report = await status();
    expect(report.kind === "report" && report.lastDrainLimit?.detail).toBe("started today 1 of 1");

    // The day rolls over: the same input is due again (UTC day, FR-083).
    clock.advanceBy(24 * 60 * 60 * 1000);
    await tick();
    expect(log.names().filter((name) => name === "SessionStarted")).toHaveLength(2);
  });
});
