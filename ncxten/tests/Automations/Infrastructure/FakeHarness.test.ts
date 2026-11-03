import { describe, expect, test } from "bun:test";
import { Automation } from "~/Automations/Domain/Automation.ts";
import { ConsumedInput } from "~/Automations/Domain/ConsumedInput.ts";
import { automationName, revision, subjectId } from "~/Automations/Domain/Ids.ts";
import { IsoDuration } from "~/Automations/Domain/IsoDuration.ts";
import {
  FakeHarness,
  fail,
  hangUntilAborted,
  succeed,
} from "~/Automations/Infrastructure/FakeHarness.ts";

const walker = new Automation(automationName("board-walker"), "walk-the-board");
const input = new ConsumedInput(walker.name, subjectId("ticket-42"), revision("r3"));
const limits = {
  turns: 50,
  time: IsoDuration.parse("PT20M", "x"),
  sessionsPerDrain: 5,
  sessionsPerDay: 20,
};

describe("FakeHarness", () => {
  test("plays the script for the automation and records the call with its limits", async () => {
    const harness = new FakeHarness();
    harness.script("board-walker", fail());

    const outcome = await harness.run(walker, input, limits);

    expect(outcome).toBe("failed");
    expect(harness.calls()).toHaveLength(1);
    expect(harness.calls()[0]?.limits).toBe(limits);
    expect(harness.calls()[0]?.input).toBe(input);
  });

  test("an unscripted automation succeeds", async () => {
    expect(await new FakeHarness().run(walker, input, limits)).toBe("succeeded");
  });

  test("succeed and fail resolve, hangUntilAborted never does", async () => {
    expect(await succeed()()).toBe("succeeded");
    expect(await fail()()).toBe("failed");

    const hanging = hangUntilAborted()();
    const raced = await Promise.race([hanging, Promise.resolve("still-hanging")]);
    expect(raced).toBe("still-hanging");
  });
});
