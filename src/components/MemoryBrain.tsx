import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import {
  AlertTriangle,
  Bot,
  Brain,
  Calendar,
  Check,
  CircleDot,
  Copy,
  ExternalLink,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  RefreshCw,
  Search,
  Sparkles,
  Target,
} from "lucide-react";
import { fetchDigests, generateDigest, searchMemory } from "../core/api.ts";
import type { MemoryIndexStats, MemorySearchHit, MemorySourceKind, PmDigestEntry } from "../core/types.ts";

interface MemoryBrainProps {
  onSelectProject: (projectId: string) => void;
}

const SOURCE_FILTERS: Array<{ id: "" | MemorySourceKind; label: string }> = [
  { id: "", label: "All" },
  { id: "agent_session", label: "Agents" },
  { id: "claude_memory", label: "Claude Memory" },
  { id: "pr", label: "Open PRs" },
  { id: "merged_pr", label: "Merged PRs" },
  { id: "issue", label: "Issues" },
  { id: "commit", label: "Commits" },
  { id: "blocker", label: "Blockers" },
];

function sourceBadge(source: MemorySourceKind) {
  switch (source) {
    case "agent_session":
      return { label: "Agent", icon: <Bot size={11} color="#a78bfa" /> };
    case "claude_memory":
      return { label: "Memory", icon: <Brain size={11} color="#a78bfa" /> };
    case "pr":
      return { label: "Open PR", icon: <GitPullRequest size={11} color="#fbbf24" /> };
    case "merged_pr":
      return { label: "Merged", icon: <GitMerge size={11} color="#34d399" /> };
    case "issue":
      return { label: "Issue", icon: <CircleDot size={11} color="#38bdf8" /> };
    case "milestone":
      return { label: "Milestone", icon: <Target size={11} color="#a78bfa" /> };
    case "blocker":
      return { label: "Blocker", icon: <AlertTriangle size={11} color="#fb7185" /> };
    case "commit":
      return { label: "Commit", icon: <GitCommitHorizontal size={11} color="#94a3b8" /> };
    case "plan":
    default:
      return { label: "Plan", icon: <Sparkles size={11} color="#38bdf8" /> };
  }
}

export function MemoryBrain({ onSelectProject }: MemoryBrainProps) {
  const [tab, setTab] = useState<"search" | "digests">("search");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<"" | MemorySourceKind>("");
  const [hits, setHits] = useState<MemorySearchHit[]>([]);
  const [stats, setStats] = useState<MemoryIndexStats | null>(null);
  const [loading, setLoading] = useState(false);

  const [digests, setDigests] = useState<PmDigestEntry[]>([]);
  const [activeDigest, setActiveDigest] = useState<PmDigestEntry | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  const runSearch = useCallback(async (q: string, src: string) => {
    setLoading(true);
    try {
      const res = await searchMemory(q, { source: src || undefined });
      setHits(res.results);
      setStats(res.stats);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDigests = useCallback(async () => {
    const res = await fetchDigests();
    setDigests(res.history);
    setActiveDigest((prev) => prev ?? res.latestDaily ?? res.history[0] ?? null);
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => {
      void runSearch(query, source);
    }, 120);
    return () => window.clearTimeout(id);
  }, [query, source, runSearch]);

  useEffect(() => {
    void loadDigests();
  }, [loadDigests]);

  async function handleGenerate(period: "daily" | "weekly") {
    setGenerating(true);
    try {
      const res = await generateDigest(period);
      setDigests(res.history);
      setActiveDigest(res.digest);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="hero-brief">
        <div>
          <div className="hero-eyebrow">
            <Brain size={11} style={{ verticalAlign: "-1px", marginRight: 5 }} />
            Local SQLite FTS5 Memory · 0 Tokens
          </div>
          <p className="hero-headline">
            {stats
              ? `${stats.totalDocs} indexed memories across your repos, GitHub & agent sessions`
              : "Cross-project memory & scheduled PM digests"}
          </p>
        </div>

        <div className="glass-segmented" style={{ width: 240 }}>
          <button
            className={`seg-option ${tab === "search" ? "active" : ""}`}
            onClick={() => setTab("search")}
          >
            {tab === "search" && <span className="seg-pill-bg" />}
            <span className="seg-label">Memory Search</span>
          </button>
          <button
            className={`seg-option ${tab === "digests" ? "active" : ""}`}
            onClick={() => setTab("digests")}
          >
            {tab === "digests" && <span className="seg-pill-bg" />}
            <span className="seg-label">PM Digests ({digests.length})</span>
          </button>
        </div>
      </div>

      {tab === "search" ? (
        <>
          <div className="bento-card" style={{ gap: 12 }}>
            <div className="input-inline">
              <div className="search-box" style={{ flex: 1, width: "auto" }}>
                <Search size={14} />
                <input
                  autoFocus
                  placeholder="Search across all Claude sessions, Antigravity tasks, PRs, issues, commits..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <button
                className="btn btn-xs"
                onClick={() => void runSearch(query, source)}
                disabled={loading}
              >
                <RefreshCw size={12} /> Refresh
              </button>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {SOURCE_FILTERS.map((f) => (
                <button
                  key={f.id || "all"}
                  className={`btn btn-xs ${source === f.id ? "btn-primary" : ""}`}
                  onClick={() => setSource(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {hits.length === 0 ? (
              <div className="empty-state">
                {loading ? "Searching SQLite FTS5 memory..." : "No matching memories found."}
              </div>
            ) : (
              hits.map((hit) => {
                const badge = sourceBadge(hit.source);
                return (
                  <motion.div
                    key={hit.docKey}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="bento-card"
                    style={{ padding: "12px 14px", gap: 6, cursor: "pointer" }}
                    onClick={() => onSelectProject(hit.projectId)}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <span className="mono-tag">
                          {badge.icon} {badge.label}
                        </span>
                        <span className="pill-badge pill-idle">{hit.projectName}</span>
                        <span style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {hit.title}
                        </span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                        {hit.occurredAt && (
                          <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
                            {hit.occurredAt.slice(0, 10)}
                          </span>
                        )}
                        {hit.url && (
                          <a
                            className="btn btn-ghost btn-xs"
                            href={hit.url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            title="Open on GitHub"
                          >
                            <ExternalLink size={12} />
                          </a>
                        )}
                      </div>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.45 }}>
                      {hit.snippet}
                    </div>
                  </motion.div>
                );
              })
            )}
          </div>
        </>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: 14, alignItems: "start" }}>
          <div className="bento-card" style={{ gap: 10 }}>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                className="btn btn-xs btn-primary"
                style={{ flex: 1 }}
                disabled={generating}
                onClick={() => void handleGenerate("daily")}
              >
                <Calendar size={11} /> + Daily
              </button>
              <button
                className="btn btn-xs"
                style={{ flex: 1 }}
                disabled={generating}
                onClick={() => void handleGenerate("weekly")}
              >
                <Calendar size={11} /> + Weekly
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {digests.map((d) => {
                const key = `${d.id ?? d.createdAt}`;
                const selected = activeDigest?.createdAt === d.createdAt && activeDigest?.period === d.period;
                return (
                  <button
                    key={key}
                    className={`nav-item ${selected ? "active" : ""}`}
                    style={{
                      textAlign: "left",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      gap: 3,
                      border: selected ? "1px solid var(--border-strong)" : "1px solid transparent",
                      background: selected ? "var(--glass-active)" : "transparent",
                    }}
                    onClick={() => setActiveDigest(d)}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
                      <span className={`pill-badge ${d.period === "weekly" ? "pill-review" : "pill-active"}`}>
                        {d.period}
                      </span>
                      <span style={{ fontSize: 10.5, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
                        {d.createdAt.slice(0, 10)}
                      </span>
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                      {d.stats.mergedPrsCount} PRs · {d.stats.commitsCount} commits · {d.stats.blockedCount} blocked
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="bento-card" style={{ gap: 12 }}>
            {activeDigest ? (
              <>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <div>
                    <div style={{ fontWeight: 650, fontSize: 14 }}>{activeDigest.headline}</div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                      Captured {new Date(activeDigest.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <button
                    className="btn btn-xs btn-primary"
                    onClick={() => {
                      void navigator.clipboard.writeText(activeDigest.markdown);
                      setCopiedId(activeDigest.createdAt);
                      window.setTimeout(() => setCopiedId(null), 2000);
                    }}
                  >
                    {copiedId === activeDigest.createdAt ? (
                      <>
                        <Check size={12} /> Copied
                      </>
                    ) : (
                      <>
                        <Copy size={12} /> Copy Markdown
                      </>
                    )}
                  </button>
                </div>

                <div className="standup-stats">
                  <div className="standup-stat">
                    <div className="standup-stat-num">{activeDigest.stats.commitsCount}</div>
                    <div className="standup-stat-label">Commits</div>
                  </div>
                  <div className="standup-stat">
                    <div className="standup-stat-num" style={{ color: "var(--emerald)" }}>
                      {activeDigest.stats.mergedPrsCount}
                    </div>
                    <div className="standup-stat-label">Merged PRs</div>
                  </div>
                  <div className="standup-stat">
                    <div className="standup-stat-num" style={{ color: "var(--amber)" }}>
                      {activeDigest.stats.openPrsCount}
                    </div>
                    <div className="standup-stat-label">Open PRs</div>
                  </div>
                  <div className="standup-stat">
                    <div className="standup-stat-num" style={{ color: "var(--rose)" }}>
                      {activeDigest.stats.blockedCount}
                    </div>
                    <div className="standup-stat-label">Blocked</div>
                  </div>
                </div>

                <pre className="standup-code" style={{ maxHeight: 420 }}>
                  {activeDigest.markdown}
                </pre>
              </>
            ) : (
              <div className="empty-state">No digests recorded yet. Click "+ Daily" to capture one now.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
