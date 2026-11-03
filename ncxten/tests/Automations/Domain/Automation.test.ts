import { describe, expect, test } from "bun:test";
import { Automation } from "~/Automations/Domain/Automation.ts";
import { automationName } from "~/Automations/Domain/Ids.ts";

const walker = automationName("board-walker");

describe("Automation", () => {
  test("carries name, the run command and optional gate (002 re-cut)", () => {
    const automation = new Automation(walker, "bash scripts/automations/implement.sh", "make ci");

    expect(automation.name).toBe(walker);
    expect(automation.run).toBe("bash scripts/automations/implement.sh");
    expect(automation.gate).toBe("make ci");
  });

  test("the gate is optional", () => {
    expect(new Automation(walker, "bash scripts/automations/implement.sh").gate).toBeUndefined();
  });

  test("rejects an empty run command", () => {
    expect(() => new Automation(walker, " ")).toThrow("run must not be empty");
  });

  test("rejects an empty gate when declared", () => {
    expect(() => new Automation(walker, "bash scripts/automations/implement.sh", "")).toThrow(
      "gate must not be empty when declared",
    );
  });
});
