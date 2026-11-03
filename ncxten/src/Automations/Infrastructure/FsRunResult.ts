import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { RunResult, RunResultReading } from "~/Automations/Application/AutomationsPorts.ts";
import { reportedUsage } from "~/Automations/Domain/Usage.ts";

/**
 * The lenient read of `$NCXTEN_RESULT` (contracts/run.md): every field
 * optional, unknown fields ignored, partial usage taken as reported. Missing
 * file = none, broken JSON or a wrong shape = unreadable — never an error:
 * the exit code is the contract (FR-067).
 */
const SCHEMA = z.object({
  model: z.string().optional(),
  costUsd: z.number().optional(),
  turns: z.int().optional(),
  tokens: z
    .object({
      input: z.int().optional(),
      output: z.int().optional(),
      cacheRead: z.int().optional(),
      cacheCreated: z.int().optional(),
    })
    .optional(),
  detail: z.string().optional(),
});

export class FsRunResult implements RunResult {
  async read(path: string): Promise<RunResultReading> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
      return { kind: "unreadable", problem: `result file unreadable: ${String(error)}` };
    }

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      return {
        kind: "unreadable",
        problem: `result file is not JSON: ${(error as Error).message}`,
      };
    }

    const parsed = SCHEMA.safeParse(data);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.join(".") || "result file";
      return {
        kind: "unreadable",
        problem: `result file: ${where}: ${issue?.message ?? "invalid"}`,
      };
    }

    const { detail, ...usage } = parsed.data;
    return {
      kind: "reported",
      usage: reportedUsage(usage),
      ...(detail === undefined ? {} : { detail }),
    };
  }
}
