import { describe, expect, test } from "bun:test";
import {
  composeTestProject,
  finding,
  invalidPolicy,
  missingPolicy,
  settle,
} from "../../Composition.ts";

describe("the status query", () => {
  test("a paused project reports state, reason and last error", async () => {
    const project = composeTestProject({ policy: invalidPolicy() });
    await project.start();
    await project.tick();

    const report = await project.status();

    expect(report.kind).toBe("report");
    if (report.kind !== "report") return;
    expect(report.state).toBe("paused");
    expect(report.pauseReason).toContain("policy.limitz");
    expect(report.lastError).toContain("policy.limitz");
    expect(report.lastTick).toBeDefined();
    expect(report.lastTickSkipped).toBe("paused");
  });

  test("a live session shows running, with the lock held", async () => {
    const project = composeTestProject();
    await project.start();
    project.runner.scriptGroup("board-walker", { kind: "hang" });
    project.tracker.present("board-walker", finding("ticket-42", "r1"));
    project.tick(); // hangs in the session
    await settle();

    const report = await project.status();

    expect(report.kind === "report" && report.state).toBe("running");
    expect(report.kind === "report" && report.processAlive).toBe(true);
    expect(report.kind === "report" && report.openSession?.automation).toBeDefined();
  });

  test("FR-025 — a dead session never shows running: the lock probe decides", async () => {
    const first = composeTestProject();
    await first.start();
    first.runner.scriptGroup("board-walker", { kind: "hang" });
    first.tracker.present("board-walker", finding("ticket-42", "r1"));
    first.tick();
    await settle();
    expect(first.log.names().at(-1)).toBe("SessionLaunched");

    // The "crash": a fresh composition over the same log — nobody holds the lock.
    const second = composeTestProject({ log: first.log });
    const report = await second.status();

    expect(report.kind === "report" && report.state).toBe("idle");
    expect(report.kind === "report" && report.processAlive).toBe(false);
    // The open session is still visible — it will be aborted at the next start.
    expect(report.kind === "report" && report.openSession?.sessionId).toBeDefined();
  });

  test("last session appears with automation, outcome and time", async () => {
    const project = composeTestProject();
    project.tracker.present("board-walker", finding("ticket-42", "r1"));
    await project.tick();

    const report = await project.status();

    expect(report.kind === "report" && String(report.lastSession?.automation)).toBe("board-walker");
    expect(report.kind === "report" && report.lastSession?.outcome).toBe("succeeded");
  });

  test("unknown project: no policy file and no log (exit 69 at the UI)", async () => {
    const project = composeTestProject({ policy: missingPolicy() });

    expect(await project.status()).toEqual({ kind: "unknown-project" });
  });
});
