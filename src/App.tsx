import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ClipboardList,
  Copy,
  FolderOpen,
  FolderPlus,
  GitBranch,
  LayoutDashboard,
  Layers,
  Play,
  Plus,
  RefreshCw,
  Search,
  Shield,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { ControlCenter } from "./components/ControlCenter.tsx";
import {
  addProject,
  addProjectsBatch,
  autoRecapAll,
  autoRecapOne,
  buildAgentCommand,
  fetchProjects,
  fetchStandup,
  installBastion,
  previewFolder,
  removeProject,
  streamProjectExec,
  updateProjectMeta,
  updateProjectStatus,
  type ScanCandidate,
} from "./core/api.ts";
import { isProjectBlocked, matchesStateFilter } from "./core/statusParser.ts";
import type {
  AgentKind,
  ManagedProject,
  ProjectState,
  StandupSummary,
  VerifyHealth,
} from "./core/types.ts";

type FilterState = "ControlCenter" | "All" | ProjectState;

const SPRING_SNAPPY = { type: "spring" as const, stiffness: 460, damping: 34 };
const SPRING_SMOOTH = { type: "spring" as const, stiffness: 320, damping: 30 };

const AGENTS: Array<{ id: AgentKind; label: string; cli: string }> = [
  { id: "claude", label: "Claude", cli: "claude" },
  { id: "antigravity", label: "Agy", cli: "agy" },
  { id: "codex", label: "Codex", cli: "codex" },
  { id: "cursor", label: "Cursor", cli: "cursor ." },
];

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
  const [agent, setAgent] = useState<AgentKind>(() => {
    const saved = localStorage.getItem("agent-manager:preferred-agent") as AgentKind | null;
    return saved ?? "claude";
  });

  const [showAddModal, setShowAddModal] = useState(false);
  const [addMode, setAddMode] = useState<"single" | "scan">("scan");
  const [pathInput, setPathInput] = useState("");
  const [groupInput, setGroupInput] = useState("");
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [inspectorNameDraft, setInspectorNameDraft] = useState("");
  const [inspectorGroupDraft, setInspectorGroupDraft] = useState("");
  const [scanCandidates, setScanCandidates] = useState<ScanCandidate[] | null>(null);
  const [selectedCandidates, setSelectedCandidates] = useState<Set<string>>(new Set());
  const [standup, setStandup] = useState<StandupSummary | null>(null);
  const [standupTab, setStandupTab] = useState<"visual" | "markdown">("visual");
  const [copiedStandup, setCopiedStandup] = useState(false);

  const [newPlanText, setNewPlanText] = useState("");
  const [newRecapText, setNewRecapText] = useState("");
  const [newBlockerText, setNewBlockerText] = useState("");
  const [customPrompt, setCustomPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ label: string; detail?: string } | null>(null);

  // Embedded live console state
  const [execMode, setExecMode] = useState<"agent" | "shell">("agent");
  const [consoleOutput, setConsoleOutput] = useState("");
  const [runningExec, setRunningExec] = useState(false);
  const execAbortRef = useRef<AbortController | null>(null);
  const consoleEndRef = useRef<HTMLDivElement>(null);

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
    consoleEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [consoleOutput]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const inField = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (e.key === "/" && !inField) {
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
    return projects.filter((p) => {
      if (!matchesStateFilter(p, filter)) return false;
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
  const bastionPct = stats.total > 0 ? Math.round((stats.guarded / stats.total) * 100) : 0;
  const activeAgentObj = AGENTS.find((a) => a.id === agent) ?? AGENTS[0]!;

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
      if (addMode === "single") {
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
          showToast("No Git repos found in folder", "Switch to 'Single Repo Path' to add a non-git folder");
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to scan folder");
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

  async function handleAutoRecapAll() {
    setLoading(true);
    setError(null);
    try {
      const updated = await autoRecapAll();
      setProjects(updated);
      showToast(`Synced Git recaps across ${updated.length} project(s)`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to sync recaps");
    } finally {
      setLoading(false);
    }
  }

  async function handleAutoRecapOne(project: ManagedProject) {
    setSaving(true);
    setError(null);
    try {
      const updated = await autoRecapOne(project.id);
      setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      showToast(`Updated ${project.name}`, ".agents/status.md synced from Git");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to sync recap");
    } finally {
      setSaving(false);
    }
  }

  async function handleInstallBastion(project: ManagedProject) {
    setSaving(true);
    setError(null);
    try {
      const res = await installBastion(project.id);
      setProjects((prev) => prev.map((p) => (p.id === res.project.id ? res.project : p)));
      showToast(
        `Bastion installed in ${project.name}`,
        res.detectedVerifyCmd ? `Auto-wired verify: ${res.detectedVerifyCmd}` : "Existing rules preserved",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to install Bastion");
    } finally {
      setSaving(false);
    }
  }

  async function handleCopyCmd(project: ManagedProject, prompt?: string) {
    try {
      const cmd = await buildAgentCommand(project.id, agent, prompt);
      await navigator.clipboard.writeText(cmd);
      showToast(`Copied ${activeAgentObj.label} command`, cmd);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to copy command");
    }
  }

  async function handleRunExec(
    project: ManagedProject,
    mode: "verify" | "agent" | "shell",
    prompt?: string,
  ) {
    execAbortRef.current?.abort();
    const controller = new AbortController();
    execAbortRef.current = controller;
    setRunningExec(true);
    setConsoleOutput("");
    try {
      await streamProjectExec(
        project.id,
        { mode, agent, prompt },
        (chunk) => setConsoleOutput((prev) => prev + chunk),
        controller.signal,
      );
      await loadAll(true);
      if (mode === "verify") {
        showToast("Verify completed", "Verification Health updated");
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setConsoleOutput((prev) => prev + `\n[error] ${e instanceof Error ? e.message : "Run failed"}\n`);
      }
    } finally {
      setRunningExec(false);
    }
  }

  function handleStopExec() {
    execAbortRef.current?.abort();
    setRunningExec(false);
    setConsoleOutput((prev) => prev + "\n[stopped by user]\n");
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
              <div className="brand-sub">Control Center</div>
            </div>
          </div>

          <div>
            <div className="rail-section-label">Workspace Views</div>
            <nav className="rail-nav">
              <button
                className={`nav-item ${filter === "ControlCenter" ? "active" : ""}`}
                onClick={() => setFilter("ControlCenter")}
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
                    <LayoutDashboard size={13} color="#38bdf8" />
                    Control Center
                  </span>
                </span>
              </button>
              {(
                [
                  { id: "All", label: "All Projects", count: stats.total, dot: "dot-all" },
                  { id: "Blocked", label: "Needs Decision", count: stats.blocked, dot: "dot-blocked" },
                  { id: "Waiting on Review", label: "Ready to Review", count: stats.review, dot: "dot-review" },
                  { id: "Active", label: "In Progress", count: stats.active, dot: "dot-active" },
                  { id: "Idle", label: "Idle", count: stats.idle, dot: "dot-idle" },
                ] as Array<{ id: FilterState; label: string; count: number; dot: string }>
              ).map((item) => {
                const isActive = filter === item.id;
                return (
                  <button
                    key={item.id}
                    className={`nav-item ${isActive ? "active" : ""}`}
                    onClick={() => {
                      setFilter(item.id);
                      setActiveGroup(null);
                    }}
                  >
                    {isActive && (
                      <motion.span
                        layoutId="nav-active-pill"
                        className="nav-pill-bg"
                        transition={SPRING_SNAPPY}
                      />
                    )}
                    <span className="nav-content">
                      <span className="nav-left">
                        <span className={`status-dot ${item.dot}`} />
                        {item.label}
                      </span>
                      <span className="nav-count">{item.count}</span>
                    </span>
                  </button>
                );
              })}
            </nav>
          </div>

          {groups.length > 0 && (
            <div>
              <div className="rail-section-label">Groups</div>
              <nav className="rail-nav">
                {groups.map(([groupName, count]) => {
                  const isActive = activeGroup === groupName && filter !== "ControlCenter";
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

          <div>
            <div className="rail-section-label">Preferred Agent</div>
            <div className="glass-segmented" role="group" aria-label="Preferred Agent">
              {AGENTS.map((a) => {
                const isActive = agent === a.id;
                return (
                  <button
                    key={a.id}
                    className={`seg-option ${isActive ? "active" : ""}`}
                    onClick={() => {
                      setAgent(a.id);
                      localStorage.setItem("agent-manager:preferred-agent", a.id);
                    }}
                  >
                    {isActive && (
                      <motion.span
                        layoutId="agent-active-pill"
                        className="seg-pill-bg"
                        transition={SPRING_SNAPPY}
                      />
                    )}
                    <span className="seg-label">{a.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="rail-footer">
            <div className="bastion-card">
              <ProgressRing
                percent={bastionPct}
                size={38}
                stroke={3.5}
                color="#34d399"
                label={`${bastionPct}%`}
              />
              <div>
                <div className="bastion-card-title">Bastion Guardrails</div>
                <div className="bastion-card-sub">
                  {stats.guarded} of {stats.total} repos protected
                </div>
              </div>
            </div>

            <motion.button whileTap={{ scale: 0.98 }} className="btn" onClick={() => void handleOpenStandup()}>
              <ClipboardList size={14} /> Morning Standup
            </motion.button>
            <motion.button
              whileTap={{ scale: 0.98 }}
              className="btn"
              onClick={() => void handleAutoRecapAll()}
              disabled={loading}
            >
              <RefreshCw size={14} /> Sync All Recaps
            </motion.button>
            <motion.button
              whileTap={{ scale: 0.98 }}
              className="btn btn-primary"
              onClick={() => setShowAddModal(true)}
            >
              <FolderPlus size={14} /> Track Repository
            </motion.button>
          </div>
        </aside>

        {/* Center Workspace */}
        <section className="main-pane">
          <header className="main-header">
            <div className="header-title-group">
              <h1>
                {filter === "ControlCenter"
                  ? "Control Center"
                  : filter === "All"
                    ? "All Projects"
                    : filter}
              </h1>
              <span className="header-count">
                {filter === "ControlCenter"
                  ? `${stats.total} tracked`
                  : `${filteredProjects.length} ${filteredProjects.length === 1 ? "repo" : "repos"}`}
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
                onSyncAll={() => void handleAutoRecapAll()}
                loading={loading}
              />
            ) : (
              <>
            {/* Today at a Glance Hero */}
            <motion.div
              className="hero-brief"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={SPRING_SMOOTH}
            >
              <div>
                <div className="hero-eyebrow">
                  <Sparkles size={11} style={{ verticalAlign: "-1px", marginRight: 5 }} />
                  Today at a Glance
                </div>
                <p className="hero-headline">{heroHeadline}</p>
              </div>
              <div className="hero-actions">
                {stats.blocked > 0 && filter !== "Blocked" && (
                  <button className="btn btn-danger btn-xs" onClick={() => setFilter("Blocked")}>
                    <AlertTriangle size={12} /> View Blockers ({stats.blocked})
                  </button>
                )}
                <button className="btn btn-xs" onClick={() => void handleOpenStandup()}>
                  <ClipboardList size={12} /> Standup Summary
                </button>
              </div>
            </motion.div>

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
                {groupedProjects.map(([groupName, groupItems]) => (
                  <div key={groupName} className="group-section">
                    {(groupedProjects.length > 1 || groupName !== "Ungrouped") && (
                      <div className="group-header">
                        <span className="group-header-left">
                          <FolderOpen size={12} />
                          {groupName}
                        </span>
                        <span className="nav-count">{groupItems.length}</span>
                      </div>
                    )}
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
                                <span className={meta.pill}>{project.status.state}</span>
                                {project.git.isGitRepo && (
                                  <span className={`mono-tag ${project.git.dirtyCount > 0 ? "dirty" : ""}`}>
                                    <GitBranch size={11} />
                                    {project.git.branch}
                                    {project.git.dirtyCount > 0 ? ` · ${project.git.dirtyCount} dirty` : ""}
                                  </span>
                                )}
                                {project.status.verify === "Pass" && (
                                  <span className="pill-badge pill-pass">Verify Pass</span>
                                )}
                                {project.antiSlop.hasSkill && (
                                  <span className="mono-tag" title="Bastion guardrails active">
                                    <Shield size={11} color="#34d399" /> Bastion
                                  </span>
                                )}
                              </div>

                              <div className="row-details">
                                <div className="row-line">
                                  <span className="row-line-label">Recent</span>
                                  <span className="row-line-text">{latestRecap}</span>
                                </div>
                                <div className="row-line">
                                  <span className="row-line-label">Next up</span>
                                  <span className="row-line-text">
                                    {nextPlan ? nextPlan.text : "All milestones done — add next goal"}
                                  </span>
                                </div>
                                {project.status.blockers.length > 0 && (
                                  <div className="row-blocker">
                                    <AlertTriangle size={12} />
                                    <span className="row-line-text">{project.status.blockers[0]}</span>
                                  </div>
                                )}
                              </div>
                            </div>

                            <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                              <motion.button
                                whileTap={{ scale: 0.96 }}
                                className="btn btn-xs btn-primary"
                                onClick={() => void handleCopyCmd(project)}
                              >
                                <Terminal size={11} /> Copy {activeAgentObj.label}
                              </motion.button>
                              <motion.button
                                whileTap={{ scale: 0.96 }}
                                className="btn btn-xs"
                                onClick={() => void handleAutoRecapOne(project)}
                              >
                                <RefreshCw size={11} /> Sync Recap
                              </motion.button>
                            </div>
                          </motion.article>
                        );
                      })}
                    </AnimatePresence>
                  </div>
                ))}
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
                  <h2>{selectedProject.name}</h2>
                  <div className="inspector-path">{selectedProject.path}</div>
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  <button
                    className="btn btn-ghost btn-xs"
                    onClick={() => void handleRemove(selectedProject.id)}
                    title="Untrack repository (keeps files on disk)"
                    style={{ color: "var(--rose)" }}
                  >
                    <Trash2 size={14} />
                  </button>
                  <button
                    className="btn btn-ghost btn-xs"
                    onClick={() => setSelectedId(null)}
                    title="Close inspector (Esc)"
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
                <div>
                  <div className="insp-section-title">Display Name &amp; Group</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <input
                      className="text-input"
                      placeholder="Display name (does not rename folder)"
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
                        placeholder="Group (e.g., Work, Side Projects...)"
                        value={inspectorGroupDraft}
                        onChange={(e) => setInspectorGroupDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            void handleSaveMeta(selectedProject, inspectorNameDraft, inspectorGroupDraft);
                          }
                        }}
                      />
                      <button
                        className="btn btn-xs"
                        onClick={() =>
                          void handleSaveMeta(selectedProject, inspectorNameDraft, inspectorGroupDraft)
                        }
                      >
                        Save
                      </button>
                    </div>
                  </div>
                </div>

                <div>
                  <div className="insp-section-title">Project Status</div>
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
                </div>

                <div>
                  <div className="insp-section-title">Verification Health</div>
                  <div className="glass-segmented cols-3">
                    {(["Pass", "Fail", "Unknown"] as VerifyHealth[]).map((v) => {
                      const active = selectedProject.status.verify === v;
                      return (
                        <button
                          key={v}
                          disabled={saving}
                          className={`seg-option ${active ? "active" : ""}`}
                          onClick={() => void saveStatusUpdate(selectedProject, { verify: v })}
                        >
                          {active && (
                            <motion.span
                              layoutId="insp-verify-pill"
                              className="seg-pill-bg"
                              transition={SPRING_SNAPPY}
                            />
                          )}
                          <span className="seg-label">{v}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <div className="insp-section-title">
                    <span>Bastion Guardrails</span>
                    {selectedProject.antiSlop.hasSkill && (
                      <span className="pill-badge pill-pass">Protected</span>
                    )}
                  </div>
                  <div className="dispatch-card">
                    {selectedProject.antiSlop.hasSkill ? (
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                          Verify:{" "}
                          <code style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>
                            {selectedProject.antiSlop.verifyCmd ?? "auto-detected"}
                          </code>
                        </span>
                        <button
                          className="btn btn-xs"
                          disabled={saving}
                          onClick={() => void handleInstallBastion(selectedProject)}
                          title="Update Bastion skill files (preserves your learnings & rules)"
                        >
                          <RefreshCw size={11} /> Update
                        </button>
                      </div>
                    ) : (
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                          Not set up yet. Install Bastion rules, skills &amp; auto-detect verify.
                        </span>
                        <motion.button
                          whileTap={{ scale: 0.96 }}
                          className="btn btn-xs btn-primary"
                          disabled={saving}
                          onClick={() => void handleInstallBastion(selectedProject)}
                        >
                          <Shield size={12} /> Setup Bastion
                        </motion.button>
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <div className="insp-section-title">
                    <span>Built-In Agent &amp; Verify Console</span>
                    <button
                      className="btn btn-ghost btn-xs"
                      onClick={() => void handleCopyCmd(selectedProject)}
                      title="Copy command to run in external terminal"
                    >
                      <Copy size={11} /> Copy Cmd
                    </button>
                  </div>
                  <div className="dispatch-card">
                    <div className="dispatch-pills">
                      <motion.button
                        whileTap={{ scale: 0.96 }}
                        className="btn btn-xs btn-primary"
                        disabled={runningExec}
                        onClick={() => void handleRunExec(selectedProject, "verify")}
                      >
                        <Play size={11} /> Run Verify
                      </motion.button>
                      <motion.button
                        whileTap={{ scale: 0.96 }}
                        className="btn btn-xs"
                        disabled={runningExec}
                        onClick={() => void handleRunExec(selectedProject, "agent", "/bastion recap")}
                      >
                        /bastion recap
                      </motion.button>
                      <motion.button
                        whileTap={{ scale: 0.96 }}
                        className="btn btn-xs"
                        disabled={runningExec}
                        onClick={() => void handleRunExec(selectedProject, "agent", "/bastion audit")}
                      >
                        /bastion audit
                      </motion.button>
                      {runningExec && (
                        <button className="btn btn-xs btn-danger" onClick={handleStopExec}>
                          <Square size={10} /> Stop
                        </button>
                      )}
                    </div>

                    <div className="glass-segmented">
                      <button
                        className={`seg-option ${execMode === "agent" ? "active" : ""}`}
                        onClick={() => setExecMode("agent")}
                      >
                        {execMode === "agent" && (
                          <motion.span layoutId="exec-mode-pill" className="seg-pill-bg" transition={SPRING_SNAPPY} />
                        )}
                        <span className="seg-label">Ask {activeAgentObj.label}</span>
                      </button>
                      <button
                        className={`seg-option ${execMode === "shell" ? "active" : ""}`}
                        onClick={() => setExecMode("shell")}
                      >
                        {execMode === "shell" && (
                          <motion.span layoutId="exec-mode-pill" className="seg-pill-bg" transition={SPRING_SNAPPY} />
                        )}
                        <span className="seg-label">Shell Command</span>
                      </button>
                    </div>

                    <div className="input-inline">
                      <input
                        className="text-input"
                        placeholder={
                          execMode === "agent"
                            ? `Prompt ${activeAgentObj.label} in ${selectedProject.name}...`
                            : "Run a shell command (e.g., git status, npm test)..."
                        }
                        value={customPrompt}
                        onChange={(e) => setCustomPrompt(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && customPrompt.trim() && !runningExec) {
                            void handleRunExec(selectedProject, execMode, customPrompt.trim());
                            setCustomPrompt("");
                          }
                        }}
                      />
                      <button
                        className="btn btn-xs btn-primary"
                        disabled={runningExec || !customPrompt.trim()}
                        onClick={() => {
                          if (!customPrompt.trim()) return;
                          void handleRunExec(selectedProject, execMode, customPrompt.trim());
                          setCustomPrompt("");
                        }}
                      >
                        <Play size={11} /> Run
                      </button>
                    </div>

                    {consoleOutput && (
                      <>
                        <div className="console-header">
                          <span style={{ fontSize: 10.5, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                            {runningExec ? "Streaming live output..." : "Output"}
                          </span>
                          <button
                            className="btn btn-ghost btn-xs"
                            onClick={() => setConsoleOutput("")}
                          >
                            Clear
                          </button>
                        </div>
                        <div className="console-box">
                          {consoleOutput}
                          <div ref={consoleEndRef} />
                        </div>
                      </>
                    )}
                  </div>
                </div>

                <div>
                  <div className="insp-section-title">
                    <span>What&apos;s Next (Milestones)</span>
                    <span style={{ fontFamily: "var(--font-mono)" }}>
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
                        <span style={{ flex: 1 }}>{item.text}</span>
                        <button
                          className="btn btn-ghost btn-xs"
                          onClick={() => {
                            const nextPlan = selectedProject.status.plan.filter((_, i) => i !== idx);
                            void saveStatusUpdate(selectedProject, { plan: nextPlan });
                          }}
                        >
                          <X size={12} />
                        </button>
                      </motion.div>
                    ))}
                    <div className="input-inline" style={{ marginTop: 4 }}>
                      <input
                        className="text-input"
                        placeholder="Add next milestone..."
                        value={newPlanText}
                        onChange={(e) => setNewPlanText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && newPlanText.trim()) {
                            void saveStatusUpdate(selectedProject, {
                              plan: [...selectedProject.status.plan, { text: newPlanText.trim(), done: false }],
                            });
                            setNewPlanText("");
                          }
                        }}
                      />
                      <button
                        className="btn btn-xs"
                        onClick={() => {
                          if (!newPlanText.trim()) return;
                          void saveStatusUpdate(selectedProject, {
                            plan: [...selectedProject.status.plan, { text: newPlanText.trim(), done: false }],
                          });
                          setNewPlanText("");
                        }}
                      >
                        <Plus size={12} />
                      </button>
                    </div>
                  </div>
                </div>

                <div>
                  <div className="insp-section-title">
                    <span>What Happened Recently</span>
                    <button
                      className="btn btn-ghost btn-xs"
                      onClick={() => void handleAutoRecapOne(selectedProject)}
                    >
                      <RefreshCw size={11} /> Sync from Git
                    </button>
                  </div>
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
                        placeholder="Add a recap note..."
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

                <div>
                  <div className="insp-section-title">Needs Your Decision / Blockers</div>
                  <div className="checklist">
                    {selectedProject.status.blockers.map((b, idx) => (
                      <div
                        key={idx}
                        className="row-blocker"
                        style={{ width: "100%", justifyContent: "space-between" }}
                      >
                        <span style={{ flex: 1 }}>{b}</span>
                        <button
                          className="btn btn-xs"
                          onClick={() =>
                            void saveStatusUpdate(selectedProject, {
                              blockers: selectedProject.status.blockers.filter((_, i) => i !== idx),
                            })
                          }
                        >
                          Resolve
                        </button>
                      </div>
                    ))}
                    <div className="input-inline" style={{ marginTop: 4 }}>
                      <input
                        className="text-input"
                        placeholder="Record a blocker or open decision..."
                        value={newBlockerText}
                        onChange={(e) => setNewBlockerText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && newBlockerText.trim()) {
                            void saveStatusUpdate(selectedProject, {
                              blockers: [...selectedProject.status.blockers, newBlockerText.trim()],
                            });
                            setNewBlockerText("");
                          }
                        }}
                      />
                      <button
                        className="btn btn-xs"
                        onClick={() => {
                          if (!newBlockerText.trim()) return;
                          void saveStatusUpdate(selectedProject, {
                            blockers: [...selectedProject.status.blockers, newBlockerText.trim()],
                          });
                          setNewBlockerText("");
                        }}
                      >
                        <Plus size={12} />
                      </button>
                    </div>
                  </div>
                </div>

                {selectedProject.git.recentCommits.length > 0 && (
                  <div>
                    <div className="insp-section-title">Recent Git Commits</div>
                    <div className="commit-list">
                      {selectedProject.git.recentCommits.map((c) => (
                        <div key={c.hash} className="commit-row">
                          <span className="commit-hash">{c.hash}</span>
                          <span className="commit-date">{c.date}</span>
                          <span className="commit-msg" title={c.subject}>
                            {c.subject}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div style={{ paddingTop: 12, borderTop: "1px solid var(--border)" }}>
                  <button
                    className="btn btn-xs btn-danger"
                    onClick={() => void handleRemove(selectedProject.id)}
                  >
                    <Trash2 size={12} /> Untrack Repository
                  </button>
                </div>
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

              <div className="glass-segmented">
                <button
                  className={`seg-option ${addMode === "scan" ? "active" : ""}`}
                  onClick={() => setAddMode("scan")}
                >
                  {addMode === "scan" && (
                    <motion.span layoutId="add-mode-pill" className="seg-pill-bg" transition={SPRING_SNAPPY} />
                  )}
                  <span className="seg-label">Scan Parent Folder</span>
                </button>
                <button
                  className={`seg-option ${addMode === "single" ? "active" : ""}`}
                  onClick={() => setAddMode("single")}
                >
                  {addMode === "single" && (
                    <motion.span layoutId="add-mode-pill" className="seg-pill-bg" transition={SPRING_SNAPPY} />
                  )}
                  <span className="seg-label">Single Repo Path</span>
                </button>
              </div>

              <div className="input-inline">
                <input
                  className="text-input"
                  autoFocus
                  placeholder={
                    addMode === "scan"
                      ? "C:\\Users\\you\\Projects (imports all git repos inside)"
                      : "C:\\Users\\you\\Projects\\my-repo"
                  }
                  value={pathInput}
                  onChange={(e) => setPathInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleAddSubmit();
                  }}
                />
                <button className="btn" onClick={() => void handleBrowseFolder()}>
                  <FolderOpen size={14} /> Browse...
                </button>
              </div>

              <input
                className="text-input"
                placeholder="Group name (optional — auto-fills from folder name)"
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
                    {addMode === "scan" ? "Preview Repos" : "Add Repository"}
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
                              <span
                                className={
                                  p.status.verify === "Pass"
                                    ? "pill-badge pill-pass"
                                    : "pill-badge pill-idle"
                                }
                              >
                                Verify: {p.status.verify}
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
