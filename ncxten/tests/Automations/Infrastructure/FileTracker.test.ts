import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { automationName, revision, subjectId } from "~/Automations/Domain/Ids.ts";
import { FileTracker } from "~/Automations/Infrastructure/FileTracker.ts";

const SEED = `findings:
  - automation: smoke
    subject: spike-42
    revision: r1
  - automation: board-walker
    subject: ticket-7
    revision: r2
`;

let tempDirs: string[] = [];

async function tracker(content: string | undefined): Promise<FileTracker> {
  const dir = await mkdtemp(join(tmpdir(), "ncxten-tracker-"));
  tempDirs.push(dir);
  const path = join(dir, "findings.yaml");
  if (content !== undefined) await writeFile(path, content);
  return new FileTracker(path);
}

afterEach(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("FileTracker (tracker: file)", () => {
  test("answers the automation's findings from the seed file", async () => {
    const source = await tracker(SEED);

    const findings = await source.findings(automationName("smoke"));

    expect(findings).toEqual([{ subject: subjectId("spike-42"), revision: revision("r1") }]);
  });

  test("an automation without findings gets none — never someone else's", async () => {
    const source = await tracker(SEED);

    expect(await source.findings(automationName("gardener"))).toEqual([]);
  });

  test("a missing file is no findings — the quiet default", async () => {
    const source = await tracker(undefined);

    expect(await source.findings(automationName("smoke"))).toEqual([]);
  });

  test("a broken seed file throws with its path — a broken installation, not a quiet idle", async () => {
    const source = await tracker("findings:\n  - automation: smoke\n");

    expect(source.findings(automationName("smoke"))).rejects.toThrow("findings file");
  });
});
