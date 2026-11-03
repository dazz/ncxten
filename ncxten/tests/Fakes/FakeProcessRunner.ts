import type {
  GroupInvocation,
  GroupStart,
  ProcessGroups,
} from "~/Automations/Application/AutomationsPorts.ts";
import type { ProcessUnit } from "~/Automations/Domain/Event.ts";
import { type Command, ProcessResult, type ProcessRunner } from "~/Process/ProcessRunner.ts";

/** What a scripted group does when the pass launches it (contracts/run.md, fake side). */
export type GroupScript =
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "hang" }
  | { readonly kind: "spawn-failure"; readonly reason: string };

const MARK_PROJECT = "NCXTEN_PROJECT";
const MARK_SESSION = "NCXTEN_SESSION";
const KILLED = 143; // what a TERM'd sh reports — the discarded late exit

interface FakeGroup {
  readonly unit: ProcessUnit;
  readonly invocation: GroupInvocation;
  resolve: ((exit: { code: number }) => void) | undefined;
  alive: boolean;
}

/**
 * The in-memory process side (FR-063): `run()` stubs by `Command.toKey()` as
 * in 001; `startGroup` is scripted per automation (`NCXTEN_AUTOMATION` in the
 * invocation's environment) — exit code, hang (for the watchdog), spawn
 * failure — records every invocation with env and marks, and never spawns.
 * Planted marked processes play the reaper scenarios (quickstart 8/8b).
 */
export class FakeProcessRunner implements ProcessRunner, ProcessGroups {
  private readonly stubs = new Map<string, ProcessResult>();
  private readonly calls: Command[] = [];
  private readonly groupScripts = new Map<string, GroupScript>();
  private readonly groupsStarted: FakeGroup[] = [];
  private readonly planted: Array<{ project: string; session: string; group: number }> = [];
  readonly groupEnds: Array<{ unit: ProcessUnit; graceMs: number }> = [];
  readonly markEnds: Array<{ mark: string; graceMs: number }> = [];
  private nextGroup = 1000;

  // ── the 001 command side ──

  stub(key: string, result: ProcessResult): this {
    this.stubs.set(key, result);
    return this;
  }

  succeedWith(key: string, stdout: string): this {
    return this.stub(key, new ProcessResult(0, `${stdout}\n`, ""));
  }

  failWith(key: string, stderr: string): this {
    return this.stub(key, new ProcessResult(1, "", `${stderr}\n`));
  }

  run(command: Command): Promise<ProcessResult> {
    this.calls.push(command);
    const stubbed = this.stubs.get(command.toKey());
    if (stubbed === undefined) {
      throw new Error(
        `FakeProcessRunner: no stub for \`${command.toKey()}\` — stubbed: ${
          [...this.stubs.keys()].join(" | ") || "nothing"
        }`,
      );
    }
    return Promise.resolve(stubbed);
  }

  /** Readable assertions. */
  keys(): string[] {
    return this.calls.map((call) => call.toKey());
  }

  // ── the 002 group side ──

  /** Script what `automation`'s run command does; unscripted commands exit 0. */
  scriptGroup(automation: string, script: GroupScript): this {
    this.groupScripts.set(automation, script);
    return this;
  }

  startGroup(invocation: GroupInvocation): Promise<GroupStart> {
    const automation = invocation.environment.NCXTEN_AUTOMATION ?? "";
    const script = this.groupScripts.get(automation) ?? { kind: "exit", code: 0 };
    if (script.kind === "spawn-failure") {
      return Promise.resolve({ kind: "spawn-failure", reason: script.reason });
    }

    this.nextGroup += 1;
    const unit: ProcessUnit = { group: this.nextGroup, startedAt: this.nextGroup * 100 };
    const group: FakeGroup = { unit, invocation, resolve: undefined, alive: true };
    this.groupsStarted.push(group);

    const exited =
      script.kind === "exit"
        ? (() => {
            group.alive = false;
            return Promise.resolve({ code: script.code });
          })()
        : new Promise<{ code: number }>((resolve) => {
            group.resolve = resolve;
          });
    return Promise.resolve({ kind: "started", unit, exited });
  }

  endGroup(unit: ProcessUnit, graceMs: number): Promise<void> {
    this.groupEnds.push({ unit, graceMs });
    for (const group of this.groupsStarted) {
      // Verified identity: a wrong start time is somebody else — no kill.
      if (group.unit.group !== unit.group || group.unit.startedAt !== unit.startedAt) continue;
      this.kill(group);
    }
    return Promise.resolve();
  }

  endMarked(projectMark: string, graceMs: number): Promise<void> {
    this.markEnds.push({ mark: projectMark, graceMs });
    for (const group of this.groupsStarted) {
      if (group.invocation.environment[MARK_PROJECT] !== projectMark) continue;
      // The generation that awaited this exit is dead (the reaper runs at
      // start-up) — the process dies, the promise stays pending, like a crash.
      group.alive = false;
      group.resolve = undefined;
    }
    for (let i = this.planted.length - 1; i >= 0; i -= 1) {
      if (this.planted[i]?.project === projectMark) this.planted.splice(i, 1);
    }
    return Promise.resolve();
  }

  private kill(group: FakeGroup): void {
    group.alive = false;
    group.resolve?.({ code: KILLED });
    group.resolve = undefined;
  }

  /** A marked process some earlier generation left behind (quickstart 8b). */
  plant(project: string, session: string, group = 9000): void {
    this.planted.push({ project, session, group });
  }

  /** The planted processes still alive — the sibling assertion (scenario 9). */
  survivors(): ReadonlyArray<{ project: string; session: string; group: number }> {
    return [...this.planted];
  }

  /** Every started group invocation, in order — the environment-contract assertions. */
  invocations(): readonly GroupInvocation[] {
    return this.groupsStarted.map((group) => group.invocation);
  }

  /** The groups still running — nothing marked may survive the reap. */
  running(): readonly ProcessUnit[] {
    return this.groupsStarted.filter((group) => group.alive).map((group) => group.unit);
  }

  /** The session mark of a started group — mark bookkeeping for assertions. */
  sessionMarkOf(unit: ProcessUnit): string | undefined {
    return this.groupsStarted.find((group) => group.unit.group === unit.group)?.invocation
      .environment[MARK_SESSION];
  }
}
