import { useMemo, useState } from "react";
import { motion } from "motion/react";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  GitBranch,
  GitCommitHorizontal,
  Shield,
  Target,
} from "lucide-react";
import type { ManagedProject, ProjectState } from "../core/types.ts";

interface ControlCenterProps {
  projects: ManagedProject[];
  onSelectProject: (id: string) => void;
  onJumpFilter: (filter: "All" | ProjectState) => void;
  onOpenStandup: () => void;
  onSyncAll: () => void;
  loading: boolean;
}

const SPRING = { type: "spring" as const, stiffness: 320, damping: 28 };

function lastNDays(n: number): string[] {
  const days: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

export function ControlCenter({
  projects,
  onSelectProject,
  onJumpFilter,
  onOpenStandup,
  onSyncAll,
  loading,
}: ControlCenterProps) {
  const [hoveredDay, setHoveredDay] = useState<string | null>(null);

  const metrics = useMemo(() => {
    const total = projects.length;
    const active = projects.filter((p) => p.status.state === "Active").length;
    const review = projects.filter((p) => p.status.state === "Waiting on Review").length;
    const blocked = projects.filter((p) => p.status.state === "Blocked" || p.status.blockers.length > 0).length;
    const idle = projects.filter((p) => p.status.state === "Idle").length;
    const dirtyRepos = projects.filter((p) => p.git.dirtyCount > 0).length;
    const guarded = projects.filter((p) => p.antiSlop.hasSkill).length;
    const verifyPass = projects.filter((p) => p.status.verify === "Pass").length;

    const totalMilestones = projects.reduce((sum, p) => sum + p.status.plan.length, 0);
    const doneMilestones = projects.reduce(
      (sum, p) => sum + p.status.plan.filter((m) => m.done).length,
      0,
    );

    return {
      total,
      active,
      review,
      blocked,
      idle,
      dirtyRepos,
      guarded,
      verifyPass,
      totalMilestones,
      doneMilestones,
      milestonePct: totalMilestones > 0 ? Math.round((doneMilestones / totalMilestones) * 100) : 0,
      guardedPct: total > 0 ? Math.round((guarded / total) * 100) : 0,
    };
  }, [projects]);

  // 14-day commit velocity across all tracked repos
  const commitSeries = useMemo(() => {
    const days = lastNDays(14);
    const counts = new Map<string, number>();
    for (const day of days) counts.set(day, 0);

    for (const p of projects) {
      for (const c of p.git.recentCommits) {
        if (counts.has(c.date)) {
          counts.set(c.date, (counts.get(c.date) ?? 0) + 1);
        }
      }
    }

    const points = days.map((day) => ({
      day,
      short: day.slice(5),
      count: counts.get(day) ?? 0,
    }));
    const max = Math.max(1, ...points.map((pt) => pt.count));
    const totalCommits = points.reduce((s, pt) => s + pt.count, 0);
    return { points, max, totalCommits };
  }, [projects]);

  // Donut segments for Status Distribution
  const donutSegments = useMemo(() => {
    const raw = [
      { key: "Active" as const, label: "In Progress", count: metrics.active, color: "#38bdf8" },
      { key: "Waiting on Review" as const, label: "Ready to Review", count: metrics.review, color: "#fbbf24" },
      { key: "Blocked" as const, label: "Needs Decision", count: metrics.blocked, color: "#fb7185" },
      { key: "Idle" as const, label: "Idle", count: metrics.idle, color: "#71717a" },
    ];
    const sum = Math.max(1, raw.reduce((s, r) => s + r.count, 0));
    const r = 44;
    const circ = 2 * Math.PI * r;
    let offset = 0;

    return raw.map((seg) => {
      const length = (seg.count / sum) * circ;
      const dashOffset = -offset;
      offset += length;
      return { ...seg, length, dashOffset, circ };
    });
  }, [metrics]);

  // Priority queue (Blocked -> Review -> Dirty WIP)
  const attentionQueue = useMemo(() => {
    return projects
      .filter(
        (p) =>
          p.status.state === "Blocked" ||
          p.status.blockers.length > 0 ||
          p.status.state === "Waiting on Review" ||
          p.git.dirtyCount > 0,
      )
      .slice(0, 6);
  }, [projects]);

  // Cross-project chronological commit feed
  const liveFeed = useMemo(() => {
    const items: Array<{
      projectId: string;
      projectName: string;
      hash: string;
      date: string;
      subject: string;
    }> = [];
    for (const p of projects) {
      for (const c of p.git.recentCommits.slice(0, 4)) {
        items.push({
          projectId: p.id,
          projectName: p.name,
          hash: c.hash,
          date: c.date,
          subject: c.subject,
        });
      }
    }
    return items.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);
  }, [projects]);

  const hoveredPoint = commitSeries.points.find((pt) => pt.day === hoveredDay);

  return (
    <div className="bento-root">
      {/* Row 1: Telemetry KPIs */}
      <div className="bento-kpi-row">
        <motion.button
          className="bento-kpi"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={SPRING}
          whileHover={{ y: -2 }}
          onClick={() => onJumpFilter("All")}
        >
          <div className="bento-kpi-top">
            <span className="bento-label">Tracked Fleet</span>
            <GitBranch size={14} color="#38bdf8" />
          </div>
          <div className="bento-big">{metrics.total}</div>
          <div className="bento-sub">
            {metrics.dirtyRepos > 0
              ? `${metrics.dirtyRepos} with uncommitted WIP`
              : "All working trees clean"}
          </div>
        </motion.button>

        <motion.button
          className={`bento-kpi ${metrics.blocked > 0 ? "kpi-alert" : ""}`}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...SPRING, delay: 0.04 }}
          whileHover={{ y: -2 }}
          onClick={() => onJumpFilter(metrics.blocked > 0 ? "Blocked" : "Waiting on Review")}
        >
          <div className="bento-kpi-top">
            <span className="bento-label">Needs Attention</span>
            <AlertTriangle size={14} color={metrics.blocked > 0 ? "#fb7185" : "#fbbf24"} />
          </div>
          <div className="bento-big" style={{ color: metrics.blocked > 0 ? "var(--rose)" : "var(--amber)" }}>
            {metrics.blocked + metrics.review}
          </div>
          <div className="bento-sub">
            {metrics.blocked} blocked · {metrics.review} in review
          </div>
        </motion.button>

        <motion.div
          className="bento-kpi"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...SPRING, delay: 0.08 }}
        >
          <div className="bento-kpi-top">
            <span className="bento-label">Milestone Progress</span>
            <Target size={14} color="#a78bfa" />
          </div>
          <div className="bento-big">{metrics.milestonePct}%</div>
          <div className="bento-sub">
            {metrics.doneMilestones} of {metrics.totalMilestones} milestones shipped
          </div>
        </motion.div>

        <motion.div
          className="bento-kpi"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...SPRING, delay: 0.12 }}
        >
          <div className="bento-kpi-top">
            <span className="bento-label">Bastion &amp; Verify</span>
            <Shield size={14} color="#34d399" />
          </div>
          <div className="bento-big" style={{ color: "var(--emerald)" }}>
            {metrics.guardedPct}%
          </div>
          <div className="bento-sub">
            {metrics.guarded} guarded · {metrics.verifyPass} verify pass
          </div>
        </motion.div>
      </div>

      {/* Row 2: Charts */}
      <div className="bento-charts-row">
        {/* 14-Day Commit Activity Chart */}
        <motion.div
          className="bento-card"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...SPRING, delay: 0.14 }}
        >
          <div className="bento-card-header">
            <div>
              <div className="bento-card-title">
                <Activity size={14} color="#38bdf8" /> 14-Day Commit Velocity
              </div>
              <div className="bento-card-sub">
                {hoveredPoint
                  ? `${hoveredPoint.day}: ${hoveredPoint.count} commit(s)`
                  : `${commitSeries.totalCommits} commits across all tracked repositories`}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button className="btn btn-xs" onClick={onSyncAll} disabled={loading}>
                Sync Recaps
              </button>
              <button className="btn btn-xs btn-primary" onClick={onOpenStandup}>
                Standup
              </button>
            </div>
          </div>

          <div className="velocity-chart">
            {commitSeries.points.map((pt, i) => {
              const heightPct = pt.count === 0 ? 4 : Math.max(12, Math.round((pt.count / commitSeries.max) * 100));
              const isHovered = hoveredDay === pt.day;
              return (
                <div
                  key={pt.day}
                  className="velocity-col"
                  onMouseEnter={() => setHoveredDay(pt.day)}
                  onMouseLeave={() => setHoveredDay(null)}
                >
                  <div className="velocity-bar-track">
                    <motion.div
                      className={`velocity-bar ${pt.count > 0 ? "has-data" : ""} ${isHovered ? "hovered" : ""}`}
                      initial={{ height: "0%" }}
                      animate={{ height: `${heightPct}%` }}
                      transition={{ ...SPRING, delay: 0.05 + i * 0.025 }}
                    />
                  </div>
                  <span className="velocity-label">{i % 2 === 0 ? pt.short : ""}</span>
                </div>
              );
            })}
          </div>
        </motion.div>

        {/* Status Distribution Donut */}
        <motion.div
          className="bento-card"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...SPRING, delay: 0.18 }}
        >
          <div className="bento-card-header">
            <div>
              <div className="bento-card-title">Fleet Status Mix</div>
              <div className="bento-card-sub">Click any state to filter</div>
            </div>
          </div>

          <div className="donut-layout">
            <div className="donut-wrap">
              <svg width="116" height="116" viewBox="0 0 116 116" style={{ transform: "rotate(-90deg)" }}>
                <circle
                  cx="58"
                  cy="58"
                  r="44"
                  fill="none"
                  stroke="rgba(255,255,255,0.06)"
                  strokeWidth="11"
                />
                {donutSegments.map(
                  (seg) =>
                    seg.count > 0 && (
                      <motion.circle
                        key={seg.key}
                        cx="58"
                        cy="58"
                        r="44"
                        fill="none"
                        stroke={seg.color}
                        strokeWidth="11"
                        strokeLinecap="butt"
                        strokeDasharray={`${seg.length} ${seg.circ}`}
                        initial={{ strokeDashoffset: seg.circ }}
                        animate={{ strokeDashoffset: seg.dashOffset }}
                        transition={{ duration: 0.7, ease: [0.2, 0.8, 0.2, 1] }}
                      />
                    ),
                )}
              </svg>
              <div className="donut-center">
                <div className="donut-total">{metrics.total}</div>
                <div className="donut-caption">repos</div>
              </div>
            </div>

            <div className="donut-legend">
              {donutSegments.map((seg) => (
                <button
                  key={seg.key}
                  className="legend-row"
                  onClick={() => onJumpFilter(seg.key)}
                >
                  <span className="legend-left">
                    <span className="status-dot" style={{ background: seg.color }} />
                    {seg.label}
                  </span>
                  <span className="nav-count">{seg.count}</span>
                </button>
              ))}
            </div>
          </div>
        </motion.div>
      </div>

      {/* Row 3: Priority Queue + Cross-Project Feed */}
      <div className="bento-bottom-row">
        <motion.div
          className="bento-card"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...SPRING, delay: 0.22 }}
        >
          <div className="bento-card-header">
            <div>
              <div className="bento-card-title">Priority Queue</div>
              <div className="bento-card-sub">Blockers, reviews, and uncommitted work</div>
            </div>
          </div>

          {attentionQueue.length === 0 ? (
            <div className="bento-empty">
              <CheckCircle2 size={16} color="#34d399" />
              <span>Zero blockers or pending reviews across your fleet.</span>
            </div>
          ) : (
            <div className="queue-list">
              {attentionQueue.map((p) => {
                const reason =
                  p.status.blockers[0] ??
                  (p.status.state === "Waiting on Review"
                    ? "Ready for your review"
                    : `${p.git.dirtyCount} uncommitted file(s) on ${p.git.branch}`);
                return (
                  <button
                    key={p.id}
                    className="queue-item"
                    onClick={() => onSelectProject(p.id)}
                  >
                    <div style={{ minWidth: 0, textAlign: "left" }}>
                      <div className="queue-name">{p.name}</div>
                      <div className="queue-reason">{reason}</div>
                    </div>
                    <ArrowUpRight size={14} color="var(--text-muted)" />
                  </button>
                );
              })}
            </div>
          )}
        </motion.div>

        <motion.div
          className="bento-card"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...SPRING, delay: 0.26 }}
        >
          <div className="bento-card-header">
            <div>
              <div className="bento-card-title">
                <GitCommitHorizontal size={14} color="#34d399" /> Live Cross-Repo Activity
              </div>
              <div className="bento-card-sub">Most recent commits across all projects</div>
            </div>
          </div>

          {liveFeed.length === 0 ? (
            <div className="bento-empty">No Git commits detected yet.</div>
          ) : (
            <div className="feed-list">
              {liveFeed.map((item) => (
                <button
                  key={`${item.projectId}-${item.hash}`}
                  className="feed-row"
                  onClick={() => onSelectProject(item.projectId)}
                >
                  <span className="feed-repo">{item.projectName}</span>
                  <span className="commit-msg">{item.subject}</span>
                  <span className="commit-date">{item.date.slice(5)}</span>
                </button>
              ))}
            </div>
          )}
        </motion.div>
      </div>
    </div>
  );
}
