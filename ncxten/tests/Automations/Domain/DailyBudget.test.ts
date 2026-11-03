import { describe, expect, test } from "bun:test";
import { DailyBudget } from "~/Automations/Domain/DailyBudget.ts";

describe("DailyBudget", () => {
  test("allows while fewer sessions started today than the cap", () => {
    expect(new DailyBudget(3, 0).allows()).toBe(true);
    expect(new DailyBudget(3, 2).allows()).toBe(true);
  });

  test("exhausted at the cap — started counts launch attempts, not successes", () => {
    expect(new DailyBudget(3, 3).allows()).toBe(false);
    expect(new DailyBudget(3, 4).allows()).toBe(false);
  });
});
