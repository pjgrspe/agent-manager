import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentSessionSignal, PlanItem } from "../src/core/types.ts";

function parseChecklistFromMarkdown(md: string): PlanItem[] {
  const items: PlanItem[] = [];
  for (const rawLine of md.split(/\r?\n/)) {
    const m = rawLine.trim().match(/^-\s*\[([ xX/])\]\s*(.+)$/);
    if (m && m[2]) {
      items.push({
        done: m[1]?.toLowerCase() === "x",
        text: m[2].trim(),
      });
    }
  }
  return items.slice(0, 10);
}

// Passive read-only observer of recent Antigravity brain artifacts (~/.gemini/antigravity/brain/*)
export async function readAntigravitySessionForRepo(
  repoName: string,
  brainRoot: string = path.join(os.homedir(), ".gemini", "antigravity", "brain"),
): Promise<AgentSessionSignal | null> {
  const needle = repoName.trim().toLowerCase();
  if (needle.length < 3) return null;

  try {
    const entries = await fs.readdir(brainRoot, { withFileTypes: true });
    const dirs = await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          const full = path.join(brainRoot, e.name);
          const stat = await fs.stat(full);
          return { full, mtimeMs: stat.mtimeMs };
        }),
    );

    // Check only the 8 most recently touched conversations for speed
    dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const dir of dirs.slice(0, 8)) {
      for (const fileName of ["task.md", "implementation_plan.md", "walkthrough.md"]) {
        const filePath = path.join(dir.full, fileName);
        try {
          const content = await fs.readFile(filePath, "utf8");
          if (content.toLowerCase().includes(needle)) {
            const tasks = parseChecklistFromMarkdown(content);
            const firstHeading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
            return {
              agent: "Antigravity",
              lastActiveAt: new Date(dir.mtimeMs).toISOString(),
              summary: firstHeading ? `${firstHeading} (${fileName})` : `Active artifact: ${fileName}`,
              tasks,
            };
          }
        } catch {
          // file not present in this conversation
        }
      }
    }
  } catch {
    // brain directory unavailable
  }

  return null;
}
