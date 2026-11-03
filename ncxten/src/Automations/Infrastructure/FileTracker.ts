import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Tracker } from "~/Automations/Application/AutomationsPorts.ts";
import type { Finding } from "~/Automations/Domain/ConsumedInput.ts";
import { type AutomationName, revision, subjectId } from "~/Automations/Domain/Ids.ts";

/**
 * The file tracker (`tracker: file`, contracts/policy.md): findings from one
 * YAML file in the project state dir — the DoD run's seed source until 003
 * brings GitHub (002 quickstart). Same `Tracker` port as the stub; the
 * new/old judgment stays the domain's (`Pass`), never the tracker's. A
 * missing file is no findings; a broken one is a broken installation and
 * throws with its path.
 */
const SCHEMA = z.strictObject({
  findings: z.array(
    z.strictObject({
      automation: z.string(),
      subject: z.string(),
      revision: z.string(),
    }),
  ),
});

export class FileTracker implements Tracker {
  constructor(private readonly path: string) {}

  async findings(automation: AutomationName): Promise<readonly Finding[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const parsed = SCHEMA.safeParse(Bun.YAML.parse(raw));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `findings file ${this.path}: ${issue?.path.join(".") || "findings"}: ${issue?.message ?? "invalid"}`,
      );
    }

    return parsed.data.findings
      .filter((finding) => finding.automation === automation)
      .map((finding) => ({
        subject: subjectId(finding.subject),
        revision: revision(finding.revision),
      }));
  }
}
