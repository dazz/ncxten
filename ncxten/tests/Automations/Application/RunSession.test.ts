import { describe, expect, test } from "bun:test";
import { Automation } from "~/Automations/Domain/Automation.ts";
import { ConsumedInput } from "~/Automations/Domain/ConsumedInput.ts";
import { levelOf } from "~/Automations/Domain/Event.ts";
import { automationName, revision, subjectId } from "~/Automations/Domain/Ids.ts";
import { IsoDuration } from "~/Automations/Domain/IsoDuration.ts";
import type { Hit } from "~/Automations/Domain/Pass.ts";
import { composeTestProject, settle, validPolicy } from "../../Composition.ts";

const walker = automationName("board-walker");

function hit(subject = 'ticket-42 with spaces, "quotes" & $variables'): Hit {
  const automation = new Automation(walker, "bash scripts/automations/implement.sh", "make ci");
  return {
    automation,
    input: new ConsumedInput(walker, subjectId(subject), revision("r1")),
  };
}

const limits = validPolicy().limits;

describe("one session (FR-092 order)", () => {
  test("scenario 1 — the launch carries the whole environment contract", async () => {
    const project = composeTestProject();
    const { runSession, runner, log } = project;

    await runSession.run(hit(), limits);

    expect(log.names()).toEqual(["SessionStarted", "SessionLaunched", "SessionFinished"]);
    const invocation = runner.invocations()[0];
    expect(invocation?.run).toBe("bash scripts/automations/implement.sh");
    expect(invocation?.cwd).toBe("/home/dazz/checkouts/foo");
    const started = log.appended()[0];
    const id = started?.name === "SessionStarted" ? String(started.sessionId) : "";
    expect(invocation?.environment).toEqual({
      NCXTEN_PROJECT: "dazz/foo",
      NCXTEN_SESSION: id,
      NCXTEN_AUTOMATION: "board-walker",
      // Arbitrary text — the reason input travels as environment (FR-061).
      NCXTEN_SUBJECT: 'ticket-42 with spaces, "quotes" & $variables',
      NCXTEN_REVISION: "r1",
      NCXTEN_TIME_LIMIT: "PT20M",
      NCXTEN_TURNS: "50",
      NCXTEN_RESULT: `/fake/state/projects/dazz/foo/sessions/${id}.result.json`,
    });
    expect(invocation?.outputPath).toBe(`/fake/state/projects/dazz/foo/sessions/${id}.out`);
    // The launch record carries the unit the runner handed back (FR-066).
    const launched = log.appended()[1];
    expect(launched?.name === "SessionLaunched" && launched.unit.group).toBeGreaterThan(0);
  });

  test("scenario 2 — exit 0 + result file: succeeded with the reported usage", async () => {
    const project = composeTestProject();
    const { runSession, runResult, log } = project;
    runResult.set({
      kind: "reported",
      usage: { model: "claude-haiku-5-5", costUsd: 0.12, turns: 7 },
      detail: "gate green",
    });

    await runSession.run(hit(), limits);

    const finished = log.appended().at(-1);
    expect(finished).toMatchObject({
      name: "SessionFinished",
      outcome: "succeeded",
      detail: "gate green",
      usage: { model: "claude-haiku-5-5", costUsd: 0.12, turns: 7 },
    });
    // The factory asked for exactly the path it handed over (FR-067).
    expect(runResult.reads).toHaveLength(1);
  });

  test("scenario 2b — exit 0, no result file: succeeded, usage omitted", async () => {
    const project = composeTestProject();
    const { runSession, log } = project;

    await runSession.run(hit(), limits);

    const finished = log.appended().at(-1);
    expect(finished?.name).toBe("SessionFinished");
    if (finished?.name !== "SessionFinished") return;
    expect(finished.outcome).toBe("succeeded");
    expect(finished.usage).toBeUndefined();
    expect(finished.detail).toBeUndefined();
  });

  test("scenario 2c — exit 0, unreadable result file: still succeeded, the problem in detail", async () => {
    const project = composeTestProject();
    const { runSession, runResult, log } = project;
    runResult.set({ kind: "unreadable", problem: "result file is not JSON: Unexpected token" });

    await runSession.run(hit(), limits);

    const finished = log.appended().at(-1);
    expect(finished).toMatchObject({
      name: "SessionFinished",
      outcome: "succeeded", // the exit code is the contract
      detail: "result file is not JSON: Unexpected token",
    });
  });

  test("scenario 3 — the deadline ends the whole group; the result file is never read", async () => {
    const project = composeTestProject();
    const { runSession, runner, runResult, scheduler, log } = project;
    runner.scriptGroup("board-walker", { kind: "hang" });
    runResult.set({ kind: "reported", usage: { costUsd: 9.99 } });

    const running = runSession.run(hit(), limits);
    await settle();
    scheduler.elapse(IsoDuration.parse("PT20M", "x"));
    await running;

    const names = log.names();
    expect(names).toEqual(["SessionStarted", "SessionLaunched", "SessionLimited"]);
    // endGroup with the started unit, awaited (children write between TERM and KILL).
    const launched = log.appended()[1];
    const unit = launched?.name === "SessionLaunched" ? launched.unit : undefined;
    expect(runner.groupEnds).toEqual([{ unit: unit as NonNullable<typeof unit>, graceMs: 5000 }]);
    // The killed command's report would be half-written — not read (FR-081).
    expect(runResult.reads).toEqual([]);
    const limited = log.appended().at(-1);
    expect(limited?.name === "SessionLimited" && limited.dimension).toBe("time");
    expect(limited === undefined ? "" : levelOf(limited)).toBe("warn");
  });

  test("the exit cancels the deadline — no late kill, no limit record", async () => {
    const project = composeTestProject();
    const { runSession, runner, scheduler, log } = project;

    await runSession.run(hit(), limits);
    scheduler.elapse(IsoDuration.parse("PT20M", "x"));

    expect(scheduler.deadlines[0]?.cancelled).toBe(true);
    expect(runner.groupEnds).toEqual([]);
    expect(log.names().at(-1)).toBe("SessionFinished");
  });

  test("scenario 4 — a non-zero exit is failed/exit with the code in detail, level warn", async () => {
    const project = composeTestProject();
    const { runSession, runner, runResult, log } = project;
    runner.scriptGroup("board-walker", { kind: "exit", code: 2 });
    runResult.set({ kind: "reported", usage: { costUsd: 0.03 } });

    await runSession.run(hit(), limits);

    const finished = log.appended().at(-1);
    expect(finished).toMatchObject({
      name: "SessionFinished",
      outcome: "failed",
      cause: "exit",
      detail: "exit 2",
      // A non-killed exit still reads the report (FR-067) — failures cost money too.
      usage: { costUsd: 0.03 },
    });
    expect(finished === undefined ? "" : levelOf(finished)).toBe("warn");
  });

  test("scenario 7 — a spawn failure is failed/spawn at level error; no launch record", async () => {
    const project = composeTestProject();
    const { runSession, runner, log } = project;
    runner.scriptGroup("board-walker", { kind: "spawn-failure", reason: "sh: not a directory" });

    await runSession.run(hit(), limits);

    expect(log.names()).toEqual(["SessionStarted", "SessionFinished"]);
    const finished = log.appended().at(-1);
    expect(finished).toMatchObject({
      name: "SessionFinished",
      outcome: "failed",
      cause: "spawn",
      detail: "sh: not a directory",
    });
    expect(finished === undefined ? "" : levelOf(finished)).toBe("error");
  });
});
