import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  encodeClaudeProjectDir,
  extractFlagsFromMemoryMarkdown,
  extractTodosFromJsonl,
  readClaudeProjectSync,
} from "./claudeReader.ts";

describe("claudeReader", () => {
  it("extracts latest TodoWrite items from a Claude Code JSONL session", () => {
    const line1 = JSON.stringify({
      message: {
        content: [
          {
            type: "tool_use",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "Implement OCPP rate limit", status: "completed" },
                { content: "Guard request.json() in route handlers", status: "in_progress" },
              ],
            },
          },
        ],
      },
    });
    const todos = extractTodosFromJsonl(line1);
    assert.deepEqual(todos, [
      { text: "Implement OCPP rate limit", done: true },
      { text: "Guard request.json() in route handlers", done: false },
    ]);
  });

  it("extracts blocker/flag lines from memory markdown while skipping secrets", () => {
    const md = `# Review
- BLOCKER: Need staging SMTP credentials from DevOps
- API_KEY=supersecretvalue123
- Pending: confirm legal markdown allowlist
`;
    const flags = extractFlagsFromMemoryMarkdown(md, "security");
    assert.deepEqual(flags, [
      "[security] BLOCKER: Need staging SMTP credentials from DevOps",
      "[security] Pending: confirm legal markdown allowlist",
    ]);
  });

  it("reads session todos and memory flags for a matching Claude project folder", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "citadel-claude-"));
    try {
      const fakeRepo = path.join(tmp, "MyApp");
      const claudeProjects = path.join(tmp, "claude-projects");
      const encoded = encodeClaudeProjectDir(fakeRepo);
      const projDir = path.join(claudeProjects, encoded);
      await fs.mkdir(path.join(projDir, "memory"), { recursive: true });
      await fs.writeFile(
        path.join(projDir, "session-1.jsonl"),
        JSON.stringify({
          message: {
            content: [
              {
                type: "tool_use",
                name: "TodoWrite",
                input: { todos: [{ content: "Ship v1", status: "pending" }] },
              },
            ],
          },
        }),
        "utf8",
      );
      await fs.writeFile(
        path.join(projDir, "memory", "project_launch.md"),
        "- Blocked: waiting on DNS cutover\n",
        "utf8",
      );

      const sync = await readClaudeProjectSync(fakeRepo, claudeProjects);
      assert.equal(sync.found, true);
      assert.equal(sync.memoryCount, 1);
      assert.deepEqual(sync.sessionTodos, [{ text: "Ship v1", done: false }]);
      assert.deepEqual(sync.memoryFlags, ["[launch] Blocked: waiting on DNS cutover"]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
