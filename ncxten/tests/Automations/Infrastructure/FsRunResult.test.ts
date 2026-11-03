import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsRunResult } from "~/Automations/Infrastructure/FsRunResult.ts";

let tempDirs: string[] = [];

async function resultFile(content: string | undefined): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ncxten-result-"));
  tempDirs.push(dir);
  const path = join(dir, "s1.result.json");
  if (content !== undefined) await writeFile(path, content);
  return path;
}

afterEach(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs = [];
});

const reader = new FsRunResult();

describe("FsRunResult (FR-067)", () => {
  test("reads the full report", async () => {
    const path = await resultFile(
      JSON.stringify({
        model: "claude-haiku-5-5",
        costUsd: 0.12,
        turns: 7,
        tokens: { input: 1200, output: 400, cacheRead: 90000, cacheCreated: 0 },
        detail: "smoke line appended, gate green",
      }),
    );

    expect(await reader.read(path)).toEqual({
      kind: "reported",
      usage: {
        model: "claude-haiku-5-5",
        costUsd: 0.12,
        turns: 7,
        tokens: { input: 1200, output: 400, cacheRead: 90000, cacheCreated: 0 },
      },
      detail: "smoke line appended, gate green",
    });
  });

  test("a partial report is taken as reported; unknown fields are ignored", async () => {
    const path = await resultFile(JSON.stringify({ costUsd: 0.05, vendor: "whatever" }));

    expect(await reader.read(path)).toEqual({ kind: "reported", usage: { costUsd: 0.05 } });
  });

  test("a missing file is none — the file is an offer, not an obligation", async () => {
    expect(await reader.read(await resultFile(undefined))).toEqual({ kind: "none" });
  });

  test("broken JSON is unreadable, never an error", async () => {
    const reading = await reader.read(await resultFile("{not json"));

    expect(reading.kind).toBe("unreadable");
    if (reading.kind !== "unreadable") return;
    expect(reading.problem).toContain("not JSON");
  });

  test("a wrong shape is unreadable with the failing path", async () => {
    const reading = await reader.read(await resultFile(JSON.stringify({ costUsd: "cheap" })));

    expect(reading.kind).toBe("unreadable");
    if (reading.kind !== "unreadable") return;
    expect(reading.problem).toContain("costUsd");
  });
});
