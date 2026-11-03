import { afterEach, describe, expect, test } from "bun:test";
import { SignalControlChannel } from "~/Automations/Infrastructure/SignalControlChannel.ts";
import { composeTestProject, finding, settle } from "../../Composition.ts";

afterEach(() => {
  process.removeAllListeners("SIGHUP");
  process.removeAllListeners("SIGUSR1");
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
});

describe("SignalControlChannel", () => {
  test("SIGHUP lands on onResume, SIGUSR1 on onTickNow", async () => {
    const channel = new SignalControlChannel();
    const received: string[] = [];
    channel.onResume(() => received.push("resume"));
    channel.onTickNow(() => received.push("tick-now"));

    process.kill(process.pid, "SIGUSR1");
    await settle();
    process.kill(process.pid, "SIGHUP");
    await settle();

    expect(received).toEqual(["tick-now", "resume"]);
  });

  test("the sending half reaches the receiving half (same process here)", async () => {
    const channel = new SignalControlChannel();
    const received: string[] = [];
    channel.onTickNow(() => received.push("tick-now"));

    channel.signal(process.pid, "SIGUSR1");
    await settle();

    expect(received).toEqual(["tick-now"]);
  });

  test("SIGTERM lands on onShutdown — once", async () => {
    const channel = new SignalControlChannel();
    let calls = 0;
    channel.onShutdown(() => {
      calls += 1;
    });

    process.kill(process.pid, "SIGTERM");
    await settle();

    expect(calls).toBe(1);
    // Consumed: a second SIGTERM would hit the default action (and kill this
    // test process), so the proof is the removed listener, not a second kill.
    expect(process.listenerCount("SIGTERM")).toBe(0);
  });

  test("a tick-now during a running drain is skipped per FR-023", async () => {
    const project = composeTestProject();
    const channel = new SignalControlChannel();
    channel.onTickNow(() => void project.tick("manual"));
    project.runner.scriptGroup("board-walker", { kind: "hang" });
    project.tracker.present("board-walker", finding("ticket-42", "r1"));

    project.tick(); // hangs in the session
    await settle();
    process.kill(process.pid, "SIGUSR1"); // the handler runs between the drain's awaits
    await settle();

    const last = project.log.appended().at(-1);
    expect(last?.name).toBe("TickSkipped");
    expect(last?.name === "TickSkipped" && last.reason).toBe("running");
    expect(last?.name === "TickSkipped" && last.trigger).toBe("manual");
    expect(project.log.names().filter((name) => name === "SessionStarted")).toHaveLength(1);
  });
});
