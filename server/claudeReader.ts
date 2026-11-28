import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ClaudeSyncData, PlanItem } from "../src/core/types.ts";

export function encodeClaudeProjectDir(repoPath: string): string {
  return path.resolve(repoPath).replace(/[:\\/ ]/g, "-");
}

async function findClaudeProjectDir(
  repoPath: string,
  claudeRoot: string = path.join(os.homedir(), ".claude", "projects"),
): Promise<string | null> {
  const expected = encodeClaudeProjectDir(repoPath).toLowerCase();
  try {
    const entries = await fs.readdir(claudeRoot, { withFileTypes: true });
    // Exact case-insensitive match first, then prefix match for suffixed dirs
    const exact = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === expected);
    if (exact) return path.join(claudeRoot, exact.name);
    return null;
  } catch {
    return null;
  }
}

export function extractTodosFromJsonl(jsonlTail: string): PlanItem[] {
  let latestTodos: PlanItem[] = [];
  const lines = jsonlTail.split(/\r?\n/);

  for (const line of lines) {
    if (!line.includes("TodoWrite") && !line.includes("TaskCreate")) continue;
    try {
      const obj = JSON.parse(line) as {
        message?: { content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }> };
      };
      const blocks = obj?.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (block?.type !== "tool_use") continue;
        if (block.name === "TodoWrite" && Array.isArray(block.input?.todos)) {
          const parsed: PlanItem[] = [];
          for (const t of block.input.todos as Array<{ content?: string; status?: string }>) {
            if (typeof t?.content === "string" && t.content.trim()) {
              parsed.push({
                text: t.content.trim(),
                done: t.status === "completed",
              });
            }
          }
          if (parsed.length > 0) latestTodos = parsed;
        } else if (block.name === "TaskCreate" && typeof block.input?.subject === "string") {
          const subject = block.input.subject.trim();
          if (subject && !latestTodos.some((item) => item.text === subject)) {
            latestTodos.push({ text: subject, done: false });
          }
        }
      }
    } catch {
      // ignore truncated first line of tail chunk
    }
  }

  return latestTodos;
}

export function extractFlagsFromMemoryMarkdown(markdown: string, sourceLabel: string): string[] {
  const flags: string[] = [];
  const lines = markdown.split(/\r?\n/);
  const flagPattern = /\b(blocker|blocked|flag|flagged|waiting on|decision needed|pending|action required)\b/i;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("---")) continue;
    // Skip anything that looks like a secret/token assignment
    if (/(api[_-]?key|secret|password|token)\s*[:=]/i.test(line)) continue;

    if (flagPattern.test(line)) {
      const cleaned = line
        .replace(/^[-*]\s*(\[[ xX]\]\s*)?/, "")
        .replace(/\*\*/g, "")
        .trim();
      if (cleaned.length >= 8 && cleaned.length <= 180) {
        flags.push(`[${sourceLabel}] ${cleaned}`);
      }
    }
  }
  return flags;
}

async function readTail(filePath: string, maxBytes = 160_000): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    if (length <= 0) return "";
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    return buf.toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function readClaudeProjectSync(
  repoPath: string,
  claudeRoot?: string,
): Promise<ClaudeSyncData> {
  const projectDir = await findClaudeProjectDir(repoPath, claudeRoot);
  if (!projectDir) {
    return {
      found: false,
      lastSessionAt: null,
      sessionTodos: [],
      memoryFlags: [],
      memoryCount: 0,
    };
  }

  let lastSessionAt: string | null = null;
  let sessionTodos: PlanItem[] = [];

  try {
    const entries = await fs.readdir(projectDir, { withFileTypes: true });
    const jsonlFiles = await Promise.all(
      entries
        .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
        .map(async (e) => {
          const full = path.join(projectDir, e.name);
          const stat = await fs.stat(full);
          return { full, mtimeMs: stat.mtimeMs };
        }),
    );
    jsonlFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const latest = jsonlFiles[0];
    if (latest) {
      lastSessionAt = new Date(latest.mtimeMs).toISOString();
      const tail = await readTail(latest.full);
      sessionTodos = extractTodosFromJsonl(tail);
    }
  } catch {
    // ignore unreadable session dir
  }

  const memoryFlags: string[] = [];
  let memoryCount = 0;
  let memoryIndex: string | null = null;

  try {
    const memDir = path.join(projectDir, "memory");
    try {
      const rawIndex = await fs.readFile(path.join(memDir, "MEMORY.md"), "utf8");
      memoryIndex = rawIndex.trim().slice(0, 4000) || null;
    } catch {
      memoryIndex = null;
    }

    const memEntries = await fs.readdir(memDir, { withFileTypes: true });
    const mdFiles = await Promise.all(
      memEntries
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .map(async (e) => {
          const full = path.join(memDir, e.name);
          const stat = await fs.stat(full);
          return { name: e.name, full, mtimeMs: stat.mtimeMs };
        }),
    );
    memoryCount = mdFiles.length;
    mdFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const seen = new Set<string>();
    for (const file of mdFiles.slice(0, 6)) {
      const content = await fs.readFile(file.full, "utf8");
      const label = file.name.replace(/\.md$/i, "").replace(/^project_/, "");
      for (const flag of extractFlagsFromMemoryMarkdown(content, label)) {
        if (!seen.has(flag) && memoryFlags.length < 6) {
          seen.add(flag);
          memoryFlags.push(flag);
        }
      }
    }
  } catch {
    // ignore missing memory dir
  }

  return {
    found: true,
    lastSessionAt,
    sessionTodos,
    memoryFlags,
    memoryCount,
    memoryIndex,
  };
}
