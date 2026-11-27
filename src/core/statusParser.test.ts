import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAutoRecapStatus,
  extractVerifyCommand,
  parseStatusMarkdown,
  serializeStatusMarkdown,
} from "./statusParser.ts";

describe("statusParser", () => {
  it("parses a populated .agents/status.md file accurately", () => {
    const md = `# Project Status
- **State:** \`Waiting on Review\` <!-- comment -->
- **Updated:** 2026-11-27
- **Verify:** \`Pass\`

## Last Recap
- Shipped OAuth token refresh
- Added regression tests

## Current Plan (Next 3)
- [x] Wire refresh endpoint
- [ ] Add rate limiter

## Blockers / Decisions Needed
- Decide staging domain
`;
    const parsed = parseStatusMarkdown(md);
    assert.equal(parsed.state, "Waiting on Review");
    assert.equal(parsed.updated, "2026-11-27");
    assert.equal(parsed.verify, "Pass");
    assert.deepEqual(parsed.recap, ["Shipped OAuth token refresh", "Added regression tests"]);
    assert.deepEqual(parsed.plan, [
      { done: true, text: "Wire refresh endpoint" },
      { done: false, text: "Add rate limiter" },
    ]);
    assert.deepEqual(parsed.blockers, ["Decide staging domain"]);
  });

  it("round-trips serialized status markdown cleanly", () => {
    const original = {
      state: "Blocked" as const,
      updated: "2026-11-27",
      verify: "Fail" as const,
      recap: ["Migrated DB schema"],
      plan: [{ done: false, text: "Fix failing integration test" }],
      blockers: ["Need staging DB password"],
    };
    const serialized = serializeStatusMarkdown(original);
    const parsed = parseStatusMarkdown(serialized);
    assert.deepEqual(parsed, { ...original, hasStatusFile: true });
  });

  it("extracts verify command from project-learnings.md", () => {
    const md = `- **Verify Cmd:** \`npm run verify\``;
    assert.equal(extractVerifyCommand(md), "npm run verify");
    assert.equal(extractVerifyCommand(`- **Verify Cmd:** _(exact quiet single command)_`), null);
  });

  it("auto-builds git-backed recap while preserving plan, blockers, and Waiting on Review", () => {
    const existing = {
      state: "Waiting on Review" as const,
      updated: "2026-11-20",
      verify: "Pass" as const,
      recap: ["Old recap"],
      plan: [{ done: false, text: "Ship v2" }],
      blockers: [],
      hasStatusFile: true,
    };
    const next = buildAutoRecapStatus(
      existing,
      {
        isGitRepo: true,
        branch: "main",
        dirtyCount: 2,
        recentCommits: [{ hash: "abc1234", date: "2026-11-27", subject: "Add auth guard" }],
      },
      "2026-11-27",
    );
    assert.equal(next.state, "Waiting on Review");
    assert.equal(next.verify, "Pass");
    assert.deepEqual(next.plan, existing.plan);
    assert.equal(next.recap[0], "WIP on main: 2 uncommitted file(s)");
    assert.equal(next.recap[1], "[2026-11-27] Add auth guard (abc1234)");
  });
});
