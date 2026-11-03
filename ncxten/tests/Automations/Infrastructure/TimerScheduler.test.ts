import { describe, expect, test } from "bun:test";
import { IsoDuration } from "~/Automations/Domain/IsoDuration.ts";
import { TimerScheduler } from "~/Automations/Infrastructure/TimerScheduler.ts";

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("TimerScheduler", () => {
  test("fires on its interval until stopped — sub-second, not through the bounded policy tick", async () => {
    const scheduler = new TimerScheduler();
    let fired = 0;

    const stop = scheduler.start(IsoDuration.parse("PT0.02S", "test interval"), () => {
      fired += 1;
      return Promise.resolve();
    });
    await sleep(90);
    stop();
    const atStop = fired;
    await sleep(50);

    expect(atStop).toBeGreaterThanOrEqual(2);
    expect(fired).toBe(atStop);
  });

  test("the schedule keeps firing when a fire handles its own failure (FR-053 is the caller's)", async () => {
    const scheduler = new TimerScheduler();
    let fired = 0;

    const stop = scheduler.start(IsoDuration.parse("PT0.02S", "test interval"), () => {
      fired += 1;
      return Promise.reject(new Error("one bad tick")).catch(() => undefined);
    });
    await sleep(70);
    stop();

    expect(fired).toBeGreaterThanOrEqual(2);
  });

  test("sleep waits out its milliseconds — the poll loops' one bounded wait", async () => {
    const before = Date.now();

    await new TimerScheduler().sleep(30);

    expect(Date.now() - before).toBeGreaterThanOrEqual(25);
  });
});

describe("the one-shot deadline (002)", () => {
  function sleepMs(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  test("once fires once after its delay — a due date, not an interval", async () => {
    const scheduler = new TimerScheduler();
    let fired = 0;

    scheduler.once(IsoDuration.parse("PT0.03S", "test deadline"), () => {
      fired += 1;
    });
    await sleepMs(100);

    expect(fired).toBe(1);
  });

  test("a cancelled deadline never fires — the exit won the race", async () => {
    const scheduler = new TimerScheduler();
    let fired = 0;

    const cancel = scheduler.once(IsoDuration.parse("PT0.03S", "test deadline"), () => {
      fired += 1;
    });
    cancel();
    await sleepMs(60);

    expect(fired).toBe(0);
  });
});
