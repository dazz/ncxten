import { describe, expect, test } from "bun:test";
import { Automation } from "~/Automations/Domain/Automation.ts";
import { ConsumedInput } from "~/Automations/Domain/ConsumedInput.ts";
import { automationName, revision, sessionId, subjectId } from "~/Automations/Domain/Ids.ts";
import { IsoDuration } from "~/Automations/Domain/IsoDuration.ts";
import { Session } from "~/Automations/Domain/Session.ts";

const walker = new Automation(automationName("board-walker"), "walk-the-board");
const input = new ConsumedInput(
  automationName("board-walker"),
  subjectId("ticket-42"),
  revision("r3"),
);
const limits = {
  turns: 50,
  time: IsoDuration.parse("PT20M", "x"),
  sessionsPerDrain: 5,
  sessionsPerDay: 20,
};

describe("Session", () => {
  test("is open until the harness returns an outcome", () => {
    const session = new Session(sessionId("s1"), walker, input, limits);

    expect(session.isOpen()).toBe(true);
    expect(session.outcome).toBeUndefined();
  });

  test("finishes with the harness outcome", () => {
    const finished = new Session(sessionId("s1"), walker, input, limits).finishedWith("failed");

    expect(finished.isOpen()).toBe(false);
    expect(finished.outcome).toBe("failed");
  });

  test("rejects input that belongs to another automation", () => {
    const foreign = new ConsumedInput(
      automationName("pull-request-reactor"),
      subjectId("ticket-42"),
      revision("r3"),
    );

    expect(() => new Session(sessionId("s1"), walker, foreign, limits)).toThrow(
      "input belongs to pull-request-reactor, not board-walker",
    );
  });
});

describe("the 002 session delta", () => {
  test("launched attaches the unit; the session stays open (FR-066)", () => {
    const launched = new Session(sessionId("s1"), walker, input, limits).launched({
      group: 4242,
      startedAt: 123456789,
    });

    expect(launched.isOpen()).toBe(true);
    expect(launched.unit).toEqual({ group: 4242, startedAt: 123456789 });
  });

  test("finishes with outcome and the reported usage (FR-067)", () => {
    const finished = new Session(sessionId("s1"), walker, input, limits)
      .launched({ group: 4242, startedAt: 123456789 })
      .finishedWith("succeeded", { costUsd: 0.12 });

    expect(finished.isOpen()).toBe(false);
    expect(finished.usage).toEqual({ costUsd: 0.12 });
    expect(finished.unit?.group).toBe(4242);
  });

  test("limit is a session outcome since 002 (FR-081)", () => {
    const limited = new Session(sessionId("s1"), walker, input, limits).finishedWith("limit");

    expect(limited.outcome).toBe("limit");
  });
});
