import { describe, expect, test } from "bun:test";
import { automationName, subjectId } from "~/Automations/Domain/Ids.ts";
import { IsoDuration } from "~/Automations/Domain/IsoDuration.ts";
import {
  BreakableLog,
  composeTestProject,
  finding,
  type TestProjectOptions,
  validAutomations,
  validPolicy,
} from "../../Composition.ts";

function compose(options: TestProjectOptions = {}) {
  const project = composeTestProject(options);
  const reading = options.automations ?? validAutomations();
  if (!("automations" in reading)) throw new Error("fixture");
  const policy = options.policy ?? validPolicy();
  if (!("limits" in policy)) throw new Error("fixture needs a valid policy");
  return { ...project, automations: reading.automations, limits: policy.limits };
}

describe("one pass", () => {
  test("no new input → empty pass, nothing appended, no command started", async () => {
    const { runPass, automations, limits, log, runner } = compose();

    expect(await runPass.run(automations, limits)).toBe("empty-pass");
    expect(log.appended()).toEqual([]);
    expect(runner.invocations()).toEqual([]);
  });

  test("FR-053/FR-092 — a start that cannot be recorded starts no command", async () => {
    const broken = new BreakableLog();
    broken.broken = true;
    const { runPass, automations, limits, runner, tracker } = compose({ log: broken });
    tracker.present("board-walker", finding("ticket-42", "r1"));

    expect(runPass.run(automations, limits)).rejects.toThrow("unwritable");
    expect(runner.invocations()).toEqual([]);
  });

  test("starting consumes the input, whatever the outcome (FR-035)", async () => {
    const { runPass, automations, limits, context, tracker, runner } = compose();
    tracker.present("board-walker", finding("ticket-42", "r1"));
    runner.scriptGroup("board-walker", { kind: "exit", code: 2 });

    await runPass.run(automations, limits);

    expect(
      String(
        context.project.consumedRevision(automationName("board-walker"), subjectId("ticket-42")),
      ),
    ).toBe("r1");
    // The same finding is still presented — the next pass is empty.
    expect(await runPass.run(automations, limits)).toBe("empty-pass");
  });

  test("an exhausted day budget starts nothing and consumes nothing (FR-083)", async () => {
    const policy = validPolicy({
      limits: {
        turns: 50,
        time: IsoDuration.parse("PT20M", "x"),
        sessionsPerDrain: 5,
        sessionsPerDay: 1,
      },
    });
    const { runPass, automations, limits, context, tracker, runner } = compose({ policy });
    tracker.present("board-walker", finding("ticket-42", "r1"));
    expect(await runPass.run(automations, limits)).toBe("session-ran");

    tracker.present("board-walker", finding("ticket-7", "r1"));
    expect(await runPass.run(automations, limits)).toBe("budget-exhausted");

    // The hit's input was not consumed — due again when the day rolls over.
    expect(
      context.project.consumedRevision(automationName("board-walker"), subjectId("ticket-7")),
    ).toBeUndefined();
    expect(runner.invocations()).toHaveLength(1);
  });
});
