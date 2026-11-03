import { describe, expect, test } from "bun:test";
import { EventLogUnwritable } from "~/Automations/Application/EventLogUnwritable.ts";
import type { StatusReport } from "~/Automations/Application/Status.ts";
import { automationName, revision, sessionId, subjectId } from "~/Automations/Domain/Ids.ts";
import {
  type Assembly,
  resumeFlow,
  startFlow,
  statusFlow,
  tickFlow,
} from "~/Automations/UI/AutomationsRoute.ts";

/**
 * The UI is formatting and exit codes over the Assembly's result objects —
 * the flows' behavior lives in the Application tests (RunProject, RequestTick,
 * RequestResume, Status).
 */

function assembly(overrides: Partial<Assembly>): Assembly {
  const unused = () => Promise.reject(new Error("not part of this test"));
  return { run: unused, tick: unused, resume: unused, status: unused, ...overrides };
}

function collect() {
  const lines: string[] = [];
  return { lines, print: (line: string) => lines.push(line) };
}

const logUnwritable = new EventLogUnwritable("event log unwritable: disk full");

describe("startFlow", () => {
  test("started: one line, then exit 0 when the run ends cleanly", async () => {
    const out = collect();
    const a = assembly({
      run: () =>
        Promise.resolve({ kind: "started", pauseReason: undefined, finished: Promise.resolve() }),
    });

    expect(await startFlow(a, out.print)).toBe(0);
    expect(out.lines).toEqual(["started"]);
  });

  test("started paused: the reason lands on the one line", async () => {
    const out = collect();
    const a = assembly({
      run: () =>
        Promise.resolve({
          kind: "started",
          pauseReason: "policy.limitz: unknown key",
          finished: Promise.resolve(),
        }),
    });

    expect(await startFlow(a, out.print)).toBe(0);
    expect(out.lines).toEqual(["started paused — policy.limitz: unknown key"]);
  });

  test("a held lock exits 75, an unknown project 69", async () => {
    const held = collect();
    expect(
      await startFlow(assembly({ run: () => Promise.resolve({ kind: "lock-held" }) }), held.print),
    ).toBe(75);
    expect(held.lines[0]).toContain("already running");

    const unknown = collect();
    expect(
      await startFlow(
        assembly({ run: () => Promise.resolve({ kind: "unknown-project" }) }),
        unknown.print,
      ),
    ).toBe(69);
    expect(unknown.lines[0]).toContain("project unknown");
  });

  test("FR-053 — an unwritable log ends the run with 74", async () => {
    const out = collect();
    const a = assembly({
      run: () =>
        Promise.resolve({
          kind: "started",
          pauseReason: undefined,
          finished: Promise.reject(logUnwritable),
        }),
    });

    expect(await startFlow(a, out.print)).toBe(74);
    expect(out.lines.at(-1)).toContain("disk full");
  });

  test("a failed start maps the same way: 74 for the log, 1 otherwise", async () => {
    const broken = collect();
    expect(
      await startFlow(assembly({ run: () => Promise.reject(logUnwritable) }), broken.print),
    ).toBe(74);

    const other = collect();
    expect(
      await startFlow(assembly({ run: () => Promise.reject(new Error("boom")) }), other.print),
    ).toBe(1);
    expect(other.lines[0]).toContain("boom");
  });
});

describe("tickFlow", () => {
  test("every outcome has its line and exit code", async () => {
    const cases = [
      { outcome: { kind: "ticked" } as const, code: 0, line: "tick ran" },
      { outcome: { kind: "nudged", pid: 4242 } as const, code: 0, line: "SIGUSR1 sent to 4242" },
      { outcome: { kind: "no-pid" } as const, code: 1, line: "no PID yet" },
      { outcome: { kind: "unknown-project" } as const, code: 69, line: "project unknown" },
    ];
    for (const { outcome, code, line } of cases) {
      const out = collect();
      expect(await tickFlow(assembly({ tick: () => Promise.resolve(outcome) }), out.print)).toBe(
        code,
      );
      expect(out.lines[0]).toContain(line);
    }
  });

  test("a broken log ends with 74", async () => {
    const out = collect();
    expect(await tickFlow(assembly({ tick: () => Promise.reject(logUnwritable) }), out.print)).toBe(
      74,
    );
  });
});

describe("resumeFlow", () => {
  test("every outcome has its line and exit code", async () => {
    const cases = [
      { outcome: { kind: "resumed" } as const, code: 0, line: "resumed" },
      { outcome: { kind: "failed", reason: "r" } as const, code: 0, line: "still paused: r" },
      { outcome: { kind: "ignored" } as const, code: 0, line: "not paused" },
      { outcome: { kind: "requested" } as const, code: 0, line: "SIGHUP sent" },
      { outcome: { kind: "no-pid" } as const, code: 1, line: "no PID yet" },
      { outcome: { kind: "unknown-project" } as const, code: 69, line: "project unknown" },
    ];
    for (const { outcome, code, line } of cases) {
      const out = collect();
      expect(
        await resumeFlow(assembly({ resume: () => Promise.resolve(outcome) }), out.print),
      ).toBe(code);
      expect(out.lines[0]).toContain(line);
    }
  });
});

describe("statusFlow", () => {
  const report: StatusReport = {
    kind: "report",
    state: "paused",
    pauseReason: "policy.limitz: unknown key",
    processAlive: true,
    openSession: undefined,
    lastTick: new Date("2026-10-31T12:00:00.000Z"),
    lastTickSkipped: "paused",
    lastSession: undefined,
    lastDrainLimit: undefined,
    lastError: "policy.limitz: unknown key",
  };

  test("the paused report, formatted per contracts/cli.md", async () => {
    const out = collect();
    const a = assembly({ status: () => Promise.resolve(report) });

    expect(await statusFlow(a, "dazz/foo", out.print)).toBe(0);

    expect(out.lines[0]).toBe("project:       dazz/foo");
    expect(out.lines[1]).toContain("paused — policy.limitz");
    expect(out.lines[2]).toBe("process:       running");
    expect(out.lines[3]).toContain("(skipped — paused)");
    expect(out.lines[4]).toBe("last session:  none yet");
    expect(out.lines[5]).toContain("policy.limitz");
  });

  test("a dead process with an open session says so", async () => {
    const out = collect();
    const a = assembly({
      status: () =>
        Promise.resolve({
          ...report,
          state: "idle",
          pauseReason: undefined,
          processAlive: false,
          openSession: {
            sessionId: sessionId("s-1"),
            automation: automationName("board-walker"),
            subject: subjectId("ticket-42"),
            revision: revision("r1"),
          },
          lastError: undefined,
        } satisfies StatusReport),
    });

    await statusFlow(a, "dazz/foo", out.print);

    expect(out.lines[1]).toBe("state:         idle");
    expect(out.lines[2]).toBe(
      "process:       not running (open session will be aborted at next start)",
    );
  });

  test("unknown project refuses with 69", async () => {
    const out = collect();
    const a = assembly({ status: () => Promise.resolve({ kind: "unknown-project" }) });

    expect(await statusFlow(a, "dazz/foo", out.print)).toBe(69);
    expect(out.lines[0]).toContain("project unknown");
  });
});
