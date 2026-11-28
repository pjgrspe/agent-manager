import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  Bot,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  ClipboardList,
  Copy,
  ExternalLink,
  FolderOpen,
  FolderPlus,
  GitMerge,
  GitPullRequest,
  Globe,
  LayoutDashboard,
  Layers,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Target,
  Trash2,
  X,
} from "lucide-react";
import { ControlCenter } from "./components/ControlCenter.tsx";
import { MemoryBrain } from "./components/MemoryBrain.tsx";
import {
  addProject,
  addProjectsBatch,
  addRemoteProject,
  fetchProjects,
  fetchStandup,
  previewFolder,
  removeProject,
  updateProjectMeta,
  updateProjectStatus,
  type ScanCandidate,
} from "./core/api.ts";
import { isProjectBlocked, matchesStateFilter } from "./core/statusParser.ts";
import type {
  ManagedProject,
  ProjectState,
  StandupSummary,
} from "./core/types.ts";

type FilterState = "ControlCenter" | "Memory" | "All" | ProjectState;

const SPRING_SNAPPY = { type: "spring" as const, stiffness: 460, damping: 34 };
const SPRING_SMOOTH = { type: "spring" as const, stiffness: 320, damping: 30 };

function cleanText(raw: string): string {
  return raw
    .replace(/^Pinned blocker:\s*/i, "")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function stateMeta(state: ProjectState) {
  switch (state) {
    case "Active":
      return { row: "state-active", pill: "pill-badge pill-active", orb: "orb-active", color: "#38bdf8" };
    case "Waiting on Review":
      return { row: "state-review", pill: "pill-badge pill-review", orb: "orb-review", color: "#fbbf24" };
    case "Blocked":
      return { row: "state-blocked", pill: "pill-badge pill-blocked", orb: "orb-blocked", color: "#fb7185" };
    case "Idle":
      return { row: "state-idle", pill: "pill-badge pill-idle", orb: "orb-idle", color: "#71717a" };
  }
}

function ProgressRing({
  percent,
  size = 36,
  stroke = 3,
  color = "#34d399",
  label,
}: {
  percent: number;
  size?: number;
  stroke?: number;
  color?: string;
  label?: string;
}) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, percent));
  const offset = circumference - (clamped / 100) * circumference;

  return (
    <div
      style={{
        position: "relative",
        width: size,
        height: size,
        display: "grid",
        placeItems: "center",
        flexShrink: 0,
      }}
    >
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={stroke}
        />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 0.65, ease: [0.2, 0.8, 0.2, 1] }}
        />
      </svg>
      {label && (
        <span
          style={{
            position: "absolute",
            fontFamily: "var(--font-mono)",
            fontSize: 9.5,
            fontWeight: 600,
            color: "var(--text-secondary)",
          }}
        >
          {label}
        </span>
      )}
    </div>
  );
}

export function App() {
  const [projects, setProjects] = useState<ManagedProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterState>("ControlCenter");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [showAddModal, setShowAddModal] = useState(false);
  const [addMode, setAddMode] = useState<"remote" | "scan" | "single">("remote");
  const [pathInput, setPathInput] = useState("");
  const [groupInput, setGroupInput] = useState("");
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [inspectorNameDraft, setInspectorNameDraft] = useState("");
  const [inspectorGroupDraft, setInspectorGroupDraft] = useState("");
  const [scanCandidates, setScanCandidates] = useState<ScanCandidate[] | null>(null);
  const [selectedCandidates, setSelectedCandidates] = useState<Set<string>>(new Set());
  const [standup, setStandup] = useState<StandupSummary | null>(null);
  const [standupTab, setStandupTab] = useState<"visual" | "markdown">("visual");
  const [copiedStandup, setCopiedStandup] = useState(false);

  const [newRecapText, setNewRecapText] = useState("");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ label: string; detail?: string } | null>(null);
  const [showClaudeMemory, setShowClaudeMemory] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<"summary" | "activity" | "settings">("summary");

  const searchInputRef = useRef<HTMLInputElement>(null);

  const showToast = useCallback((label: string, detail?: string) => {
    setToast({ label, detail });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  const loadAll = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const list = await fetchProjects();
      setProjects(list);
      setSelectedId((prev) => (prev && list.some((p) => p.id === prev) ? prev : null));
    } catch (e) {
      if (!silent) {
        setError(e instanceof Error ? e.message : "Failed to load projects");
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll(false);
    // Quick background hydration pass to pick up async GitHub PR/CI cache
    const hydrateTimer = window.setTimeout(() => {
      void loadAll(true);
    }, 2500);
    return () => window.clearTimeout(hydrateTimer);
  }, [loadAll]);

  // Dynamic live auto-refresh: every 15s + on window focus
  useEffect(() => {
    const interval = window.setInterval(() => {
      void loadAll(true);
    }, 15000);
    const onFocus = () => {
      void loadAll(true);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [loadAll]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const inField = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setFilter("Memory");
      } else if (e.key === "/" && !inField) {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === "Escape") {
        if (showAddModal) setShowAddModal(false);
        else if (standup) setStandup(null);
        else if (!inField && selectedId) setSelectedId(null);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showAddModal, standup, selectedId]);

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedId) ?? null,
    [projects, selectedId],
  );

  useEffect(() => {
    setInspectorNameDraft(selectedProject?.name ?? "");
    setInspectorGroupDraft(selectedProject?.group ?? "");
  }, [selectedProject?.id, selectedProject?.name, selectedProject?.group]);

  const stats = useMemo(() => {
    return {
      total: projects.length,
      blocked: projects.filter((p) => isProjectBlocked(p)).length,
      review: projects.filter((p) => p.status.state === "Waiting on Review").length,
      active: projects.filter((p) => p.status.state === "Active").length,
      idle: projects.filter((p) => p.status.state === "Idle").length,
      guarded: projects.filter((p) => p.antiSlop.hasSkill).length,
    };
  }, [projects]);

  const groups = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of projects) {
      if (p.group) {
        map.set(p.group, (map.get(p.group) ?? 0) + 1);
      }
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [projects]);

  const filteredProjects = useMemo(() => {
    const stateFilter = filter === "Memory" ? "All" : filter;
    return projects.filter((p) => {
      if (!matchesStateFilter(p, stateFilter)) return false;
      if (activeGroup && p.group !== activeGroup) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return (
          p.name.toLowerCase().includes(q) ||
          p.path.toLowerCase().includes(q) ||
          (p.group ?? "").toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [projects, filter, activeGroup, search]);

  const groupedProjects = useMemo(() => {
    const map = new Map<string, ManagedProject[]>();
    for (const p of filteredProjects) {
      const key = p.group || "Ungrouped";
      const list = map.get(key) ?? [];
      list.push(p);
      map.set(key, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => {
      if (a === "Ungrouped") return 1;
      if (b === "Ungrouped") return -1;
      return a.localeCompare(b);
    });
  }, [filteredProjects]);

  const heroHeadline = useMemo(() => {
    if (stats.total === 0) return "Add your first repository to start managing projects";
    if (stats.blocked > 0) {
      return `${stats.blocked} project${stats.blocked > 1 ? "s need" : " needs"} your decision right now`;
    }
    if (stats.review > 0) {
      return `${stats.review} project${stats.review > 1 ? "s are" : " is"} ready for your review`;
    }
    if (stats.active > 0) {
      return `All clear — ${stats.active} active project${stats.active > 1 ? "s" : ""} moving smoothly`;
    }
    return `Tracking ${stats.total} repository${stats.total > 1 ? "s" : ""} — everything is calm`;
  }, [stats]);

  const activeOrbClass = selectedProject ? stateMeta(selectedProject.status.state).orb : "orb-idle";

  function inferFolderName(rawPath: string): string {
    const cleaned = rawPath.trim().replace(/^["']+|["']+$/g, "").replace(/[\\/]+$/, "");
    const parts = cleaned.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? "";
  }

  async function handleAddSubmit() {
    if (!pathInput.trim()) return;
    setError(null);
    const resolvedGroup = groupInput.trim() || undefined;
    try {
      if (addMode === "remote") {
        const updated = await addRemoteProject(pathInput.trim(), undefined, resolvedGroup);
        setProjects(updated);
        showToast("GitHub repository tracked", resolvedGroup ? `Group: ${resolvedGroup}` : pathInput.trim());
        setPathInput("");
        setGroupInput("");
        setShowAddModal(false);
      } else if (addMode === "single") {
        const updated = await addProject(pathInput.trim(), undefined, resolvedGroup);
        setProjects(updated);
        showToast("Repository added", resolvedGroup ? `Group: ${resolvedGroup}` : pathInput.trim());
        setPathInput("");
        setGroupInput("");
        setShowAddModal(false);
      } else {
        const candidates = await previewFolder(pathInput.trim());
        if (!groupInput.trim()) {
          setGroupInput(inferFolderName(pathInput));
        }
        setScanCandidates(candidates);
        setSelectedCandidates(new Set(candidates.filter((c) => !c.alreadyTracked).map((c) => c.path)));
        if (candidates.length === 0) {
          showToast("No Git repos found in folder", "Switch to 'Local Path' to add a non-git folder");
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add repository");
    }
  }

  async function handleConfirmImport() {
    const chosen = Array.from(selectedCandidates);
    if (chosen.length === 0) return;
    setError(null);
    const resolvedGroup = groupInput.trim() || inferFolderName(pathInput) || undefined;
    try {
      const res = await addProjectsBatch(chosen, resolvedGroup);
      setProjects(res.projects);
      showToast(
        `Imported ${res.added} repository(s)`,
        resolvedGroup ? `Grouped under "${resolvedGroup}"` : undefined,
      );
      setPathInput("");
      setGroupInput("");
      setScanCandidates(null);
      setSelectedCandidates(new Set());
      setShowAddModal(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to import selected repositories");
    }
  }

  async function handleSaveMeta(project: ManagedProject, nextName: string, nextGroup: string) {
    try {
      const cleanedName = nextName.trim() || project.name;
      const updated = await updateProjectMeta(project.id, {
        name: cleanedName,
        group: nextGroup,
      });
      setProjects(updated);
      showToast(`Saved "${cleanedName}"`, nextGroup.trim() ? `Group: ${nextGroup.trim()}` : "Display only — folder untouched");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update project info");
    }
  }

  async function handleOpenStandup() {
    try {
      const summary = await fetchStandup();
      setStandup(summary);
      setCopiedStandup(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate standup");
    }
  }

  async function saveStatusUpdate(
    project: ManagedProject,
    patch: Partial<Omit<ManagedProject["status"], "hasStatusFile">>,
  ) {
    setSaving(true);
    try {
      const next = {
        state: patch.state ?? project.status.state,
        updated: new Date().toISOString().slice(0, 10),
        verify: patch.verify ?? project.status.verify,
        recap: patch.recap ?? project.status.recap,
        plan: patch.plan ?? project.status.plan,
        blockers: patch.blockers ?? project.status.blockers,
      };
      const saved = await updateProjectStatus(project.id, next);
      setProjects((prev) =>
        prev.map((p) => (p.id === project.id ? { ...p, status: saved } : p)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save status");
    } finally {
      setSaving(false);
    }
  }

  async function handleBrowseFolder() {
    if (!window.agentManager?.pickFolder) {
      showToast("Folder picker requires desktop app", "Paste a path or launch from Start Menu");
      return;
    }
    const picked = await window.agentManager.pickFolder();
    if (picked) {
      setPathInput(picked);
      if (addMode === "scan") {
        setGroupInput(inferFolderName(picked));
      }
    }
  }

  async function handleRemove(id: string) {
    try {
      const updated = await removeProject(id);
      setProjects(updated);
      if (selectedId === id) setSelectedId(null);
      showToast("Removed from dashboard", "Local files untouched");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove project");
    }
  }

  return (
    <>
      {/* Ambient Reactive Aura */}
      <div className="ambient-stage" aria-hidden="true">
        <div className={`ambient-orb ${activeOrbClass}`} />
        <div className="ambient-orb-secondary" />
      </div>

      <div className={`workspace ${selectedProject ? "has-inspector" : ""}`}>
        {/* Left Navigation Rail */}
        <aside className="rail">
          <div className="brand-mark">
            <span className="brand-icon">
              <Layers size={15} strokeWidth={2.3} />
            </span>
            <div>
              <div className="brand-title">Citadel</div>
              <div className="brand-sub">Project Manager</div>
            </div>
          </div>

          <div>
            <nav className="rail-nav">
              <button
                className={`nav-item ${filter === "ControlCenter" ? "active" : ""}`}
                onClick={() => {
                  setFilter("ControlCenter");
                  setActiveGroup(null);
                }}
              >
                {filter === "ControlCenter" && (
                  <motion.span
                    layoutId="nav-active-pill"
                    className="nav-pill-bg"
                    transition={SPRING_SNAPPY}
                  />
                )}
                <span className="nav-content">
                  <span className="nav-left">
                    <LayoutDashboard size={14} color="#38bdf8" />
                    Overview
                  </span>
                </span>
              </button>

              <button
                className={`nav-item ${filter !== "ControlCenter" && filter !== "Memory" && !activeGroup ? "active" : ""}`}
                onClick={() => {
                  setFilter("All");
                  setActiveGroup(null);
                }}
              >
                {filter !== "ControlCenter" && filter !== "Memory" && !activeGroup && (
                  <motion.span
                    layoutId="nav-active-pill"
                    className="nav-pill-bg"
                    transition={SPRING_SNAPPY}
                  />
                )}
                <span className="nav-content">
                  <span className="nav-left">
                    <FolderOpen size={14} color="#34d399" />
                    Projects
                  </span>
                  <span className="nav-count">{stats.total}</span>
                </span>
              </button>

              <button
                className={`nav-item ${filter === "Memory" ? "active" : ""}`}
                onClick={() => {
                  setFilter("Memory");
                  setActiveGroup(null);
                }}
                title="Daily & weekly briefings + search (Ctrl+K)"
              >
                {filter === "Memory" && (
                  <motion.span
                    layoutId="nav-active-pill"
                    className="nav-pill-bg"
                    transition={SPRING_SNAPPY}
                  />
                )}
                <span className="nav-content">
                  <span className="nav-left">
                    <Brain size={14} color="#a78bfa" />
                    Briefings
                  </span>
                </span>
              </button>
            </nav>
          </div>

          {groups.length > 0 && (
            <div>
              <div className="rail-section-label">Groups</div>
              <nav className="rail-nav">
                {groups.map(([groupName, count]) => {
                  const isActive = activeGroup === groupName && filter !== "ControlCenter" && filter !== "Memory";
                  return (
                    <button
                      key={groupName}
                      className={`nav-item ${isActive ? "active" : ""}`}
                      onClick={() => {
                        setFilter("All");
                        setActiveGroup((prev) => (prev === groupName ? null : groupName));
                      }}
                    >
                      <span className="nav-content">
                        <span className="nav-left">
                          <FolderOpen size={12} color="var(--text-muted)" />
                          {groupName}
                        </span>
                        <span className="nav-count">{count}</span>
                      </span>
                    </button>
                  );
                })}
              </nav>
            </div>
          )}

          <div className="rail-footer">
            <motion.button
              whileTap={{ scale: 0.98 }}
              className="btn btn-primary"
              onClick={() => setShowAddModal(true)}
            >
              <FolderPlus size={14} /> Add Project
            </motion.button>
          </div>
        </aside>

        {/* Center Workspace */}
        <section className="main-pane">
          <header className="main-header">
            <div className="header-title-group">
              <h1>
                {filter === "ControlCenter"
                  ? "Overview"
                  : filter === "Memory"
                    ? "History & Digests"
                    : filter === "All"
                      ? "All Projects"
                      : filter}
              </h1>
              <span className="header-count">
                {filter === "ControlCenter"
                  ? `${stats.total} projects`
                  : filter === "Memory"
                    ? "Search & Digests"
                    : `${filteredProjects.length} ${filteredProjects.length === 1 ? "project" : "projects"}`}
              </span>
            </div>

            <div className="header-controls">
              <span className="live-pill" title="Auto-refreshing every 15s and on window focus">
                <span className="live-dot" /> Live
              </span>
              <div className="search-box">
                <Search size={13} />
                <input
                  ref={searchInputRef}
                  placeholder="Search repos..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {!search && <span className="kbd-hint">/</span>}
              </div>
              <motion.button
                whileTap={{ scale: 0.94 }}
                className="btn btn-ghost"
                title="Refresh workspace"
                onClick={() => void loadAll()}
                disabled={loading}
              >
                <RefreshCw size={14} />
              </motion.button>
              <motion.button
                whileTap={{ scale: 0.96 }}
                className="btn btn-primary btn-xs"
                onClick={() => setShowAddModal(true)}
              >
                <FolderPlus size={13} /> Add Repo
              </motion.button>
            </div>
          </header>

          <div className="main-scroll">
            {error && <div className="banner-error">{error}</div>}

            {filter === "ControlCenter" ? (
              <ControlCenter
                projects={projects}
                onSelectProject={(id) => setSelectedId(id)}
                onJumpFilter={(next) => setFilter(next)}
                onOpenStandup={() => void handleOpenStandup()}
              />
            ) : filter === "Memory" ? (
              <MemoryBrain onSelectProject={(id) => setSelectedId(id)} />
            ) : (
              <>
            {/* Inline Status Filter Bar */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(
                  [
                    { id: "All", label: `All (${stats.total})` },
                    { id: "Blocked", label: `Needs Decision (${stats.blocked})` },
                    { id: "Waiting on Review", label: `In Review (${stats.review})` },
                    { id: "Active", label: `In Progress (${stats.active})` },
                    { id: "Idle", label: `Idle (${stats.idle})` },
                  ] as Array<{ id: FilterState; label: string }>
                ).map((pill) => (
                  <button
                    key={pill.id}
                    className={`btn btn-xs ${filter === pill.id ? "btn-primary" : ""}`}
                    onClick={() => setFilter(pill.id)}
                  >
                    {pill.label}
                  </button>
                ))}
              </div>
              <button className="btn btn-xs" onClick={() => void handleOpenStandup()}>
                <ClipboardList size={12} /> Quick Standup
              </button>
            </div>

            {loading && projects.length === 0 ? (
              <div className="empty-state">Scanning local repositories...</div>
            ) : filteredProjects.length === 0 ? (
              <div className="empty-state">
                <p style={{ margin: "0 0 14px" }}>
                  No repositories in this view yet. Scan a parent folder to import all your projects in one step.
                </p>
                <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
                  <FolderPlus size={14} /> Track Repository
                </button>
              </div>
            ) : (
              <div className="project-list">
                {groupedProjects.map(([groupName, groupItems]) => {
                  const isCollapsibleGroup = groupName !== "Ungrouped" && groupItems.length > 1;

                  if (isCollapsibleGroup) {
                    const isOpen = expandedGroups.has(groupName) || activeGroup === groupName || Boolean(search.trim());
                    const blockedCount = groupItems.filter((p) => isProjectBlocked(p)).length;
                    const reviewCount = groupItems.filter((p) => p.status.state === "Waiting on Review").length;
                    const activeCount = groupItems.filter((p) => p.status.state === "Active").length;
                    const firstBlocker = groupItems.find((p) => p.status.blockers.length > 0)?.status.blockers[0];

                    const groupState: ProjectState =
                      blockedCount > 0
                        ? "Blocked"
                        : reviewCount > 0
                          ? "Waiting on Review"
                          : activeCount > 0
                            ? "Active"
                            : "Idle";
                    const groupMeta = stateMeta(groupState);

                    return (
                      <motion.div
                        layout
                        key={`group-${groupName}`}
                        className={`group-card ${groupMeta.row}`}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={SPRING_SMOOTH}
                      >
                        <button
                          className="group-card-head"
                          onClick={() => {
                            setExpandedGroups((prev) => {
                              const next = new Set(prev);
                              if (next.has(groupName)) next.delete(groupName);
                              else next.add(groupName);
                              return next;
                            });
                          }}
                        >
                          <div style={{ minWidth: 0 }}>
                            <div className="row-top">
                              <FolderOpen size={15} color={groupMeta.color} />
                              <span className="group-card-title">{groupName}</span>
                              <span className="mono-tag">{groupItems.length} repos</span>
                              {blockedCount > 0 && (
                                <span className="pill-badge pill-blocked">{blockedCount} Blocked</span>
                              )}
                              {reviewCount > 0 && (
                                <span className="pill-badge pill-review">{reviewCount} Review</span>
                              )}
                              {activeCount > 0 && (
                                <span className="pill-badge pill-active">{activeCount} Active</span>
                              )}
                            </div>

                            {!isOpen && (
                              <div className="row-details" style={{ marginTop: 6 }}>
                                <div className="row-line">
                                  <span className="row-line-label">Repos</span>
                                  <span className="row-line-text">
                                    {groupItems.map((p) => p.name).join(" · ")}
                                  </span>
                                </div>
                                {firstBlocker && (
                                  <div className="row-blocker">
                                    <AlertTriangle size={12} />
                                    <span className="row-line-text">{firstBlocker}</span>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>

                          <motion.span
                            animate={{ rotate: isOpen ? 180 : 0 }}
                            transition={SPRING_SNAPPY}
                            style={{ color: "var(--text-muted)", flexShrink: 0, display: "grid", placeItems: "center" }}
                          >
                            <ChevronDown size={16} />
                          </motion.span>
                        </button>

                        <AnimatePresence initial={false}>
                          {isOpen && (
                            <motion.div
                              className="group-card-body"
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
                            >
                              {groupItems.map((project) => {
                                const meta = stateMeta(project.status.state);
                                const doneCount = project.status.plan.filter((p) => p.done).length;
                                const totalPlan = project.status.plan.length;
                                const planPct = totalPlan > 0 ? Math.round((doneCount / totalPlan) * 100) : 0;
                                const nextPlan = project.status.plan.find((p) => !p.done);
                                const latestRecap =
                                  project.status.recap[0] ??
                                  project.git.recentCommits[0]?.subject ??
                                  "Click Sync Recap to pull latest Git activity";

                                return (
                                  <div
                                    key={project.id}
                                    className={`group-child-row ${selectedId === project.id ? "selected" : ""}`}
                                    onClick={() => setSelectedId(project.id)}
                                  >
                                    <ProgressRing
                                      percent={totalPlan > 0 ? planPct : project.status.verify === "Pass" ? 100 : 15}
                                      size={34}
                                      stroke={3}
                                      color={meta.color}
                                      label={totalPlan > 0 ? `${doneCount}/${totalPlan}` : "—"}
                                    />
                                    <div style={{ minWidth: 0 }}>
                                      <div className="row-top">
                                        <span className="row-name">{project.name}</span>
                                        {project.sourceType === "remote" && (
                                          <span className="pill-badge pill-active">
                                            <Globe size={10} /> Remote
                                          </span>
                                        )}
                                        <span className={meta.pill}>{project.status.state}</span>
                                        {project.github?.openPrs[0] && (
                                          <span
                                            className={`pill-badge ${
                                              project.github.openPrs[0].ciStatus === "Fail"
                                                ? "pill-blocked"
                                                : "pill-review"
                                            }`}
                                          >
                                            <GitPullRequest size={10} /> PR #{project.github.openPrs[0].number}
                                          </span>
                                        )}
                                        {project.github && project.github.openIssues.length > 0 && (
                                          <span className="mono-tag">
                                            <CircleDot size={10} color="#38bdf8" /> {project.github.openIssues.length} issues
                                          </span>
                                        )}
                                        {project.agentSessions.map((sess) => (
                                          <span key={sess.agent} className="mono-tag" title={`Active ${sess.agent} session`}>
                                            <Bot size={10} color="#a78bfa" /> {sess.agent}
                                          </span>
                                        ))}
                                      </div>
                                      <div className="row-details" style={{ marginTop: 5 }}>
                                        <div className="row-line">
                                          <span className="row-line-label">Latest</span>
                                          <span className="row-line-text">{latestRecap}</span>
                                        </div>
                                        {nextPlan && (
                                          <div className="row-line">
                                            <span className="row-line-label">Next up</span>
                                            <span className="row-line-text">{nextPlan.text}</span>
                                          </div>
                                        )}
                                        {project.status.blockers.length > 0 && (
                                          <div className="row-blocker">
                                            <AlertTriangle size={12} />
                                            <span className="row-line-text">{project.status.blockers[0]}</span>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                                      {project.githubRepo && (
                                        <a
                                          className="btn btn-xs"
                                          href={`https://github.com/${project.githubRepo}`}
                                          target="_blank"
                                          rel="noreferrer"
                                          style={{ textDecoration: "none" }}
                                        >
                                          <ExternalLink size={11} /> GitHub
                                        </a>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    );
                  }

                  return (
                    <div key={groupName} className="group-section" style={{ marginBottom: 0 }}>
                      <AnimatePresence mode="popLayout">
                        {groupItems.map((project, index) => {
                          const meta = stateMeta(project.status.state);
                          const doneCount = project.status.plan.filter((p) => p.done).length;
                          const totalPlan = project.status.plan.length;
                          const planPct = totalPlan > 0 ? Math.round((doneCount / totalPlan) * 100) : 0;
                          const nextPlan = project.status.plan.find((p) => !p.done);
                          const latestRecap =
                            project.status.recap[0] ??
                            project.git.recentCommits[0]?.subject ??
                            "Click Sync Recap to pull latest Git activity";

                          return (
                            <motion.article
                              layout
                              key={project.id}
                              initial={{ opacity: 0, y: 12, scale: 0.99 }}
                              animate={{ opacity: 1, y: 0, scale: 1 }}
                              exit={{ opacity: 0, scale: 0.97 }}
                              transition={{
                                ...SPRING_SMOOTH,
                                delay: Math.min(index * 0.035, 0.2),
                              }}
                              whileHover={{ y: -1 }}
                              className={`project-card ${meta.row} ${
                                selectedId === project.id ? "selected" : ""
                              }`}
                              onClick={() => setSelectedId(project.id)}
                            >
                              <ProgressRing
                                percent={totalPlan > 0 ? planPct : project.status.verify === "Pass" ? 100 : 15}
                                size={40}
                                stroke={3}
                                color={meta.color}
                                label={totalPlan > 0 ? `${doneCount}/${totalPlan}` : "—"}
                              />

                              <div style={{ minWidth: 0 }}>
                                <div className="row-top">
                                  <span className="row-name">{project.name}</span>
                                  {project.sourceType === "remote" && (
                                    <span className="pill-badge pill-active">
                                      <Globe size={10} /> Remote
                                    </span>
                                  )}
                                  {project.group && <span className="mono-tag">{project.group}</span>}
                                  <span className={meta.pill}>{project.status.state}</span>
                                  {project.github?.openPrs[0] && (
                                    <span
                                      className={`pill-badge ${
                                        project.github.openPrs[0].ciStatus === "Fail"
                                          ? "pill-blocked"
                                          : "pill-review"
                                      }`}
                                    >
                                      <GitPullRequest size={10} /> PR #{project.github.openPrs[0].number}
                                    </span>
                                  )}
                                  {project.github && project.github.openIssues.length > 0 && (
                                    <span className="mono-tag">
                                      <CircleDot size={10} color="#38bdf8" /> {project.github.openIssues.length} issues
                                    </span>
                                  )}
                                  {project.agentSessions.map((sess) => (
                                    <span key={sess.agent} className="mono-tag" title={`Active ${sess.agent} session`}>
                                      <Bot size={10} color="#a78bfa" /> {sess.agent}
                                    </span>
                                  ))}
                                </div>

                                <div className="row-details">
                                  <div className="row-line">
                                    <span className="row-line-label">Latest</span>
                                    <span className="row-line-text">{latestRecap}</span>
                                  </div>
                                  {nextPlan && (
                                    <div className="row-line">
                                      <span className="row-line-label">Next up</span>
                                      <span className="row-line-text">{nextPlan.text}</span>
                                    </div>
                                  )}
                                  {project.status.blockers.length > 0 && (
                                    <div className="row-blocker">
                                      <AlertTriangle size={12} />
                                      <span className="row-line-text">{project.status.blockers[0]}</span>
                                    </div>
                                  )}
                                </div>
                              </div>

                              <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                                {project.githubRepo && (
                                  <a
                                    className="btn btn-xs"
                                    href={`https://github.com/${project.githubRepo}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    style={{ textDecoration: "none" }}
                                  >
                                    <ExternalLink size={11} /> GitHub
                                  </a>
                                )}
                              </div>
                            </motion.article>
                          );
                        })}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </div>
            )}
              </>
            )}
          </div>
        </section>

        {/* Right Docked Spatial Inspector */}
        <AnimatePresence>
          {selectedProject && (
            <motion.aside
              key="inspector-shell"
              className="inspector"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={SPRING_SMOOTH}
            >
              <div className="inspector-header">
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <h2>{selectedProject.name}</h2>
                    {selectedProject.sourceType === "remote" && (
                      <span className="pill-badge pill-active">
                        <Globe size={10} /> Remote
                      </span>
                    )}
                  </div>
                  <div className="inspector-path">
                    {selectedProject.githubRepo ?? selectedProject.group ?? "Local project"}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  {selectedProject.githubRepo && (
                    <a
                      className="btn btn-ghost btn-xs"
                      href={`https://github.com/${selectedProject.githubRepo}`}
                      target="_blank"
                      rel="noreferrer"
                      title={`Open ${selectedProject.githubRepo} on GitHub`}
                    >
                      <ExternalLink size={14} />
                    </a>
                  )}
                  <button
                    className="btn btn-ghost btn-xs"
                    onClick={() => setSelectedId(null)}
                    title="Close panel (Esc)"
                  >
                    <X size={15} />
                  </button>
                </div>
              </div>

              <motion.div
                key={selectedProject.id}
                className="inspector-body"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
              >
                <div className="glass-segmented cols-3">
                  {(
                    [
                      { id: "summary", label: "Summary" },
                      { id: "activity", label: "Activity" },
                      { id: "settings", label: "Settings" },
                    ] as const
                  ).map((t) => (
                    <button
                      key={t.id}
                      className={`seg-option ${inspectorTab === t.id ? "active" : ""}`}
                      onClick={() => setInspectorTab(t.id)}
                    >
                      {inspectorTab === t.id && (
                        <motion.span layoutId="insp-tab-pill" className="seg-pill-bg" transition={SPRING_SNAPPY} />
                      )}
                      <span className="seg-label">{t.label}</span>
                    </button>
                  ))}
                </div>

                {inspectorTab === "summary" && (
                  <>
                    <div>
                      <div className="insp-section-title">Status</div>
                      <div className="glass-segmented cols-4">
                        {(["Active", "Waiting on Review", "Blocked", "Idle"] as ProjectState[]).map(
                          (st) => {
                            const active = selectedProject.status.state === st;
                            return (
                              <button
                                key={st}
                                disabled={saving}
                                className={`seg-option ${active ? "active" : ""}`}
                                onClick={() => void saveStatusUpdate(selectedProject, { state: st })}
                              >
                                {active && (
                                  <motion.span
                                    layoutId="insp-state-pill"
                                    className="seg-pill-bg"
                                    transition={SPRING_SNAPPY}
                                  />
                                )}
                                <span className="seg-label">
                                  {st === "Waiting on Review" ? "Review" : st}
                                </span>
                              </button>
                            );
                          },
                        )}
                      </div>
                      {selectedProject.status.blockers.length === 0 && (
                        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 8 }}>
                          {cleanText(selectedProject.truth.reason)}
                        </div>
                      )}
                    </div>

                    {selectedProject.status.blockers.length > 0 && (
                      <div>
                        <div className="insp-section-title">
                          <span>Needs Your Decision</span>
                          <span className="nav-count">{selectedProject.status.blockers.length}</span>
                        </div>
                        <div className="checklist">
                          {selectedProject.status.blockers.map((b, idx) => (
                            <div
                              key={idx}
                              className="row-blocker"
                              style={{ width: "100%", justifyContent: "space-between", alignItems: "flex-start" }}
                            >
                              <span style={{ flex: 1, lineHeight: 1.4 }}>{cleanText(b)}</span>
                              <button
                                className="btn btn-xs"
                                onClick={() =>
                                  void saveStatusUpdate(selectedProject, {
                                    blockers: selectedProject.status.blockers.filter((_, i) => i !== idx),
                                  })
                                }
                              >
                                Done
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {selectedProject.github && selectedProject.github.openPrs.length > 0 && (
                      <div>
                        <div className="insp-section-title">
                          <span>Waiting for Review</span>
                          <span className="nav-count">{selectedProject.github.openPrs.length}</span>
                        </div>
                        <div className="checklist">
                          {selectedProject.github.openPrs.map((pr) => (
                            <a
                              key={pr.number}
                              href={pr.url}
                              target="_blank"
                              rel="noreferrer"
                              className="check-row"
                              style={{ textDecoration: "none", color: "inherit" }}
                            >
                              <GitPullRequest size={13} color={pr.ciStatus === "Fail" ? "#fb7185" : "#fbbf24"} />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: 550 }}>
                                  #{pr.number} {pr.title}
                                </div>
                              </div>
                              <ExternalLink size={12} color="var(--text-muted)" />
                            </a>
                          ))}
                        </div>
                      </div>
                    )}

                    {selectedProject.github && selectedProject.github.milestones.length > 0 && (
                      <div>
                        <div className="insp-section-title">
                          <span>Milestones</span>
                          <span className="nav-count">{selectedProject.github.milestones.length}</span>
                        </div>
                        <div className="checklist">
                          {selectedProject.github.milestones.map((m) => {
                            const total = m.openIssues + m.closedIssues;
                            const pct = total > 0 ? Math.round((m.closedIssues / total) * 100) : 0;
                            return (
                              <a
                                key={m.title}
                                href={m.url}
                                target="_blank"
                                rel="noreferrer"
                                className="check-row"
                                style={{ textDecoration: "none", color: "inherit", flexDirection: "column", alignItems: "stretch", gap: 6 }}
                              >
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 550 }}>
                                    <Target size={13} color="#a78bfa" /> {m.title}
                                  </span>
                                  <span className="mono-tag">{m.closedIssues}/{total} ({pct}%)</span>
                                </div>
                                <div style={{ height: 4, borderRadius: 99, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
                                  <div style={{ width: `${pct}%`, height: "100%", background: "#a78bfa", borderRadius: 99 }} />
                                </div>
                              </a>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {selectedProject.status.plan.length > 0 && (
                      <div>
                        <div className="insp-section-title">
                          <span>Next Up</span>
                          <span className="nav-count">
                            {selectedProject.status.plan.filter((p) => p.done).length}/
                            {selectedProject.status.plan.length}
                          </span>
                        </div>
                        <div className="checklist">
                          {selectedProject.status.plan.map((item, idx) => (
                            <motion.div
                              layout
                              key={`${idx}-${item.text}`}
                              className={`check-row ${item.done ? "done" : ""}`}
                            >
                              <motion.button
                                whileTap={{ scale: 0.85 }}
                                className={`check-toggle ${item.done ? "checked" : ""}`}
                                onClick={() => {
                                  const nextPlan = selectedProject.status.plan.map((p, i) =>
                                    i === idx ? { ...p, done: !p.done } : p,
                                  );
                                  void saveStatusUpdate(selectedProject, { plan: nextPlan });
                                }}
                                aria-label={item.done ? "Mark incomplete" : "Mark complete"}
                              >
                                {item.done && <Check size={11} strokeWidth={3} />}
                              </motion.button>
                              <span style={{ flex: 1, lineHeight: 1.4 }}>{cleanText(item.text)}</span>
                            </motion.div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}

                {inspectorTab === "activity" && (
                  <>
                    {selectedProject.github && selectedProject.github.mergedPrs.length > 0 && (
                      <div>
                        <div className="insp-section-title">
                          <span>Shipped Recently</span>
                          <span className="nav-count">{selectedProject.github.mergedPrs.length}</span>
                        </div>
                        <div className="checklist">
                          {selectedProject.github.mergedPrs.slice(0, 6).map((pr) => (
                            <a
                              key={pr.number}
                              href={pr.url}
                              target="_blank"
                              rel="noreferrer"
                              className="check-row"
                              style={{ textDecoration: "none", color: "inherit" }}
                            >
                              <GitMerge size={13} color="#34d399" style={{ flexShrink: 0 }} />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: 500 }}>#{pr.number} {pr.title}</div>
                                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                                  {pr.mergedAt.slice(0, 10)}
                                </div>
                              </div>
                            </a>
                          ))}
                        </div>
                      </div>
                    )}

                    {selectedProject.agentSessions.length > 0 && (
                      <div>
                        <div className="insp-section-title">
                          <span>Agent Activity</span>
                          <span className="nav-count">{selectedProject.agentSessions.length}</span>
                        </div>
                        <div className="checklist">
                          {selectedProject.agentSessions.map((sess) => (
                            <div key={sess.agent} className="dispatch-card" style={{ padding: 10, gap: 6 }}>
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 12.5 }}>
                                  <Bot size={13} color="#a78bfa" /> {sess.agent}
                                </span>
                                {sess.lastActiveAt && (
                                  <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
                                    {new Date(sess.lastActiveAt).toLocaleDateString()}
                                  </span>
                                )}
                              </div>
                              {sess.summary && (
                                <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                                  {sess.summary}
                                </div>
                              )}
                              {sess.tasks.length > 0 && (
                                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                  {sess.tasks.slice(0, 5).map((t, i) => (
                                    <div key={i} style={{ fontSize: 11.5, color: t.done ? "var(--text-muted)" : "var(--text)", textDecoration: t.done ? "line-through" : "none" }}>
                                      {t.done ? "✓ " : "○ "}
                                      {t.text}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {selectedProject.claudeSync?.memoryIndex && (
                      <div>
                        <div className="insp-section-title">
                          <span>Saved Agent Notes</span>
                          <button
                            className="btn btn-ghost btn-xs"
                            onClick={() => setShowClaudeMemory((v) => !v)}
                          >
                            {showClaudeMemory ? "Hide" : "Show"}
                          </button>
                        </div>
                        {showClaudeMemory && (
                          <div className="console-box" style={{ maxHeight: 210 }}>
                            {selectedProject.claudeSync.memoryIndex}
                          </div>
                        )}
                      </div>
                    )}

                    {selectedProject.github && selectedProject.github.openIssues.length > 0 && (
                      <div>
                        <div className="insp-section-title">
                          <span>Open Issues</span>
                          <span className="nav-count">{selectedProject.github.openIssues.length}</span>
                        </div>
                        <div className="checklist">
                          {selectedProject.github.openIssues.slice(0, 6).map((issue) => (
                            <a
                              key={issue.number}
                              href={issue.url}
                              target="_blank"
                              rel="noreferrer"
                              className="check-row"
                              style={{ textDecoration: "none", color: "inherit" }}
                            >
                              <CircleDot size={13} color="#38bdf8" style={{ flexShrink: 0 }} />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: 500 }}>#{issue.number} {issue.title}</div>
                              </div>
                            </a>
                          ))}
                        </div>
                      </div>
                    )}

                    {selectedProject.git.recentCommits.length > 0 && (
                      <div>
                        <div className="insp-section-title">Recent Updates</div>
                        <div className="commit-list">
                          {selectedProject.git.recentCommits.slice(0, 8).map((c) => (
                            <div key={c.hash} className="commit-row">
                              <span className="commit-date">{c.date}</span>
                              <span className="commit-msg" title={c.subject}>
                                {c.subject}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div>
                      <div className="insp-section-title">Notes</div>
                      <div className="checklist">
                        {selectedProject.status.recap.map((r, idx) => (
                          <div key={idx} className="check-row">
                            <CheckCircle2 size={13} color="#34d399" style={{ flexShrink: 0 }} />
                            <span style={{ flex: 1 }}>{r}</span>
                            <button
                              className="btn btn-ghost btn-xs"
                              onClick={() =>
                                void saveStatusUpdate(selectedProject, {
                                  recap: selectedProject.status.recap.filter((_, i) => i !== idx),
                                })
                              }
                            >
                              <X size={12} />
                            </button>
                          </div>
                        ))}
                        <div className="input-inline" style={{ marginTop: 4 }}>
                          <input
                            className="text-input"
                            placeholder="Add a note..."
                            value={newRecapText}
                            onChange={(e) => setNewRecapText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && newRecapText.trim()) {
                                void saveStatusUpdate(selectedProject, {
                                  recap: [newRecapText.trim(), ...selectedProject.status.recap],
                                });
                                setNewRecapText("");
                              }
                            }}
                          />
                          <button
                            className="btn btn-xs"
                            onClick={() => {
                              if (!newRecapText.trim()) return;
                              void saveStatusUpdate(selectedProject, {
                                recap: [newRecapText.trim(), ...selectedProject.status.recap],
                              });
                              setNewRecapText("");
                            }}
                          >
                            <Plus size={12} />
                          </button>
                        </div>
                      </div>
                    </div>
                  </>
                )}

                {inspectorTab === "settings" && (
                  <>
                    <div>
                      <div className="insp-section-title">Location</div>
                      <div className="inspector-path" style={{ marginTop: 0 }}>
                        {selectedProject.path}
                      </div>
                    </div>

                    <div>
                      <div className="insp-section-title">Project Name &amp; Group</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <input
                          className="text-input"
                          placeholder="Display name"
                          value={inspectorNameDraft}
                          onChange={(e) => setInspectorNameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              void handleSaveMeta(selectedProject, inspectorNameDraft, inspectorGroupDraft);
                            }
                          }}
                        />
                        <div className="input-inline">
                          <input
                            className="text-input"
                            placeholder="Group (e.g., Work, Client...)"
                            value={inspectorGroupDraft}
                            onChange={(e) => setInspectorGroupDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                void handleSaveMeta(selectedProject, inspectorNameDraft, inspectorGroupDraft);
                              }
                            }}
                          />
                          <button
                            className="btn btn-xs btn-primary"
                            onClick={() =>
                              void handleSaveMeta(selectedProject, inspectorNameDraft, inspectorGroupDraft)
                            }
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    </div>

                    <div style={{ paddingTop: 12, borderTop: "1px solid var(--border)" }}>
                      <button
                        className="btn btn-xs btn-danger"
                        onClick={() => void handleRemove(selectedProject.id)}
                      >
                        <Trash2 size={12} /> Remove Project
                      </button>
                    </div>
                  </>
                )}
              </motion.div>
            </motion.aside>
          )}
        </AnimatePresence>
      </div>

      {/* Track Repository Modal */}
      <AnimatePresence>
        {showAddModal && (
          <motion.div
            className="modal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowAddModal(false)}
          >
            <motion.div
              className="modal-panel"
              initial={{ opacity: 0, scale: 0.95, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 12 }}
              transition={SPRING_SNAPPY}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="inspector-header" style={{ padding: 0, borderBottom: "none" }}>
                <h2>Track Repositories</h2>
                <button className="btn btn-ghost btn-xs" onClick={() => setShowAddModal(false)}>
                  <X size={15} />
                </button>
              </div>

              <div className="glass-segmented cols-3">
                <button
                  className={`seg-option ${addMode === "remote" ? "active" : ""}`}
                  onClick={() => {
                    setAddMode("remote");
                    setScanCandidates(null);
                  }}
                >
                  {addMode === "remote" && (
                    <motion.span layoutId="add-mode-pill" className="seg-pill-bg" transition={SPRING_SNAPPY} />
                  )}
                  <span className="seg-label">GitHub Repo</span>
                </button>
                <button
                  className={`seg-option ${addMode === "scan" ? "active" : ""}`}
                  onClick={() => setAddMode("scan")}
                >
                  {addMode === "scan" && (
                    <motion.span layoutId="add-mode-pill" className="seg-pill-bg" transition={SPRING_SNAPPY} />
                  )}
                  <span className="seg-label">Scan Folder</span>
                </button>
                <button
                  className={`seg-option ${addMode === "single" ? "active" : ""}`}
                  onClick={() => {
                    setAddMode("single");
                    setScanCandidates(null);
                  }}
                >
                  {addMode === "single" && (
                    <motion.span layoutId="add-mode-pill" className="seg-pill-bg" transition={SPRING_SNAPPY} />
                  )}
                  <span className="seg-label">Local Path</span>
                </button>
              </div>

              <div className="input-inline">
                <input
                  className="text-input"
                  autoFocus
                  placeholder={
                    addMode === "remote"
                      ? "owner/repo or https://github.com/owner/repo"
                      : addMode === "scan"
                        ? "C:\\Users\\you\\Projects (imports all git repos inside)"
                        : "C:\\Users\\you\\Projects\\my-repo"
                  }
                  value={pathInput}
                  onChange={(e) => setPathInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleAddSubmit();
                  }}
                />
                {addMode !== "remote" && (
                  <button className="btn" onClick={() => void handleBrowseFolder()}>
                    <FolderOpen size={14} /> Browse...
                  </button>
                )}
              </div>

              <input
                className="text-input"
                placeholder={
                  addMode === "remote"
                    ? "Group name (optional — e.g., Client, Remote, Side Projects)"
                    : "Group name (optional — auto-fills from folder name)"
                }
                value={groupInput}
                onChange={(e) => setGroupInput(e.target.value)}
              />

              {scanCandidates && scanCandidates.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div className="insp-section-title" style={{ marginBottom: 2 }}>
                    <span>Found {scanCandidates.length} Git Repo(s) — Select to Import</span>
                    <span>{selectedCandidates.size} selected</span>
                  </div>
                  <div className="checklist" style={{ maxHeight: 220, overflowY: "auto" }}>
                    {scanCandidates.map((c) => {
                      const checked = selectedCandidates.has(c.path);
                      return (
                        <div key={c.id} className="check-row">
                          <button
                            className={`check-toggle ${checked ? "checked" : ""}`}
                            disabled={c.alreadyTracked}
                            onClick={() => {
                              setSelectedCandidates((prev) => {
                                const next = new Set(prev);
                                if (next.has(c.path)) next.delete(c.path);
                                else next.add(c.path);
                                return next;
                              });
                            }}
                          >
                            {checked && <Check size={11} strokeWidth={3} />}
                          </button>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 550 }}>{c.name}</div>
                            <div className="inspector-path" style={{ marginTop: 0 }}>{c.path}</div>
                          </div>
                          {c.alreadyTracked && (
                            <span className="mono-tag">Tracked</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button
                  className="btn"
                  onClick={() => {
                    setShowAddModal(false);
                    setScanCandidates(null);
                  }}
                >
                  Cancel
                </button>
                {addMode === "scan" && scanCandidates && scanCandidates.length > 0 ? (
                  <button
                    className="btn btn-primary"
                    disabled={selectedCandidates.size === 0}
                    onClick={() => void handleConfirmImport()}
                  >
                    Import Selected ({selectedCandidates.size})
                  </button>
                ) : (
                  <button className="btn btn-primary" onClick={() => void handleAddSubmit()}>
                    {addMode === "remote"
                      ? "Track GitHub Repo"
                      : addMode === "scan"
                        ? "Preview Repos"
                        : "Add Repository"}
                  </button>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Morning Standup Modal */}
      <AnimatePresence>
        {standup && (
          <motion.div
            className="modal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setStandup(null)}
          >
            <motion.div
              className="modal-panel standup-modal"
              initial={{ opacity: 0, scale: 0.95, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 12 }}
              transition={SPRING_SNAPPY}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="inspector-header" style={{ padding: 0, borderBottom: "none", alignItems: "center" }}>
                <div>
                  <div className="hero-eyebrow" style={{ marginBottom: 2 }}>
                    <Sparkles size={11} style={{ verticalAlign: "-1px", marginRight: 5 }} />
                    {new Date(standup.generatedAt).toLocaleDateString(undefined, {
                      weekday: "long",
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </div>
                  <h2 style={{ margin: 0 }}>Morning Standup Briefing</h2>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div className="glass-segmented" style={{ width: 170 }}>
                    <button
                      className={`seg-option ${standupTab === "visual" ? "active" : ""}`}
                      onClick={() => setStandupTab("visual")}
                    >
                      {standupTab === "visual" && (
                        <motion.span layoutId="standup-tab-pill" className="seg-pill-bg" transition={SPRING_SNAPPY} />
                      )}
                      <span className="seg-label">Briefing</span>
                    </button>
                    <button
                      className={`seg-option ${standupTab === "markdown" ? "active" : ""}`}
                      onClick={() => setStandupTab("markdown")}
                    >
                      {standupTab === "markdown" && (
                        <motion.span layoutId="standup-tab-pill" className="seg-pill-bg" transition={SPRING_SNAPPY} />
                      )}
                      <span className="seg-label">Markdown</span>
                    </button>
                  </div>
                  <button className="btn btn-ghost btn-xs" onClick={() => setStandup(null)}>
                    <X size={15} />
                  </button>
                </div>
              </div>

              {standupTab === "markdown" ? (
                <pre className="standup-code">{standup.markdown}</pre>
              ) : (
                <>
                  <div className="standup-stats">
                    <div className="standup-stat">
                      <div className="standup-stat-num">{standup.counts.total}</div>
                      <div className="standup-stat-label">Tracked Repos</div>
                    </div>
                    <div className="standup-stat">
                      <div className="standup-stat-num" style={{ color: "var(--rose)" }}>
                        {standup.counts.blocked}
                      </div>
                      <div className="standup-stat-label">Needs Decision</div>
                    </div>
                    <div className="standup-stat">
                      <div className="standup-stat-num" style={{ color: "var(--amber)" }}>
                        {standup.counts.waitingOnReview}
                      </div>
                      <div className="standup-stat-label">Ready to Review</div>
                    </div>
                    <div className="standup-stat">
                      <div className="standup-stat-num" style={{ color: "var(--sky)" }}>
                        {standup.counts.active}
                      </div>
                      <div className="standup-stat-label">In Progress</div>
                    </div>
                  </div>

                  {(
                    [
                      {
                        key: "blocked",
                        title: "Needs Your Decision",
                        cls: "sec-blocked",
                        dot: "dot-blocked",
                        list: projects.filter((p) => isProjectBlocked(p)),
                      },
                      {
                        key: "review",
                        title: "Ready for Review",
                        cls: "sec-review",
                        dot: "dot-review",
                        list: projects.filter((p) => p.status.state === "Waiting on Review"),
                      },
                      {
                        key: "active",
                        title: "Active Work",
                        cls: "sec-active",
                        dot: "dot-active",
                        list: projects.filter(
                          (p) => p.status.state === "Active" && !isProjectBlocked(p),
                        ),
                      },
                    ] as const
                  )
                    .filter((sec) => sec.list.length > 0)
                    .map((sec) => (
                      <div key={sec.key} className={`standup-section ${sec.cls}`}>
                        <div className="standup-sec-title">
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                            <span className={`status-dot ${sec.dot}`} />
                            {sec.title}
                          </span>
                          <span className="nav-count">{sec.list.length}</span>
                        </div>
                        {sec.list.map((p) => {
                          const nextTask = p.status.plan.find((t) => !t.done)?.text;
                          const latest = p.status.recap[0] ?? p.git.recentCommits[0]?.subject;
                          return (
                            <button
                              key={p.id}
                              className="standup-item"
                              onClick={() => {
                                setSelectedId(p.id);
                                setStandup(null);
                              }}
                            >
                              <div style={{ minWidth: 0 }}>
                                <div className="standup-item-name">
                                  <span>{p.name}</span>
                                  {p.git.isGitRepo && (
                                    <span className="mono-tag">{p.git.branch}</span>
                                  )}
                                  {p.group && <span className="mono-tag">{p.group}</span>}
                                </div>
                                {p.status.blockers[0] && (
                                  <div className="standup-item-meta" style={{ color: "var(--rose)" }}>
                                    Blocker: {p.status.blockers[0]}
                                  </div>
                                )}
                                <div className="standup-item-meta">
                                  {nextTask
                                    ? `Next: ${nextTask}`
                                    : latest
                                      ? `Recent: ${latest}`
                                      : "No recent updates recorded"}
                                </div>
                              </div>
                              <span className={stateMeta(p.status.state).pill}>
                                {p.status.state}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ))}

                  {standup.counts.blocked === 0 &&
                    standup.counts.waitingOnReview === 0 &&
                    standup.counts.active === 0 && (
                      <div className="standup-section">
                        <div className="bento-empty" style={{ padding: "8px 4px" }}>
                          <CheckCircle2 size={16} color="#34d399" />
                          <span>All tracked repositories are currently idle with zero blockers.</span>
                        </div>
                      </div>
                    )}

                  {standup.counts.idle > 0 && (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "0 2px" }}>
                      + {standup.counts.idle} quiet/idle repo{standup.counts.idle > 1 ? "s" : ""} (
                      {projects
                        .filter((p) => p.status.state === "Idle" && !isProjectBlocked(p))
                        .map((p) => p.name)
                        .join(", ")}
                      )
                    </div>
                  )}
                </>
              )}

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                  Click any project above to jump straight into its workspace
                </span>
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    void navigator.clipboard.writeText(standup.markdown);
                    setCopiedStandup(true);
                  }}
                >
                  {copiedStandup ? (
                    <>
                      <Check size={13} /> Copied Markdown
                    </>
                  ) : (
                    <>
                      <Copy size={13} /> Copy for Slack / Docs
                    </>
                  )}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating Glass Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div
            className="toast"
            initial={{ opacity: 0, y: 24, x: "-50%", scale: 0.96 }}
            animate={{ opacity: 1, y: 0, x: "-50%", scale: 1 }}
            exit={{ opacity: 0, y: 16, x: "-50%", scale: 0.96 }}
            transition={SPRING_SNAPPY}
          >
            <Check size={14} color="#34d399" />
            <span>{toast.label}</span>
            {toast.detail && <span className="toast-mono">{toast.detail}</span>}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
