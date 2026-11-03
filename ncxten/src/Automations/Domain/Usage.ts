/**
 * What a session reported having cost (data-model.md): every field optional —
 * "as reported, possibly unknown". Self-reported through the result file
 * (FR-067): recorded for observability, trusted for nothing — the enforced
 * bounds are time and counts. Nothing in this slice does arithmetic on it.
 */

export interface ReportedTokens {
  readonly input?: number | undefined;
  readonly output?: number | undefined;
  readonly cacheRead?: number | undefined;
  readonly cacheCreated?: number | undefined;
}

export interface ReportedUsage {
  readonly model?: string | undefined;
  readonly costUsd?: number | undefined;
  readonly turns?: number | undefined;
  readonly tokens?: ReportedTokens | undefined;
}

/** Only the fields the command actually reported — no `undefined` keys on the wire. */
export function reportedUsage(raw: ReportedUsage): ReportedUsage {
  return {
    ...(raw.model === undefined ? {} : { model: raw.model }),
    ...(raw.costUsd === undefined ? {} : { costUsd: raw.costUsd }),
    ...(raw.turns === undefined ? {} : { turns: raw.turns }),
    ...(raw.tokens === undefined ? {} : { tokens: reportedTokens(raw.tokens) }),
  };
}

function reportedTokens(raw: ReportedTokens): ReportedTokens {
  return {
    ...(raw.input === undefined ? {} : { input: raw.input }),
    ...(raw.output === undefined ? {} : { output: raw.output }),
    ...(raw.cacheRead === undefined ? {} : { cacheRead: raw.cacheRead }),
    ...(raw.cacheCreated === undefined ? {} : { cacheCreated: raw.cacheCreated }),
  };
}

/** Whether anything was reported at all — an empty report is "usage unknown". */
export function isReported(usage: ReportedUsage): boolean {
  return Object.keys(reportedUsage(usage)).length > 0;
}
