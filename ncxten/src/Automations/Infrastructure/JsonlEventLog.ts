import { type FileHandle, mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EventLog } from "~/Automations/Application/AutomationsPorts.ts";
import { EventLogUnwritable } from "~/Automations/Application/EventLogUnwritable.ts";
import {
  budgetDetail,
  drainDetail,
  type Event,
  type FailureCause,
  identityOf,
  levelOf,
  type ProcessUnit,
  type SessionLimits,
} from "~/Automations/Domain/Event.ts";
import {
  automationName,
  commitId,
  revision,
  sessionId,
  subjectId,
} from "~/Automations/Domain/Ids.ts";
import { isReported, type ReportedUsage, reportedUsage } from "~/Automations/Domain/Usage.ts";

/**
 * The event log on disk: one schema v1 line per event — the contract the
 * observability pipeline consumes (`infra/`, STACK Events). Translates domain
 * events ↔ lines in both directions. Every append goes through one in-process
 * queue (signal handlers, the liveness heartbeat and the drain share the
 * path) and is fsynced, because the event precedes the action it announces.
 * Replay drops a truncated last line and skips lines this version does not
 * know (extension rule).
 */
export class JsonlEventLog implements EventLog {
  private handle: FileHandle | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    /** `<state-root>/events/<owner>/<repo>.jsonl` — the only directory Vector mounts. */
    private readonly path: string,
    /** The project ID — in every line, because Vector merges several logs. */
    private readonly repository: string,
    /** From the policy at append time; omitted on lines without a valid one. */
    private readonly forge: () => string | undefined,
  ) {}

  append(event: Event): Promise<void> {
    const task = this.queue.then(() => this.write(event));
    this.queue = task.catch(() => undefined);
    return task;
  }

  async *replay(): AsyncIterable<Event> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const lines = text.split("\n").filter((line) => line !== "");
    for (const [index, line] of lines.entries()) {
      let fields: unknown;
      try {
        fields = JSON.parse(line);
      } catch (error) {
        // A crash mid-append truncates only the last line — drop it.
        if (index === lines.length - 1) return;
        throw error;
      }
      const event = toEvent(fields as Record<string, unknown>);
      if (event !== undefined) yield event;
    }
  }

  async close(): Promise<void> {
    await this.queue;
    await this.handle?.close();
    this.handle = undefined;
  }

  private async write(event: Event): Promise<void> {
    try {
      if (this.handle === undefined) {
        await mkdir(dirname(this.path), { recursive: true });
        this.handle = await open(this.path, "a");
      }
      await this.handle.write(`${JSON.stringify(this.toLine(event))}\n`, null, "utf8");
      await this.handle.sync();
    } catch (error) {
      // FR-053: no append, no action — the caller ends the process (exit 74).
      throw new EventLogUnwritable(`event log unwritable at ${this.path}: ${String(error)}`);
    }
  }

  private toLine(event: Event): Record<string, unknown> {
    const { kind, outcome } = identityOf(event);
    const forge = this.forge();
    return {
      schema: SCHEMA,
      time: event.at.toISOString(),
      kind,
      repository: this.repository,
      ...(forge === undefined ? {} : { forge }),
      ...identifiers(event),
      outcome,
      ...extras(event),
      level: levelOf(event),
    };
  }
}

const SCHEMA = 1;

/** `automation`, `issue` and `detail` — the envelope's who-and-why fields. */
function identifiers(event: Event): Record<string, unknown> {
  switch (event.name) {
    case "ProjectPaused":
    case "ResumeFailed":
      return { detail: event.reason };
    case "AutomationsInvalid":
    case "AutomationsNeverValid":
      return { detail: event.problem };
    case "TickSkipped":
      return { detail: event.reason };
    case "SessionStarted":
    case "SessionLaunched":
      return { automation: event.automation, issue: event.subject };
    case "SessionFinished":
      return {
        automation: event.automation,
        issue: event.subject,
        ...(event.detail === undefined ? {} : { detail: event.detail }),
      };
    case "SessionLimited":
      return { automation: event.automation, issue: event.subject, detail: event.dimension };
    case "SessionAborted":
      return { automation: event.automation, issue: event.subject, detail: "orphaned" };
    case "BudgetExhausted":
      return { detail: budgetDetail(event) };
    case "DrainBounded":
      return { detail: drainDetail(event) };
    default:
      return {};
  }
}

/** The per-event extra fields of the catalog (data-model.md). */
function extras(event: Event): Record<string, unknown> {
  switch (event.name) {
    case "PolicyLoaded":
      return { tick: event.tick, limits: event.limits };
    case "AutomationsLoaded":
    case "AutomationsNeverValid":
      return { commit: event.commit };
    case "AutomationsInvalid":
      return { commit: event.commit, keptCommit: event.keptCommit };
    case "TickSkipped":
      return { trigger: event.trigger };
    case "SessionStarted":
      return { sessionId: event.sessionId, revision: event.revision };
    case "SessionLaunched":
      return { sessionId: event.sessionId, unit: event.unit };
    case "SessionFinished":
      return {
        sessionId: event.sessionId,
        ...(event.cause === undefined ? {} : { cause: event.cause }),
        // Usage flattened into the line (data-model) — omitted where unknown.
        ...(event.usage === undefined ? {} : reportedUsage(event.usage)),
      };
    case "SessionLimited":
      return { sessionId: event.sessionId, dimension: event.dimension };
    case "SessionAborted":
      return { sessionId: event.sessionId };
    case "BudgetExhausted":
      return { day: event.day, started: event.started, cap: event.cap };
    case "DrainBounded":
      return { cap: event.cap };
    default:
      return {};
  }
}

/** Line → domain event; `undefined` for a kind/outcome this version does not know. */
function toEvent(fields: Record<string, unknown>): Event | undefined {
  const at = new Date(text(fields.time));
  switch (`${text(fields.kind)}/${text(fields.outcome)}`) {
    case "project/started":
      return { name: "ProjectStarted", at };
    case "policy/loaded":
      return {
        name: "PolicyLoaded",
        at,
        tick: text(fields.tick),
        limits: fields.limits as SessionLimits,
      };
    case "project/paused":
      return { name: "ProjectPaused", at, reason: text(fields.detail) };
    case "project/resumed":
      return { name: "ProjectResumed", at };
    case "resume/failed":
      return { name: "ResumeFailed", at, reason: text(fields.detail) };
    case "resume/ignored":
      return { name: "ResumeIgnored", at };
    case "automations/loaded":
      return { name: "AutomationsLoaded", at, commit: commitId(text(fields.commit)) };
    case "automations/invalid":
      return {
        name: "AutomationsInvalid",
        at,
        problem: text(fields.detail),
        commit: commitId(text(fields.commit)),
        keptCommit: commitId(text(fields.keptCommit)),
      };
    case "automations/never-valid":
      return {
        name: "AutomationsNeverValid",
        at,
        problem: text(fields.detail),
        commit: commitId(text(fields.commit)),
      };
    case "tick/idle":
      return { name: "ProjectIdled", at };
    case "tick/skipped":
      return {
        name: "TickSkipped",
        at,
        reason: text(fields.detail) === "paused" ? "paused" : "running",
        trigger: text(fields.trigger) === "manual" ? "manual" : "schedule",
      };
    case "project/heartbeat":
      return { name: "HeartbeatRecorded", at };
    case "session/started":
      return {
        name: "SessionStarted",
        at,
        automation: automationName(text(fields.automation)),
        subject: subjectId(text(fields.issue)),
        revision: revision(text(fields.revision)),
        sessionId: sessionId(text(fields.sessionId)),
      };
    case "session/launched":
      return {
        name: "SessionLaunched",
        at,
        automation: automationName(text(fields.automation)),
        subject: subjectId(text(fields.issue)),
        sessionId: sessionId(text(fields.sessionId)),
        unit: toUnit(fields.unit),
      };
    case "session/succeeded":
    case "session/failed": {
      const cause = toCause(fields.cause);
      const detail = typeof fields.detail === "string" ? fields.detail : undefined;
      const usage = toUsage(fields);
      return {
        name: "SessionFinished",
        at,
        automation: automationName(text(fields.automation)),
        subject: subjectId(text(fields.issue)),
        sessionId: sessionId(text(fields.sessionId)),
        outcome: text(fields.outcome) === "failed" ? "failed" : "succeeded",
        ...(cause === undefined ? {} : { cause }),
        ...(detail === undefined ? {} : { detail }),
        ...(usage === undefined ? {} : { usage }),
      };
    }
    case "session/limit":
      return {
        name: "SessionLimited",
        at,
        automation: automationName(text(fields.automation)),
        subject: subjectId(text(fields.issue)),
        sessionId: sessionId(text(fields.sessionId)),
        dimension: "time",
      };
    case "limit/sessions-per-day":
      return {
        name: "BudgetExhausted",
        at,
        day: text(fields.day),
        started: number(fields.started),
        cap: number(fields.cap),
      };
    case "limit/sessions-per-drain":
      return { name: "DrainBounded", at, cap: number(fields.cap) };
    case "session/aborted":
      return {
        name: "SessionAborted",
        at,
        automation: automationName(text(fields.automation)),
        subject: subjectId(text(fields.issue)),
        sessionId: sessionId(text(fields.sessionId)),
      };
    default:
      return undefined;
  }
}

function text(field: unknown): string {
  return typeof field === "string" ? field : "";
}

function number(field: unknown): number {
  return typeof field === "number" ? field : 0;
}

function toUnit(field: unknown): ProcessUnit {
  const raw = (field ?? {}) as Partial<ProcessUnit>;
  return { group: number(raw.group), startedAt: number(raw.startedAt) };
}

function toCause(field: unknown): FailureCause | undefined {
  return field === "spawn" || field === "exit" ? field : undefined;
}

/** The flattened usage fields of a closing line — `undefined` when none was reported. */
function toUsage(fields: Record<string, unknown>): ReportedUsage | undefined {
  const tokens = (fields.tokens ?? {}) as Record<string, unknown>;
  const usage = reportedUsage({
    model: typeof fields.model === "string" ? fields.model : undefined,
    costUsd: typeof fields.costUsd === "number" ? fields.costUsd : undefined,
    turns: typeof fields.turns === "number" ? fields.turns : undefined,
    tokens:
      fields.tokens === undefined
        ? undefined
        : {
            input: typeof tokens.input === "number" ? tokens.input : undefined,
            output: typeof tokens.output === "number" ? tokens.output : undefined,
            cacheRead: typeof tokens.cacheRead === "number" ? tokens.cacheRead : undefined,
            cacheCreated: typeof tokens.cacheCreated === "number" ? tokens.cacheCreated : undefined,
          },
  });
  return isReported(usage) ? usage : undefined;
}
