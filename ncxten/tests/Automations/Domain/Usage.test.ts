import { describe, expect, test } from "bun:test";
import { isReported, reportedUsage } from "~/Automations/Domain/Usage.ts";

describe("ReportedUsage", () => {
  test("keeps only what was reported — no undefined keys on the wire", () => {
    const usage = reportedUsage({
      model: "claude-haiku-5-5",
      costUsd: undefined,
      turns: 7,
      tokens: { input: 1200, output: undefined, cacheRead: 90000, cacheCreated: undefined },
    });

    expect(usage).toEqual({
      model: "claude-haiku-5-5",
      turns: 7,
      tokens: { input: 1200, cacheRead: 90000 },
    });
    expect(Object.keys(usage)).toEqual(["model", "turns", "tokens"]);
  });

  test("a partial report is taken as reported — every field optional (FR-067)", () => {
    expect(reportedUsage({ costUsd: 0.12 })).toEqual({ costUsd: 0.12 });
    expect(isReported({ costUsd: 0.12 })).toBe(true);
  });

  test("an empty report is usage unknown", () => {
    expect(isReported({})).toBe(false);
    expect(isReported({ model: undefined, tokens: undefined })).toBe(false);
  });
});
