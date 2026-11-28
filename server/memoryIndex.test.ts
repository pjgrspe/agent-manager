import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ManagedProject } from "../src/core/types.ts";
import { buildPmDigest, buildSafeFtsQuery, CitadelMemoryStore } from "./memoryIndex.ts";

function makeSampleProject(): ManagedProject {
  const today = new Date().toISOString().slice(0, 10);
  return {
    id: "proj-lora",
    name: "LoRA Firmware",
    path: "C:\\repos\\lora",
    sourceType: "local",
    githubRepo: "pjgrspe/lora",
    exists: true,
    status: {
      state: "Blocked",
      updated: today,
      verify: "Pass",
      recap: ["Fixed telemetry epoch bug"],
      plan: [{ text: "Commissioning protocol v2", done: false }],
      blockers: ["Waiting on device vendor reply for PR #7"],
      hasStatusFile: false,
    },
    git: {
      isGitRepo: true,
      branch: "main",
      headSha: "abc1234",
      headTimestamp: new Date().toISOString(),
      dirtyCount: 0,
      ahead: 0,
      behind: 0,
      recentCommits: [{ hash: "abc1234", date: today, subject: "feat: add LoRA commissioning handshake" }],
    },
    antiSlop: {
      hasAgentsMd: true,
      hasClaudeMd: false,
      hasSkill: true,
      hasLearnings: true,
      verifyCmd: "npm test",
      skillCount: 1,
    },
    agentSessions: [
      {
        agent: "Antigravity",
        lastActiveAt: new Date().toISOString(),
        summary: "Reviewed commissioning spec and power budget",
        tasks: [{ text: "Validate sleep current draw", done: false }],
      },
    ],
    github: {
      available: true,
      repoSlug: "pjgrspe/lora",
      openPrs: [
        {
          number: 7,
          title: "Commissioning details update",
          url: "https://github.com/pjgrspe/lora/pull/7",
          isDraft: false,
          reviewDecision: "REVIEW_REQUIRED",
          branch: "commissioning",
          ciStatus: "Pass",
        },
      ],
      mergedPrs: [
        {
          number: 6,
          title: "Fix telemetry epoch bump",
          url: "https://github.com/pjgrspe/lora/pull/6",
          mergedAt: new Date().toISOString(),
        },
      ],
      openIssues: [
        {
          number: 12,
          title: "Investigate sleep mode wake latency",
          url: "https://github.com/pjgrspe/lora/issues/12",
          labels: ["firmware", "power"],
        },
      ],
      milestones: [
        {
          title: "Field Pilot v1",
          openIssues: 2,
          closedIssues: 8,
          dueOn: null,
          url: "https://github.com/pjgrspe/lora/milestone/1",
        },
      ],
      remoteCommits: [],
      fetchedAt: new Date().toISOString(),
    },
    truth: {
      state: "Blocked",
      reason: "Waiting on device vendor reply for PR #7",
      source: "github",
      verifyHealth: "Pass",
      verifySha: "abc1234",
      verifyAt: new Date().toISOString(),
      statusFileStale: false,
    },
  };
}

describe("CitadelMemoryStore (SQLite FTS5 + Digests)", () => {
  it("sanitizes raw search queries into safe FTS5 prefix expressions", () => {
    assert.equal(buildSafeFtsQuery("LoRA commissioning!"), '"lora"* AND "commissioning"*');
    assert.equal(buildSafeFtsQuery('  #7: "quoted" '), '"quoted"*');
    assert.equal(buildSafeFtsQuery('  #7: "" ! '), "");
  });

  it("indexes commits, GitHub PRs/issues/milestones, and agent sessions with FTS5 search", () => {
    const store = new CitadelMemoryStore(":memory:");
    try {
      const sample = makeSampleProject();
      const { indexed } = store.syncProjects([sample], true);
      assert.ok(indexed >= 7);

      const hits = store.search("commissioning");
      assert.ok(hits.length >= 2);
      assert.ok(hits.some((h) => h.source === "commit" || h.source === "pr"));

      const issueHits = store.search("sleep latency", { source: "issue" });
      assert.equal(issueHits.length, 1);
      assert.equal(issueHits[0]?.projectName, "LoRA Firmware");

      const stats = store.getStats();
      assert.equal(stats.totalDocs, indexed);
      assert.ok(stats.bySource.agent_session === 1);
    } finally {
      store.close();
    }
  });

  it("generates and persists scheduled daily & weekly PM digests without duplicates on same day", () => {
    const store = new CitadelMemoryStore(":memory:");
    try {
      const sample = makeSampleProject();
      const digest = buildPmDigest([sample], "daily");
      assert.equal(digest.stats.commitsCount, 1);
      assert.equal(digest.stats.mergedPrsCount, 1);
      assert.equal(digest.stats.blockedCount, 1);
      assert.ok(digest.markdown.includes("LoRA Firmware"));

      store.recordScheduledDigestsIfDue([sample]);
      store.recordScheduledDigestsIfDue([sample]); // should not duplicate
      const list = store.listDigests(10);
      assert.equal(list.length, 2); // 1 daily + 1 weekly
    } finally {
      store.close();
    }
  });
});
