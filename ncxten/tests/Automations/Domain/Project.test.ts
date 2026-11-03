import { describe, expect, test } from "bun:test";
import type { Event } from "~/Automations/Domain/Event.ts";
import {
  automationName,
  commitId,
  revision,
  sessionId,
  subjectId,
} from "~/Automations/Domain/Ids.ts";
import { Project } from "~/Automations/Domain/Project.ts";

const at = new Date("2026-10-31T12:00:00.000Z");
const later = new Date("2026-10-31T12:15:00.000Z");
const walker = automationName("board-walker");
const ticket = subjectId("ticket-42");

function started(session = "s1", rev = "r3"): Event {
  return {
    name: "SessionStarted",
    at,
    automation: walker,
    subject: ticket,
    revision: revision(rev),
    sessionId: sessionId(session),
  };
}

describe("a fresh project", () => {
  test("is idle with nothing rebuilt yet", () => {
    const project = Project.replay([]);

    expect(project.state()).toBe("idle");
    expect(project.openSession()).toBeUndefined();
    expect(project.lastTick()).toBeUndefined();
    expect(project.lastError()).toBeUndefined();
  });

  test("ProjectStarted and PolicyLoaded mark the generation, change no state", () => {
    const project = Project.replay([
      { name: "ProjectStarted", at },
      { name: "PolicyLoaded", at, tick: "PT15M", limits: { turns: 50, time: "PT20M" } },
    ]);

    expect(project.state()).toBe("idle");
  });
});

describe("pause and resume", () => {
  test("ProjectPaused pauses with the reason as pause reason and last error", () => {
    const project = Project.replay([{ name: "ProjectPaused", at, reason: "policy unreadable" }]);

    expect(project.state()).toBe("paused");
    expect(project.pauseReason()).toBe("policy unreadable");
    expect(project.lastError()).toBe("policy unreadable");
  });

  test("ResumeFailed stays paused and updates the reason", () => {
    const project = Project.replay([
      { name: "ProjectPaused", at, reason: "policy unreadable" },
      { name: "ResumeFailed", at: later, reason: "tick below PT1M" },
    ]);

    expect(project.state()).toBe("paused");
    expect(project.pauseReason()).toBe("tick below PT1M");
  });

  test("ProjectResumed clears the pause", () => {
    const project = Project.replay([
      { name: "ProjectPaused", at, reason: "policy unreadable" },
      { name: "ProjectResumed", at: later },
    ]);

    expect(project.state()).toBe("idle");
    expect(project.pauseReason()).toBeUndefined();
  });

  test("ResumeIgnored changes nothing", () => {
    const project = Project.replay([{ name: "ResumeIgnored", at }]);

    expect(project.state()).toBe("idle");
  });

  test("paused survives a restart because it is replayed (FR-051)", () => {
    const project = Project.replay([
      { name: "ProjectPaused", at, reason: "policy unreadable" },
      { name: "ProjectStarted", at: later },
    ]);

    expect(project.state()).toBe("paused");
  });
});

describe("sessions and consumed input", () => {
  test("SessionStarted runs the project, opens the session and consumes the input", () => {
    const project = Project.replay([started()]);

    expect(project.state()).toBe("running");
    expect(project.openSession()).toEqual({
      sessionId: sessionId("s1"),
      automation: walker,
      subject: ticket,
      revision: revision("r3"),
    });
    expect(project.consumedRevision(walker, ticket)).toBe(revision("r3"));
  });

  test("a failed session keeps its input consumed (FR-035, scenario 9)", () => {
    const project = Project.replay([
      started(),
      {
        name: "SessionFinished",
        at: later,
        automation: walker,
        subject: ticket,
        sessionId: sessionId("s1"),
        outcome: "failed",
      },
    ]);

    expect(project.state()).toBe("idle");
    expect(project.openSession()).toBeUndefined();
    expect(project.lastSession()).toEqual({ automation: walker, outcome: "failed", at: later });
    expect(project.consumedRevision(walker, ticket)).toBe(revision("r3"));
  });

  test("SessionAborted clears the open session as aborted", () => {
    const project = Project.replay([
      started(),
      {
        name: "SessionAborted",
        at: later,
        automation: walker,
        subject: ticket,
        sessionId: sessionId("s1"),
      },
    ]);

    expect(project.state()).toBe("idle"); // a restarted project must tick again
    expect(project.openSession()).toBeUndefined();
    expect(project.lastSession()?.outcome).toBe("aborted");
  });

  test("a crash directly after SessionStarted rebuilds as an open session with consumed input", () => {
    // The log of a dead process simply ends here; the next generation aborts it.
    const project = Project.replay([{ name: "ProjectStarted", at }, started()]);

    expect(project.state()).toBe("running");
    expect(project.openSession()?.sessionId).toBe(sessionId("s1"));
    expect(project.consumedRevision(walker, ticket)).toBe(revision("r3"));
  });

  test("automation + subject is one consumption key, not two", () => {
    const project = Project.replay([started()]);

    expect(project.consumedRevision(walker, subjectId("ticket-7"))).toBeUndefined();
    expect(
      project.consumedRevision(automationName("pull-request-reactor"), ticket),
    ).toBeUndefined();
  });
});

describe("ticks and the heartbeat", () => {
  test("ProjectIdled ends the tick: idle, last tick stamped", () => {
    const project = Project.replay([started(), { name: "ProjectIdled", at: later }]);

    expect(project.state()).toBe("idle");
    expect(project.lastTick()).toEqual(later);
  });

  test("TickSkipped stamps the last tick and keeps the state", () => {
    const project = Project.replay([
      { name: "ProjectPaused", at, reason: "policy unreadable" },
      { name: "TickSkipped", at: later, reason: "paused", trigger: "schedule" },
    ]);

    expect(project.state()).toBe("paused");
    expect(project.lastTick()).toEqual(later);
    expect(project.lastTickSkipped()).toBe("paused");
  });

  test("a heartbeat is never the last tick and changes nothing (FR-028)", () => {
    const project = Project.replay([
      { name: "ProjectIdled", at },
      { name: "HeartbeatRecorded", at: later },
    ]);

    expect(project.lastTick()).toEqual(at);
    expect(project.state()).toBe("idle");
  });
});

describe("automations revisions", () => {
  test("AutomationsLoaded records the last valid commit", () => {
    const project = Project.replay([{ name: "AutomationsLoaded", at, commit: commitId("c2") }]);

    expect(project.lastValidAutomationsCommit()).toBe(commitId("c2"));
  });

  test("AutomationsInvalid keeps the last valid commit and records the problem", () => {
    const project = Project.replay([
      { name: "AutomationsLoaded", at, commit: commitId("c2") },
      {
        name: "AutomationsInvalid",
        at: later,
        problem: "duplicate name",
        commit: commitId("c3"),
        keptCommit: commitId("c2"),
      },
    ]);

    expect(project.lastValidAutomationsCommit()).toBe(commitId("c2"));
    expect(project.lastError()).toBe("duplicate name");
  });

  test("AutomationsNeverValid records the problem and the project keeps ticking idle", () => {
    const project = Project.replay([
      { name: "AutomationsNeverValid", at, problem: "no automations key", commit: commitId("c1") },
    ]);

    expect(project.state()).toBe("idle");
    expect(project.lastError()).toBe("no automations key");
    expect(project.lastValidAutomationsCommit()).toBeUndefined();
  });

  test("a valid load clears an automations problem, but never a pause reason", () => {
    const project = Project.replay([
      { name: "AutomationsNeverValid", at, problem: "no automations key", commit: commitId("c1") },
      { name: "AutomationsLoaded", at: later, commit: commitId("c2") },
    ]);
    const paused = Project.replay([
      { name: "ProjectPaused", at, reason: "policy unreadable" },
      { name: "AutomationsLoaded", at: later, commit: commitId("c2") },
    ]);

    expect(project.lastError()).toBeUndefined();
    expect(paused.lastError()).toBe("policy unreadable");
    expect(paused.pauseReason()).toBe("policy unreadable");
  });
});

describe("the 002 session delta", () => {
  const unit = { group: 4242, startedAt: 123456789 };

  function launched(session = "s1"): Event {
    return {
      name: "SessionLaunched",
      at,
      automation: walker,
      subject: ticket,
      sessionId: sessionId(session),
      unit,
    };
  }

  test("SessionLaunched attaches the unit to the open session (FR-066)", () => {
    const project = Project.replay([started(), launched()]);

    expect(project.state()).toBe("running");
    expect(project.openSession()?.unit).toEqual(unit);
  });

  test("a launch record for a different session changes nothing", () => {
    const project = Project.replay([started("s1"), launched("s9")]);

    expect(project.openSession()?.unit).toBeUndefined();
  });

  test("SessionLimited closes the session with outcome limit (FR-081)", () => {
    const project = Project.replay([
      started(),
      launched(),
      {
        name: "SessionLimited",
        at: later,
        automation: walker,
        subject: ticket,
        sessionId: sessionId("s1"),
        dimension: "time",
      },
    ]);

    expect(project.state()).toBe("idle");
    expect(project.openSession()).toBeUndefined();
    expect(project.lastSession()).toEqual({ automation: walker, outcome: "limit", at: later });
    // The limited session's input stays consumed (FR-035 holds uniformly).
    expect(project.consumedRevision(walker, ticket)).toBe(revision("r3"));
  });

  test("started-today counts the UTC day's starts, the boundary at read time (FR-083)", () => {
    const sameDay = new Date("2026-10-31T23:59:00.000Z");
    const nextDay = new Date("2026-11-01T00:01:00.000Z");
    const project = Project.replay([
      started("s1", "r1"),
      {
        name: "SessionStarted",
        at: sameDay,
        automation: walker,
        subject: subjectId("t2"),
        revision: revision("r1"),
        sessionId: sessionId("s2"),
      },
    ]);

    expect(project.startedToday(at)).toBe(2);
    // The day rolls over: the same fold answers 0 — nothing stored, nothing reset.
    expect(project.startedToday(nextDay)).toBe(0);
  });

  test("a crash between start and launch rebuilds an open session without a unit (8c)", () => {
    const project = Project.replay([started()]);

    expect(project.openSession()?.sessionId).toBe(sessionId("s1"));
    expect(project.openSession()?.unit).toBeUndefined();
  });

  test("BudgetExhausted sets the last drain limit — a capped project never looks quiet (FR-084)", () => {
    const project = Project.replay([
      { name: "BudgetExhausted", at: later, day: "2026-10-31", started: 3, cap: 3 },
    ]);

    expect(project.lastDrainLimit()).toEqual({
      bound: "sessions-per-day",
      detail: "started today 3 of 3",
      at: later,
    });
    // The hit's input was NOT consumed (FR-083) — nothing else changed.
    expect(project.state()).toBe("idle");
  });

  test("DrainBounded supersedes an older limit; nothing clears it", () => {
    const project = Project.replay([
      { name: "BudgetExhausted", at, day: "2026-10-31", started: 3, cap: 3 },
      { name: "DrainBounded", at: later, cap: 5 },
      { name: "ProjectIdled", at: later },
    ]);

    expect(project.lastDrainLimit()).toEqual({
      bound: "sessions-per-drain",
      detail: "ran 5 sessions this drain",
      at: later,
    });
  });
});

describe("the extension rule", () => {
  test("replay ignores events this version does not know", () => {
    const unknown = { name: "SomethingNewer", at, extra: "field" } as unknown as Event;
    const project = Project.replay([{ name: "ProjectIdled", at }, unknown]);

    expect(project.state()).toBe("idle");
    expect(project.lastTick()).toEqual(at);
    expect(project.lastError()).toBeUndefined();
  });
});
