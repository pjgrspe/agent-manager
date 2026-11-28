import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAutoRecapStatus,
  classifyAttentionItems,
  computeGroundTruth,
  extractVerifyCommand,
  isProjectBlocked,
  matchesStateFilter,
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

  it("distinguishes true blockers from open decisions and routine tasks", () => {
    const res = classifyAttentionItems([
      "Phone in use by someone else: screen capture waits on it",
      "Decide: 05 F14a says slave ignores untrusted Master clock. Spec or code?",
      "Hours tracker in the Dev-Log is empty (budget 260 h)",
      "Device tests still pending: MOB-01 token refresh",
    ]);
    assert.deepEqual(res.blockers, ["Phone in use by someone else: screen capture waits on it"]);
    assert.deepEqual(res.decisions, ["Decide: 05 F14a says slave ignores untrusted Master clock. Spec or code?"]);
    assert.deepEqual(res.tasks, [
      "Hours tracker in the Dev-Log is empty (budget 260 h)",
      "Device tests still pending: MOB-01 token refresh",
    ]);
  });

  it("matches Blocked filter when a project has blockers even if state is Active", () => {
    const proj = {
      status: {
        state: "Active" as const,
        updated: "2026-11-27",
        verify: "Unknown" as const,
        recap: [],
        plan: [],
        blockers: ["Need API key"],
        hasStatusFile: true,
      },
    };
    assert.equal(isProjectBlocked(proj), true);
    assert.equal(matchesStateFilter(proj, "Blocked"), true);
    assert.equal(matchesStateFilter(proj, "Waiting on Review"), false);
  });

  it("derives ground-truth state from GitHub PRs, CI failures, and commit-SHA verify staleness", () => {
    const baseStatus = {
      state: "Idle" as const,
      updated: "2026-11-20",
      verify: "Unknown" as const,
      recap: [],
      plan: [],
      blockers: [],
      hasStatusFile: true,
    };
    const baseGit = {
      isGitRepo: true,
      branch: "main",
      headSha: "abc1234",
      headTimestamp: "2026-11-10T10:00:00Z",
      dirtyCount: 0,
      ahead: 0,
      behind: 0,
      recentCommits: [{ hash: "abc1234", date: "2026-11-27", subject: "Ship feature" }],
    };

    // Open PR -> Waiting on Review + stale verify when HEAD moved past verified SHA
    const prTruth = computeGroundTruth({
      exists: true,
      status: baseStatus,
      git: baseGit,
      github: {
        available: true,
        repoSlug: "org/repo",
        fetchedAt: "2026-11-28T00:00:00Z",
        mergedPrs: [],
        openIssues: [],
        milestones: [],
        remoteCommits: [],
        openPrs: [
          {
            number: 42,
            title: "Add auth",
            url: "https://github.com/org/repo/pull/42",
            isDraft: false,
            reviewDecision: "REVIEW_REQUIRED",
            branch: "feat/auth",
            ciStatus: "Pass",
          },
        ],
      },
      verifyRecord: { headSha: "old9999", passed: true, ranAt: "2026-11-26T00:00:00Z" },
      nowMs: Date.parse("2026-11-28T00:00:00Z"),
    });
    assert.equal(prTruth.state, "Waiting on Review");
    assert.equal(prTruth.source, "github");
    assert.equal(prTruth.verifyHealth, "Stale");
    assert.equal(prTruth.statusFileStale, true);

    // Failing CI -> Blocked
    const ciFailTruth = computeGroundTruth({
      exists: true,
      status: baseStatus,
      git: baseGit,
      github: {
        available: true,
        repoSlug: "org/repo",
        fetchedAt: "2026-11-28T00:00:00Z",
        mergedPrs: [],
        openIssues: [],
        milestones: [],
        remoteCommits: [],
        openPrs: [
          {
            number: 42,
            title: "Add auth",
            url: "https://github.com/org/repo/pull/42",
            isDraft: false,
            reviewDecision: "",
            branch: "feat/auth",
            ciStatus: "Fail",
          },
        ],
      },
      nowMs: Date.parse("2026-11-28T00:00:00Z"),
    });
    assert.equal(ciFailTruth.state, "Blocked");
    assert.equal(ciFailTruth.verifyHealth, "Fail");
    assert.match(ciFailTruth.reason, /CI failing on PR #42/);
  });
});
