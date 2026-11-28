import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ManagedProject,
  MemoryIndexStats,
  MemorySearchHit,
  MemorySourceKind,
  PmDigestBrief,
  PmDigestEntry,
  PmDigestItem,
  PmSuggestion,
} from "../src/core/types.ts";

interface DocRecord {
  docKey: string;
  projectId: string;
  projectName: string;
  source: MemorySourceKind;
  title: string;
  body: string;
  url: string | null;
  occurredAt: string | null;
}

const DEFAULT_DB_PATH = path.resolve(process.cwd(), ".data", "citadel-memory.sqlite");

export class CitadelMemoryStore {
  private db: DatabaseSync;
  private lastSyncAt = 0;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS memory_docs (
        doc_key TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        project_name TEXT NOT NULL,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        url TEXT,
        occurred_at TEXT,
        indexed_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        doc_key UNINDEXED,
        project_id UNINDEXED,
        project_name,
        source,
        title,
        body,
        tokenize='porter unicode61'
      );
      CREATE TABLE IF NOT EXISTS digests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        period TEXT NOT NULL,
        created_at TEXT NOT NULL,
        headline TEXT NOT NULL,
        stats_json TEXT NOT NULL,
        markdown TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  syncProjects(projects: ManagedProject[], force = false): { indexed: number } {
    const now = Date.now();
    if (!force && now - this.lastSyncAt < 30_000) {
      return { indexed: 0 };
    }
    this.lastSyncAt = now;

    const docs = collectDocs(projects);
    if (docs.length === 0) return { indexed: 0 };

    const nowIso = new Date(now).toISOString();
    const upsertDoc = this.db.prepare(`
      INSERT INTO memory_docs (doc_key, project_id, project_name, source, title, body, url, occurred_at, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(doc_key) DO UPDATE SET
        project_id = excluded.project_id,
        project_name = excluded.project_name,
        source = excluded.source,
        title = excluded.title,
        body = excluded.body,
        url = excluded.url,
        occurred_at = excluded.occurred_at,
        indexed_at = excluded.indexed_at
    `);
    const deleteFts = this.db.prepare(`DELETE FROM memory_fts WHERE doc_key = ?`);
    const insertFts = this.db.prepare(`
      INSERT INTO memory_fts (doc_key, project_id, project_name, source, title, body)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.db.exec("BEGIN");
    try {
      for (const d of docs) {
        upsertDoc.run(
          d.docKey,
          d.projectId,
          d.projectName,
          d.source,
          d.title,
          d.body,
          d.url,
          d.occurredAt,
          nowIso,
        );
        deleteFts.run(d.docKey);
        insertFts.run(d.docKey, d.projectId, d.projectName, d.source, d.title, d.body);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    return { indexed: docs.length };
  }

  search(
    rawQuery: string,
    opts?: { projectId?: string; source?: string; limit?: number },
  ): MemorySearchHit[] {
    const limit = Math.min(Math.max(opts?.limit ?? 30, 1), 100);
    const ftsQuery = buildSafeFtsQuery(rawQuery);

    if (!ftsQuery) {
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (opts?.projectId) {
        clauses.push("project_id = ?");
        params.push(opts.projectId);
      }
      if (opts?.source) {
        clauses.push("source = ?");
        params.push(opts.source);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      params.push(limit);

      const rows = this.db
        .prepare(
          `SELECT doc_key, project_id, project_name, source, title, body, url, occurred_at
           FROM memory_docs ${where}
           ORDER BY COALESCE(occurred_at, indexed_at) DESC
           LIMIT ?`,
        )
        .all(...params) as Array<Record<string, unknown>>;

      return rows.map((r) => ({
        docKey: String(r.doc_key),
        projectId: String(r.project_id),
        projectName: String(r.project_name),
        source: String(r.source) as MemorySourceKind,
        title: String(r.title),
        snippet: String(r.body).slice(0, 220),
        url: r.url ? String(r.url) : null,
        occurredAt: r.occurred_at ? String(r.occurred_at) : null,
      }));
    }

    const clauses = ["memory_fts MATCH ?"];
    const params: Array<string | number> = [ftsQuery];
    if (opts?.projectId) {
      clauses.push("d.project_id = ?");
      params.push(opts.projectId);
    }
    if (opts?.source) {
      clauses.push("d.source = ?");
      params.push(opts.source);
    }
    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT d.doc_key, d.project_id, d.project_name, d.source, d.title,
                snippet(memory_fts, 5, '«', '»', '…', 24) AS snip,
                d.body, d.url, d.occurred_at
         FROM memory_fts
         JOIN memory_docs d ON d.doc_key = memory_fts.doc_key
         WHERE ${clauses.join(" AND ")}
         ORDER BY bm25(memory_fts)
         LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      docKey: String(r.doc_key),
      projectId: String(r.project_id),
      projectName: String(r.project_name),
      source: String(r.source) as MemorySourceKind,
      title: String(r.title),
      snippet: String(r.snip || r.body || "").slice(0, 260),
      url: r.url ? String(r.url) : null,
      occurredAt: r.occurred_at ? String(r.occurred_at) : null,
    }));
  }

  getStats(): MemoryIndexStats {
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt, MAX(indexed_at) AS last_at FROM memory_docs`)
      .get() as Record<string, unknown>;
    const bySourceRows = this.db
      .prepare(`SELECT source, COUNT(*) AS cnt FROM memory_docs GROUP BY source`)
      .all() as Array<Record<string, unknown>>;

    const bySource: Record<string, number> = {};
    for (const r of bySourceRows) {
      bySource[String(r.source)] = Number(r.cnt ?? 0);
    }

    return {
      totalDocs: Number(totalRow?.cnt ?? 0),
      bySource,
      lastIndexedAt: totalRow?.last_at ? String(totalRow.last_at) : null,
    };
  }

  saveDigest(entry: PmDigestEntry): PmDigestEntry {
    const payload = JSON.stringify({ stats: entry.stats, brief: entry.brief });
    const res = this.db
      .prepare(
        `INSERT INTO digests (period, created_at, headline, stats_json, markdown)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        entry.period,
        entry.createdAt,
        entry.headline,
        payload,
        entry.markdown,
      );
    return { ...entry, id: Number(res.lastInsertRowid) };
  }

  listDigests(limit = 14): PmDigestEntry[] {
    const rows = this.db
      .prepare(
        `SELECT id, period, created_at, headline, stats_json, markdown
         FROM digests
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;

    return rows.map((r) => {
      const parsed = JSON.parse(String(r.stats_json)) as
        | { stats: PmDigestEntry["stats"]; brief?: PmDigestBrief }
        | PmDigestEntry["stats"];
      const hasEnvelope = "stats" in parsed && typeof parsed.stats === "object";
      return {
        id: Number(r.id),
        period: (r.period === "weekly" ? "weekly" : "daily") as "daily" | "weekly",
        createdAt: String(r.created_at),
        headline: String(r.headline),
        stats: hasEnvelope ? parsed.stats : (parsed as PmDigestEntry["stats"]),
        brief: hasEnvelope ? parsed.brief : undefined,
        markdown: String(r.markdown),
      };
    });
  }

  recordScheduledDigestsIfDue(projects: ManagedProject[]): void {
    if (projects.length === 0) return;
    const today = new Date().toISOString().slice(0, 10);

    const lastDaily = this.db
      .prepare(`SELECT created_at FROM digests WHERE period = 'daily' ORDER BY created_at DESC LIMIT 1`)
      .get() as Record<string, unknown> | undefined;
    if (!lastDaily || !String(lastDaily.created_at).startsWith(today)) {
      this.saveDigest(buildPmDigest(projects, "daily"));
    }

    const lastWeekly = this.db
      .prepare(`SELECT created_at FROM digests WHERE period = 'weekly' ORDER BY created_at DESC LIMIT 1`)
      .get() as Record<string, unknown> | undefined;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const weeklyDue =
      !lastWeekly || Date.now() - Date.parse(String(lastWeekly.created_at)) >= sevenDaysMs;
    if (weeklyDue) {
      this.saveDigest(buildPmDigest(projects, "weekly"));
    }
  }
}

export function buildSafeFtsQuery(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .replace(/[^a-z0-9_.\s/-]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"*`).join(" AND ");
}

function collectDocs(projects: ManagedProject[]): DocRecord[] {
  const docs: DocRecord[] = [];
  for (const p of projects) {
    const repoUrl = p.githubRepo ? `https://github.com/${p.githubRepo}` : null;

    for (const c of p.git.recentCommits.slice(0, 15)) {
      docs.push({
        docKey: `${p.id}:commit:${c.hash}`,
        projectId: p.id,
        projectName: p.name,
        source: "commit",
        title: `${c.hash} ${c.subject}`,
        body: `${p.name} (${p.git.branch}): ${c.subject}`,
        url: repoUrl ? `${repoUrl}/commit/${c.hash}` : null,
        occurredAt: c.date,
      });
    }

    for (const pr of p.github?.openPrs ?? []) {
      docs.push({
        docKey: `${p.id}:pr:${pr.number}`,
        projectId: p.id,
        projectName: p.name,
        source: "pr",
        title: `PR #${pr.number}: ${pr.title}`,
        body: `Branch ${pr.branch} · CI ${pr.ciStatus} · ${pr.isDraft ? "Draft" : "Open"} · ${pr.title}`,
        url: pr.url,
        occurredAt: p.github?.fetchedAt ?? null,
      });
    }

    for (const pr of p.github?.mergedPrs ?? []) {
      docs.push({
        docKey: `${p.id}:merged:${pr.number}`,
        projectId: p.id,
        projectName: p.name,
        source: "merged_pr",
        title: `Merged PR #${pr.number}: ${pr.title}`,
        body: `Shipped in ${p.name} on ${pr.mergedAt.slice(0, 10)}: ${pr.title}`,
        url: pr.url,
        occurredAt: pr.mergedAt,
      });
    }

    for (const issue of p.github?.openIssues ?? []) {
      docs.push({
        docKey: `${p.id}:issue:${issue.number}`,
        projectId: p.id,
        projectName: p.name,
        source: "issue",
        title: `Issue #${issue.number}: ${issue.title}`,
        body: `${issue.title}${issue.labels.length ? ` [${issue.labels.join(", ")}]` : ""}`,
        url: issue.url,
        occurredAt: p.github?.fetchedAt ?? null,
      });
    }

    for (const m of p.github?.milestones ?? []) {
      docs.push({
        docKey: `${p.id}:milestone:${m.title}`,
        projectId: p.id,
        projectName: p.name,
        source: "milestone",
        title: `Milestone: ${m.title}`,
        body: `${m.closedIssues}/${m.openIssues + m.closedIssues} closed${m.dueOn ? ` · Due ${m.dueOn.slice(0, 10)}` : ""}`,
        url: m.url,
        occurredAt: m.dueOn,
      });
    }

    for (const sess of p.agentSessions) {
      const taskText = sess.tasks.map((t) => `${t.done ? "[x]" : "[ ]"} ${t.text}`).join(" | ");
      docs.push({
        docKey: `${p.id}:agent:${sess.agent}`,
        projectId: p.id,
        projectName: p.name,
        source: "agent_session",
        title: `${sess.agent} session (${p.name})`,
        body: [sess.summary, taskText].filter(Boolean).join(" — "),
        url: null,
        occurredAt: sess.lastActiveAt,
      });
    }

    if (p.claudeSync?.memoryIndex) {
      docs.push({
        docKey: `${p.id}:claude_memory`,
        projectId: p.id,
        projectName: p.name,
        source: "claude_memory",
        title: `Claude MEMORY.md (${p.name})`,
        body: p.claudeSync.memoryIndex.slice(0, 4000),
        url: null,
        occurredAt: p.claudeSync.lastSessionAt,
      });
    }

    p.status.blockers.forEach((b, idx) => {
      docs.push({
        docKey: `${p.id}:blocker:${idx}`,
        projectId: p.id,
        projectName: p.name,
        source: "blocker",
        title: `Blocker in ${p.name}`,
        body: b,
        url: repoUrl,
        occurredAt: p.status.updated || null,
      });
    });

    p.status.plan.forEach((item, idx) => {
      docs.push({
        docKey: `${p.id}:plan:${idx}`,
        projectId: p.id,
        projectName: p.name,
        source: "plan",
        title: `${item.done ? "Done" : "Planned"}: ${item.text}`,
        body: `${p.name} milestone: ${item.text}`,
        url: repoUrl,
        occurredAt: p.status.updated || null,
      });
    });
  }
  return docs;
}

export function buildPmDigest(
  projects: ManagedProject[],
  period: "daily" | "weekly",
): PmDigestEntry {
  const now = new Date();
  const windowDays = period === "daily" ? 1 : 7;
  const cutoffDate = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  let commitsCount = 0;
  let mergedPrsCount = 0;
  let openPrsCount = 0;
  let openIssuesCount = 0;
  let blockedCount = 0;
  let activeAgentsCount = 0;

  const shippedLines: string[] = [];
  const attentionLines: string[] = [];
  const agentLines: string[] = [];

  const suggestions: PmSuggestion[] = [];
  const shipped: PmDigestItem[] = [];
  const needsAttention: PmDigestItem[] = [];
  const plannedWork: PmDigestItem[] = [];
  const agentUpdates: PmDigestItem[] = [];

  for (const p of projects) {
    const repoUrl = p.githubRepo ? `https://github.com/${p.githubRepo}` : null;
    const recentCommits = p.git.recentCommits.filter((c) => c.date >= cutoffDate);
    const recentMerged = (p.github?.mergedPrs ?? []).filter(
      (pr) => pr.mergedAt.slice(0, 10) >= cutoffDate,
    );
    const openPrs = p.github?.openPrs ?? [];
    const openIssues = p.github?.openIssues ?? [];
    const openMilestones = p.github?.milestones ?? [];
    const nextPlanItems = p.status.plan.filter((item) => !item.done);

    commitsCount += recentCommits.length;
    mergedPrsCount += recentMerged.length;
    openPrsCount += openPrs.length;
    openIssuesCount += openIssues.length;

    if (p.status.state === "Blocked" || p.status.blockers.length > 0) {
      blockedCount += 1;
      const reason = p.status.blockers[0] ?? p.truth.reason;
      attentionLines.push(`- **${p.name}** (Needs decision): ${reason}`);
      needsAttention.push({
        projectId: p.id,
        projectName: p.name,
        group: p.group,
        summary: reason,
        detail: "Needs your decision",
        url: repoUrl,
      });
      suggestions.push({
        priority: "high",
        projectId: p.id,
        projectName: p.name,
        action: `Unblock ${p.name}`,
        reason,
      });
    } else if (openPrs.length > 0) {
      const topPr = openPrs[0]!;
      attentionLines.push(
        `- **${p.name}** (${openPrs.length} open PR${openPrs.length > 1 ? "s" : ""}): #${topPr.number} ${topPr.title}`,
      );
      needsAttention.push({
        projectId: p.id,
        projectName: p.name,
        group: p.group,
        summary: `PR #${topPr.number}: ${topPr.title}`,
        detail:
          openPrs.length > 1
            ? `${openPrs.length} pull requests waiting for review`
            : "Waiting for review",
        url: topPr.url,
      });
      suggestions.push({
        priority: topPr.ciStatus === "Fail" ? "high" : "medium",
        projectId: p.id,
        projectName: p.name,
        action:
          topPr.ciStatus === "Fail"
            ? `Check failing checks on ${p.name} PR #${topPr.number}`
            : `Review ${openPrs.length} open PR${openPrs.length > 1 ? "s" : ""} in ${p.name}`,
        reason: topPr.title,
      });
    }

    if (recentMerged.length > 0) {
      shippedLines.push(
        `- **${p.name}**: ${recentMerged.map((m) => `PR #${m.number} ${m.title}`).join("; ")}`,
      );
      for (const m of recentMerged.slice(0, 3)) {
        shipped.push({
          projectId: p.id,
          projectName: p.name,
          group: p.group,
          summary: m.title,
          detail: `Merged PR #${m.number} · ${m.mergedAt.slice(0, 10)}`,
          url: m.url,
        });
      }
    } else if (recentCommits.length > 0) {
      shippedLines.push(
        `- **${p.name}** (${recentCommits.length} update${recentCommits.length > 1 ? "s" : ""}): ${recentCommits[0]!.subject}`,
      );
      shipped.push({
        projectId: p.id,
        projectName: p.name,
        group: p.group,
        summary: recentCommits[0]!.subject,
        detail: `${recentCommits.length} update${recentCommits.length > 1 ? "s" : ""} in this period`,
        url: repoUrl ? `${repoUrl}/commit/${recentCommits[0]!.hash}` : null,
      });
    }

    if (openMilestones.length > 0) {
      const m = openMilestones[0]!;
      const total = m.openIssues + m.closedIssues;
      const pct = total > 0 ? Math.round((m.closedIssues / total) * 100) : 0;
      plannedWork.push({
        projectId: p.id,
        projectName: p.name,
        group: p.group,
        summary: m.title,
        detail: `${m.closedIssues}/${total} done (${pct}%)${m.dueOn ? ` · Due ${m.dueOn.slice(0, 10)}` : ""}`,
        url: m.url,
      });
    } else if (nextPlanItems.length > 0) {
      plannedWork.push({
        projectId: p.id,
        projectName: p.name,
        group: p.group,
        summary: nextPlanItems[0]!.text,
        detail:
          nextPlanItems.length > 1
            ? `+ ${nextPlanItems.length - 1} more planned goal${nextPlanItems.length > 2 ? "s" : ""}`
            : "Next planned goal",
        url: repoUrl,
      });
    } else if (openIssues.length > 0) {
      plannedWork.push({
        projectId: p.id,
        projectName: p.name,
        group: p.group,
        summary: `#${openIssues[0]!.number} ${openIssues[0]!.title}`,
        detail: `${openIssues.length} open GitHub issue${openIssues.length > 1 ? "s" : ""}`,
        url: openIssues[0]!.url,
      });
    }

    if (p.agentSessions.length > 0) {
      activeAgentsCount += p.agentSessions.length;
      for (const s of p.agentSessions) {
        const nextTask = s.tasks.find((t) => !t.done)?.text;
        const summary = nextTask ?? s.summary;
        agentLines.push(`- **${p.name}** (${s.agent}): ${summary}`);
        agentUpdates.push({
          projectId: p.id,
          projectName: p.name,
          group: p.group,
          summary,
          detail: `${s.agent}${s.lastActiveAt ? ` · ${s.lastActiveAt.slice(0, 10)}` : ""}`,
          url: null,
        });
      }
    }
  }

  if (suggestions.length === 0 && plannedWork.length > 0) {
    const first = plannedWork[0]!;
    suggestions.push({
      priority: "info",
      projectId: first.projectId,
      projectName: first.projectName,
      action: `Focus next on ${first.projectName}`,
      reason: first.summary,
    });
  }

  suggestions.sort((a, b) => {
    const rank = { high: 0, medium: 1, info: 2 };
    return rank[a.priority] - rank[b.priority];
  });

  const label = period === "daily" ? "Daily" : "Weekly";
  const headline =
    blockedCount > 0
      ? `${blockedCount} decision${blockedCount > 1 ? "s" : ""} needed · ${mergedPrsCount} PRs shipped · ${commitsCount} updates`
      : openPrsCount > 0
        ? `${openPrsCount} PR${openPrsCount > 1 ? "s" : ""} ready for review · ${mergedPrsCount} shipped · ${commitsCount} updates`
        : `${mergedPrsCount} PRs shipped · ${commitsCount} updates across ${projects.length} projects`;

  const brief: PmDigestBrief = {
    suggestions: suggestions.slice(0, 5),
    shipped: shipped.slice(0, 8),
    needsAttention: needsAttention.slice(0, 8),
    plannedWork: plannedWork.slice(0, 8),
    agentUpdates: agentUpdates.slice(0, 6),
  };

  const md: string[] = [
    `# ${label} Project Briefing — ${now.toISOString().slice(0, 10)}`,
    "",
    `> Last ${windowDays} day${windowDays > 1 ? "s" : ""} · ${projects.length} projects · ${mergedPrsCount} PRs shipped · ${openPrsCount} waiting for review · ${blockedCount} needing decisions`,
    "",
    "## Suggested Next Actions",
    ...(suggestions.length > 0
      ? suggestions.slice(0, 5).map((s) => `- **${s.action}**: ${s.reason}`)
      : ["- All projects look on track right now."]),
    "",
    "## Shipped Recently",
    ...(shippedLines.length > 0 ? shippedLines : ["- No new updates in this window."]),
    "",
    "## Needs Attention / Waiting for Review",
    ...(attentionLines.length > 0 ? attentionLines : ["- All clear — no blockers or pending reviews."]),
    "",
    "## Where Projects Are Heading (Planned Work)",
    ...(plannedWork.length > 0
      ? plannedWork.slice(0, 6).map((w) => `- **${w.projectName}**: ${w.summary}${w.detail ? ` (${w.detail})` : ""}`)
      : ["- No upcoming milestones recorded yet."]),
    "",
    "## Agent Activity",
    ...(agentLines.length > 0 ? agentLines : ["- No recent agent sessions detected."]),
  ];

  return {
    period,
    createdAt: now.toISOString(),
    headline,
    stats: {
      commitsCount,
      mergedPrsCount,
      openPrsCount,
      openIssuesCount,
      blockedCount,
      activeAgentsCount,
    },
    brief,
    markdown: md.join("\n"),
  };
}

let singletonStore: CitadelMemoryStore | null = null;

export function getMemoryStore(): CitadelMemoryStore {
  if (!singletonStore) {
    singletonStore = new CitadelMemoryStore();
  }
  return singletonStore;
}
