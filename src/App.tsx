import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ClipboardList,
  Copy,
  FolderPlus,
  GitBranch,
  Layers,
  Plus,
  RefreshCw,
  Search,
  Shield,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import {
  addProject,
  autoRecapAll,
  autoRecapOne,
  buildAgentCommand,
  fetchProjects,
  fetchStandup,
  removeProject,
  scanFolder,
  updateProjectStatus,
} from "./core/api.ts";
import type {
  AgentKind,
  ManagedProject,
  ProjectState,
  StandupSummary,
  VerifyHealth,
} from "./core/types.ts";

type FilterState = "All" | ProjectState;

const AGENTS: Array<{ id: AgentKind; label: string }> = [
  { id: "claude", label: "Claude" },
  { id: "antigravity", label: "Agy" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
];

function rowStateClass(state: ProjectState): string {
  switch (state) {
    case "Active":
      return "state-active";
    case "Waiting on Review":
      return "state-review";
    case "Blocked":
      return "state-blocked";
    case "Idle":
      return "state-idle";
  }
}

function pillStateClass(state: ProjectState): string {
  switch (state) {
    case "Active":
      return "pill-badge pill-active";
    case "Waiting on Review":
      return "pill-badge pill-review";
    case "Blocked":
      return "pill-badge pill-blocked";
    case "Idle":
      return "pill-badge pill-idle";
  }
}

export function App() {
  const [projects, setProjects] = useState<ManagedProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterState>("All");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [agent, setAgent] = useState<AgentKind>(() => {
    const saved = localStorage.getItem("agent-manager:preferred-agent") as AgentKind | null;
    return saved ?? "claude";
  });

  const [showAddModal, setShowAddModal] = useState(false);
  const [addMode, setAddMode] = useState<"single" | "scan">("scan");
  const [pathInput, setPathInput] = useState("");
  const [standup, setStandup] = useState<StandupSummary | null>(null);
  const [copiedStandup, setCopiedStandup] = useState(false);

  const [newPlanText, setNewPlanText] = useState("");
  const [newRecapText, setNewRecapText] = useState("");
  const [newBlockerText, setNewBlockerText] = useState("");
  const [customPrompt, setCustomPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ label: string; detail?: string } | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);

  const showToast = useCallback((label: string, detail?: string) => {
    setToast({ label, detail });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(id);
  }, [toast]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchProjects();
      setProjects(list);
      setSelectedId((prev) => prev ?? list[0]?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load projects");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Keyboard shortcuts: / to search, Escape to close modal/inspector
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

  const stats = useMemo(() => {
    return {
      total: projects.length,
      blocked: projects.filter((p) => p.status.state === "Blocked" || p.status.blockers.length > 0).length,
      review: projects.filter((p) => p.status.state === "Waiting on Review").length,
      active: projects.filter((p) => p.status.state === "Active").length,
      idle: projects.filter((p) => p.status.state === "Idle").length,
      guarded: projects.filter((p) => p.antiSlop.hasSkill).length,
    };
  }, [projects]);

  const filteredProjects = useMemo(() => {
    return projects.filter((p) => {
      if (filter !== "All" && p.status.state !== filter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q);
      }
      return true;
    });
  }, [projects, filter, search]);

  async function handleAddSubmit() {
    if (!pathInput.trim()) return;
    setError(null);
    try {
      if (addMode === "single") {
        const updated = await addProject(pathInput.trim());
        setProjects(updated);
        showToast("Project added", pathInput.trim());
      } else {
        const res = await scanFolder(pathInput.trim());
        setProjects(res.projects);
        showToast(`Imported ${res.added} repository(s)`, pathInput.trim());
      }
      setPathInput("");
      setShowAddModal(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add project");
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
      showToast(`Auto-synced Git recaps across ${updated.length} project(s)`);
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
      showToast(`Synced ${project.name}`, ".agents/status.md updated from Git");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to sync recap");
    } finally {
      setSaving(false);
    }
  }

  async function handleCopyCmd(project: ManagedProject, prompt?: string) {
    try {
      const cmd = await buildAgentCommand(project.id, agent, prompt);
      await navigator.clipboard.writeText(cmd);
      showToast(`Copied ${agent} command`, cmd);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to copy command");
    }
  }

  async function handleRemove(id: string) {
    try {
      const updated = await removeProject(id);
      setProjects(updated);
      if (selectedId === id) setSelectedId(updated[0]?.id ?? null);
      showToast("Removed from dashboard", "Local files untouched");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove project");
    }
  }

  const bastionPct = stats.total > 0 ? Math.round((stats.guarded / stats.total) * 100) : 0;

  return (
    <div className={`workspace ${selectedProject ? "has-inspector" : ""}`}>
      {/* Left Navigation Rail */}
      <aside className="rail">
        <div className="rail-brand">
          <div className="brand-mark">
            <span className="brand-dot">
              <Layers size={13} strokeWidth={2.4} />
            </span>
            <span>Agent Manager</span>
          </div>
        </div>

        <div>
          <div className="rail-section-label">Views</div>
          <nav className="rail-nav">
            {(
              [
                { id: "All", label: "All Projects", count: stats.total, dot: "dot-all" },
                { id: "Blocked", label: "Blocked", count: stats.blocked, dot: "dot-blocked" },
                { id: "Waiting on Review", label: "In Review", count: stats.review, dot: "dot-review" },
                { id: "Active", label: "Active", count: stats.active, dot: "dot-active" },
                { id: "Idle", label: "Idle", count: stats.idle, dot: "dot-idle" },
              ] as Array<{ id: FilterState; label: string; count: number; dot: string }>
            ).map((item) => (
              <button
                key={item.id}
                className={`nav-item ${filter === item.id ? "active" : ""}`}
                onClick={() => setFilter(item.id)}
              >
                <span className="nav-left">
                  <span className={`status-dot ${item.dot}`} />
                  {item.label}
                </span>
                <span className="nav-count">{item.count}</span>
              </button>
            ))}
          </nav>
        </div>

        <div>
          <div className="rail-section-label">Default Agent CLI</div>
          <div className="agent-switcher" role="group" aria-label="Preferred Agent">
            {AGENTS.map((a) => (
              <button
                key={a.id}
                className={`agent-chip ${agent === a.id ? "active" : ""}`}
                onClick={() => {
                  setAgent(a.id);
                  localStorage.setItem("agent-manager:preferred-agent", a.id);
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>

        <div className="rail-footer">
          <div className="bastion-meter">
            <div className="meter-row">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <Shield size={12} color="#34d399" /> Bastion Coverage
              </span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
                {stats.guarded}/{stats.total}
              </span>
            </div>
            <div className="meter-bar">
              <div className="meter-fill" style={{ width: `${bastionPct}%` }} />
            </div>
          </div>

          <button className="btn" onClick={() => void handleOpenStandup()}>
            <ClipboardList size={14} /> Morning Standup
          </button>
          <button className="btn" onClick={() => void handleAutoRecapAll()} disabled={loading}>
            <RefreshCw size={14} /> Auto-Sync Recaps
          </button>
          <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
            <FolderPlus size={14} /> Track Repository
          </button>
        </div>
      </aside>

      {/* Center Master List */}
      <section className="main-pane">
        <header className="main-header">
          <div className="header-title-group">
            <h1>{filter === "All" ? "All Projects" : filter}</h1>
            <span className="header-subtitle">
              {filteredProjects.length} {filteredProjects.length === 1 ? "repo" : "repos"}
            </span>
          </div>

          <div className="header-controls">
            <div className="search-box">
              <Search size={13} />
              <input
                ref={searchInputRef}
                placeholder="Filter repositories..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {!search && <span className="kbd-hint">/</span>}
            </div>
            <button
              className="btn btn-ghost"
              title="Refresh workspace"
              onClick={() => void loadAll()}
              disabled={loading}
            >
              <RefreshCw size={14} />
            </button>
          </div>
        </header>

        <div className="main-scroll">
          {error && <div className="banner-error">{error}</div>}

          {loading && projects.length === 0 ? (
            <div className="empty-state">Scanning local repositories...</div>
          ) : filteredProjects.length === 0 ? (
            <div className="empty-state">
              <p style={{ margin: "0 0 14px" }}>
                No repositories match this view. Scan a parent workspace folder to import all your repos at once.
              </p>
              <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
                <FolderPlus size={14} /> Track Repository
              </button>
            </div>
          ) : (
            <div className="project-list">
              {filteredProjects.map((project) => {
                const doneCount = project.status.plan.filter((p) => p.done).length;
                const totalPlan = project.status.plan.length;
                const nextPlan = project.status.plan.find((p) => !p.done);
                const latestRecap =
                  project.status.recap[0] ??
                  project.git.recentCommits[0]?.subject ??
                  "No recap yet — click Auto-Recap";

                return (
                  <article
                    key={project.id}
                    className={`project-row ${rowStateClass(project.status.state)} ${
                      selectedId === project.id ? "selected" : ""
                    }`}
                    onClick={() => setSelectedId(project.id)}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div className="row-top">
                        <span className="row-name">{project.name}</span>
                        <span className={pillStateClass(project.status.state)}>
                          {project.status.state}
                        </span>
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
                          <span className="row-line-label">Recap</span>
                          <span className="row-line-text">{latestRecap}</span>
                        </div>
                        <div className="row-line">
                          <span className="row-line-label">Next</span>
                          <span className="row-line-text">
                            {nextPlan ? nextPlan.text : "No open milestones"}
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

                    <div className="row-right" onClick={(e) => e.stopPropagation()}>
                      <div className="row-actions">
                        <button
                          className="btn btn-xs"
                          onClick={() => void handleAutoRecapOne(project)}
                          title="Sync latest Git activity into .agents/status.md"
                        >
                          <RefreshCw size={11} /> Auto-Recap
                        </button>
                        <button
                          className="btn btn-xs btn-primary"
                          onClick={() => void handleCopyCmd(project)}
                        >
                          <Terminal size={11} /> Copy Cmd
                        </button>
                      </div>

                      {totalPlan > 0 && (
                        <div className="plan-progress" title="Plan milestones completed">
                          <span>
                            {doneCount}/{totalPlan}
                          </span>
                          <div className="plan-bar">
                            <div
                              className="plan-bar-fill"
                              style={{ width: `${Math.round((doneCount / totalPlan) * 100)}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Right Docked Inspector */}
      {selectedProject && (
        <aside className="inspector">
          <div className="inspector-header">
            <div style={{ minWidth: 0 }}>
              <h2>{selectedProject.name}</h2>
              <div className="inspector-path">{selectedProject.path}</div>
            </div>
            <button
              className="btn btn-ghost btn-xs"
              onClick={() => setSelectedId(null)}
              title="Close inspector (Esc)"
            >
              <X size={15} />
            </button>
          </div>

          <div className="inspector-body">
            <div>
              <div className="insp-section-title">State</div>
              <div className="segmented">
                {(["Active", "Waiting on Review", "Blocked", "Idle"] as ProjectState[]).map(
                  (st) => (
                    <button
                      key={st}
                      disabled={saving}
                      className={`seg-btn ${selectedProject.status.state === st ? "active" : ""}`}
                      onClick={() => void saveStatusUpdate(selectedProject, { state: st })}
                    >
                      {st === "Waiting on Review" ? "Review" : st}
                    </button>
                  ),
                )}
              </div>
            </div>

            <div>
              <div className="insp-section-title">Verify Health</div>
              <div className="segmented cols-3">
                {(["Pass", "Fail", "Unknown"] as VerifyHealth[]).map((v) => (
                  <button
                    key={v}
                    disabled={saving}
                    className={`seg-btn ${selectedProject.status.verify === v ? "active" : ""}`}
                    onClick={() => void saveStatusUpdate(selectedProject, { verify: v })}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="insp-section-title">
                <span>Agent Dispatch ({agent})</span>
              </div>
              <div className="dispatch-card">
                <div className="dispatch-pills">
                  <button
                    className="btn btn-xs btn-primary"
                    onClick={() => void handleCopyCmd(selectedProject)}
                  >
                    <Copy size={11} /> Open {agent}
                  </button>
                  <button
                    className="btn btn-xs"
                    onClick={() => void handleCopyCmd(selectedProject, "/bastion recap")}
                  >
                    /bastion recap
                  </button>
                  <button
                    className="btn btn-xs"
                    onClick={() => void handleCopyCmd(selectedProject, "/bastion harden")}
                  >
                    /bastion harden
                  </button>
                  <button
                    className="btn btn-xs"
                    onClick={() => void handleCopyCmd(selectedProject, "/bastion audit")}
                  >
                    /bastion audit
                  </button>
                </div>
                <div className="input-inline">
                  <input
                    className="text-input"
                    placeholder={`Custom ${agent} instruction...`}
                    value={customPrompt}
                    onChange={(e) => setCustomPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && customPrompt.trim()) {
                        void handleCopyCmd(selectedProject, customPrompt.trim());
                        setCustomPrompt("");
                      }
                    }}
                  />
                  <button
                    className="btn btn-xs"
                    onClick={() => {
                      if (!customPrompt.trim()) return;
                      void handleCopyCmd(selectedProject, customPrompt.trim());
                      setCustomPrompt("");
                    }}
                  >
                    Copy
                  </button>
                </div>
              </div>
            </div>

            <div>
              <div className="insp-section-title">
                <span>Current Plan</span>
                <span style={{ fontFamily: "var(--font-mono)" }}>
                  {selectedProject.status.plan.filter((p) => p.done).length}/
                  {selectedProject.status.plan.length}
                </span>
              </div>
              <div className="checklist">
                {selectedProject.status.plan.map((item, idx) => (
                  <div key={idx} className={`check-row ${item.done ? "done" : ""}`}>
                    <input
                      type="checkbox"
                      checked={item.done}
                      onChange={() => {
                        const nextPlan = selectedProject.status.plan.map((p, i) =>
                          i === idx ? { ...p, done: !p.done } : p,
                        );
                        void saveStatusUpdate(selectedProject, { plan: nextPlan });
                      }}
                    />
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
                  </div>
                ))}
                <div className="input-inline" style={{ marginTop: 4 }}>
                  <input
                    className="text-input"
                    placeholder="Add milestone..."
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
                <span>Last Recap</span>
                <button
                  className="btn btn-ghost btn-xs"
                  onClick={() => void handleAutoRecapOne(selectedProject)}
                >
                  <RefreshCw size={11} /> Sync Git
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
                    placeholder="Add recap note..."
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
              <div className="insp-section-title">Blockers / Decisions</div>
              <div className="checklist">
                {selectedProject.status.blockers.map((b, idx) => (
                  <div key={idx} className="row-blocker" style={{ width: "100%", justifyContent: "space-between" }}>
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
                    placeholder="Add blocker or decision..."
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
                <div className="insp-section-title">Recent Commits</div>
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
          </div>
        </aside>
      )}

      {/* Track Repository Modal */}
      {showAddModal && (
        <div className="modal-backdrop" onClick={() => setShowAddModal(false)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="inspector-header" style={{ padding: 0, borderBottom: "none" }}>
              <h2>Track Repositories</h2>
              <button className="btn btn-ghost btn-xs" onClick={() => setShowAddModal(false)}>
                <X size={15} />
              </button>
            </div>

            <div className="segmented cols-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <button
                className={`seg-btn ${addMode === "scan" ? "active" : ""}`}
                onClick={() => setAddMode("scan")}
              >
                Scan Parent Folder
              </button>
              <button
                className={`seg-btn ${addMode === "single" ? "active" : ""}`}
                onClick={() => setAddMode("single")}
              >
                Single Repository Path
              </button>
            </div>

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

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button className="btn" onClick={() => setShowAddModal(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={() => void handleAddSubmit()}>
                {addMode === "scan" ? "Scan & Import" : "Add Repository"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Morning Standup Modal */}
      {standup && (
        <div className="modal-backdrop" onClick={() => setStandup(null)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="inspector-header" style={{ padding: 0, borderBottom: "none" }}>
              <h2>Morning Standup Digest</h2>
              <button className="btn btn-ghost btn-xs" onClick={() => setStandup(null)}>
                <X size={15} />
              </button>
            </div>
            <pre className="standup-code">{standup.markdown}</pre>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
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
                    <Copy size={13} /> Copy Markdown
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating Toast */}
      {toast && (
        <div className="toast">
          <Check size={14} color="#34d399" />
          <span>{toast.label}</span>
          {toast.detail && <span className="toast-mono">{toast.detail}</span>}
        </div>
      )}
    </div>
  );
}
