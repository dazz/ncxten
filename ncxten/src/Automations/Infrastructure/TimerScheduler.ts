import type { Scheduler, Stop } from "~/Automations/Application/AutomationsPorts.ts";
import type { IsoDuration } from "~/Automations/Domain/IsoDuration.ts";

/**
 * A plain timer to the next due tick — not a cron (STACK Scheduling). The
 * same adapter drives the tick and the liveness heartbeat. Error handling is
 * the caller's: `fire` must carry its own catch, because a failed append must
 * end the process (FR-053), never be swallowed by the schedule.
 */
export class TimerScheduler implements Scheduler {
  start(interval: IsoDuration, fire: () => Promise<void>): Stop {
    const timer = setInterval(() => void fire(), interval.milliseconds);
    return () => clearInterval(timer);
  }

  /** The session deadline (002): one shot, cancelled when the exit wins the race. */
  once(delay: IsoDuration, fire: () => void): Stop {
    const timer = setTimeout(() => fire(), delay.milliseconds);
    return () => clearTimeout(timer);
  }

  sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
