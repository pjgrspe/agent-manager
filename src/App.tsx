import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  FolderPlus,
  GitBranch,
  Layers,
  Plus,
  RefreshCw,
  ShieldCheck,
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

function stateBadgeClass(state: ProjectState): string {
  switch (state) {
    case "Active":
      return "badge badge-active";
    case "Waiting on Review":
      return "badge badge-review";
    case "Blocked":
      return "badge badge-blocked";
    case "Idle":
      return "badge badge-idle";
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

  // Modals
  const [showAddModal, setShowAddModal] = useState(false);
  const [addMode, setAddMode] = useState<"single" | "scan">("single");
  const [pathInput, setPathInput] = useState("");
  const [standup, setStandup] = useState<StandupSummary | null>(null);
  const [copied, setCopied] = useState(false);

  // Drawer draft controls
  const [newPlanText, setNewPlanText] = useState("");
  const [newRecapText, setNewRecapText] = useState("");
  const [newBlockerText, setNewBlockerText] = useState("");
  const [customPrompt, setCustomPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchProjects();
      setProjects(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load projects");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedId) ?? null,
    [projects, selectedId],
  );

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

  const stats = useMemo(() => {
    return {
      total: projects.length,
      blocked: projects.filter((p) => p.status.state === "Blocked" || p.status.blockers.length > 0).length,
      review: projects.filter((p) => p.status.state === "Waiting on Review").length,
      active: projects.filter((p) => p.status.state === "Active").length,
      guarded: projects.filter((p) => p.antiSlop.hasSkill).length,
    };
  }, [projects]);

  async function handleAddSubmit() {
    if (!pathInput.trim()) return;
    setError(null);
    try {
      if (addMode === "single") {
        const updated = await addProject(pathInput.trim());
        setProjects(updated);
      } else {
        const res = await scanFolder(pathInput.trim());
        setProjects(res.projects);
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
      setCopied(false);
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
      setNotice(`Auto-synced recaps from Git across ${updated.length} project(s).`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to auto-sync recaps");
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
      setNotice(`Synced recap for ${project.name} into .agents/status.md`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to sync recap");
    } finally {
      setSaving(false);
    }
  }

  async function handleLaunch(project: ManagedProject, prompt?: string) {
    try {
      const cmd = await buildAgentCommand(project.id, agent, prompt);
      await navigator.clipboard.writeText(cmd);
      setNotice(`Copied ${agent} command for ${project.name} — paste into your terminal: ${cmd}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to prepare agent command");
    }
  }

  async function handleRemove(id: string) {
    try {
      const updated = await removeProject(id);
      setProjects(updated);
      if (selectedId === id) setSelectedId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove project");
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <h1>
            <Layers size={20} color="#818cf8" />
            Agent Manager
          </h1>
          <p>Multi-project overview, auto-recaps, plans &amp; multi-agent CLI dispatch</p>
        </div>
        <div className="topbar-actions">
          <select
            className="btn"
            aria-label="Preferred Agent"
            value={agent}
            onChange={(e) => {
              const next = e.target.value as AgentKind;
              setAgent(next);
              localStorage.setItem("agent-manager:preferred-agent", next);
            }}
          >
            <option value="claude">Agent: Claude Code</option>
            <option value="antigravity">Agent: Antigravity</option>
            <option value="codex">Agent: Codex</option>
            <option value="cursor">Agent: Cursor</option>
          </select>
          <button className="btn" onClick={() => void handleAutoRecapAll()} disabled={loading}>
            <RefreshCw size={15} />
            Auto-Sync All Recaps
          </button>
          <button className="btn" onClick={() => void handleOpenStandup()}>
            <ClipboardList size={15} />
            Morning Standup
          </button>
          <button className="btn" onClick={() => void loadAll()} disabled={loading}>
            Refresh
          </button>
          <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
            <FolderPlus size={15} />
            Add Project / Scan Folder
          </button>
        </div>
      </header>

      {error && <div className="banner-error">{error}</div>}
      {notice && (
        <div
          className="card-section"
          style={{
            marginBottom: 14,
            border: "1px solid rgba(34, 197, 94, 0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
          }}
        >
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{notice}</span>
          <button className="btn btn-sm" onClick={() => setNotice(null)}>
            <X size={12} />
          </button>
        </div>
      )}

      <section className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">Tracked Repos</div>
          <div className="kpi-value">{stats.total}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Active</div>
          <div className="kpi-value" style={{ color: "var(--blue)" }}>{stats.active}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Waiting on Review</div>
          <div className="kpi-value" style={{ color: "var(--amber)" }}>{stats.review}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Blocked / Decisions</div>
          <div className="kpi-value" style={{ color: "var(--red)" }}>{stats.blocked}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Anti-Slop Guarded</div>
          <div className="kpi-value" style={{ color: "var(--green)" }}>
            {stats.guarded}/{stats.total}
          </div>
        </div>
      </section>

      <div className="toolbar">
        <div className="filter-pills">
          {(["All", "Blocked", "Waiting on Review", "Active", "Idle"] as FilterState[]).map(
            (st) => (
              <button
                key={st}
                className={`pill ${filter === st ? "active" : ""}`}
                onClick={() => setFilter(st)}
              >
                {st}
              </button>
            ),
          )}
        </div>
        <input
          className="search-input"
          placeholder="Filter by repo name or path..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {loading && projects.length === 0 ? (
        <p style={{ color: "var(--muted)" }}>Scanning repositories...</p>
      ) : filteredProjects.length === 0 ? (
        <div className="kpi-card" style={{ textAlign: "center", padding: 36 }}>
          <p style={{ margin: "0 0 12px", color: "var(--muted)" }}>
            No projects match this filter. Add a repo or scan your workspace folder to begin.
          </p>
          <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
            <FolderPlus size={15} /> Add Your First Project
          </button>
        </div>
      ) : (
        <main className="project-grid">
          {filteredProjects.map((project) => {
            const nextPlan = project.status.plan.find((t) => !t.done);
            const latestSummary =
              project.status.recap[0] ??
              project.git.recentCommits[0]?.subject ??
              "No recap yet — run /anti-slop recap";
            const isBlocked =
              project.status.state === "Blocked" || project.status.blockers.length > 0;

            return (
              <article
                key={project.id}
                className={`project-card ${isBlocked ? "blocked" : ""}`}
                onClick={() => setSelectedId(project.id)}
              >
                <div className="card-header">
                  <div>
                    <h2 className="project-name">{project.name}</h2>
                    <div className="project-path">{project.path}</div>
                  </div>
                  <span className={stateBadgeClass(project.status.state)}>
                    {project.status.state}
                  </span>
                </div>

                <div className="card-meta">
                  {project.git.isGitRepo && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <GitBranch size={13} /> {project.git.branch}
                      {project.git.dirtyCount > 0 ? ` (${project.git.dirtyCount} dirty)` : ""}
                    </span>
                  )}
                  <span className={project.status.verify === "Pass" ? "badge badge-pass" : "badge badge-idle"}>
                    Verify: {project.status.verify}
                  </span>
                  {project.antiSlop.hasSkill && (
                    <span className="badge badge-pass">
                      <ShieldCheck size={12} /> Guarded
                    </span>
                  )}
                </div>

                {project.status.blockers.length > 0 && (
                  <div className="blocker-box">
                    <AlertTriangle size={12} style={{ verticalAlign: "middle", marginRight: 5 }} />
                    {project.status.blockers[0]}
                  </div>
                )}

                <div className="card-section">
                  <div className="card-section-title">Latest Recap / Activity</div>
                  <div>{latestSummary}</div>
                </div>

                <div className="card-section">
                  <div className="card-section-title">Next Up</div>
                  <div>{nextPlan ? nextPlan.text : "All planned items done — add next goal"}</div>
                </div>

                <div className="card-footer" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => void handleLaunch(project)}
                  >
                    <Terminal size={13} /> Copy Agent Cmd
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => void handleAutoRecapOne(project)}
                  >
                    Auto-Recap
                  </button>
                </div>
              </article>
            );
          })}
        </main>
      )}

      {/* Project Detail Slide-Over Drawer */}
      {selectedProject && (
        <div className="overlay" onClick={() => setSelectedId(null)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="card-header">
              <div>
                <h2 style={{ margin: 0 }}>{selectedProject.name}</h2>
                <div className="project-path">{selectedProject.path}</div>
              </div>
              <button className="btn btn-sm" onClick={() => setSelectedId(null)}>
                <X size={15} />
              </button>
            </div>

            <div className="field-row">
              <div className="field">
                <label>Status</label>
                <select
                  value={selectedProject.status.state}
                  disabled={saving}
                  onChange={(e) =>
                    void saveStatusUpdate(selectedProject, {
                      state: e.target.value as ProjectState,
                    })
                  }
                >
                  <option value="Active">Active</option>
                  <option value="Waiting on Review">Waiting on Review</option>
                  <option value="Blocked">Blocked</option>
                  <option value="Idle">Idle</option>
                </select>
              </div>
              <div className="field">
                <label>Verify Health</label>
                <select
                  value={selectedProject.status.verify}
                  disabled={saving}
                  onChange={(e) =>
                    void saveStatusUpdate(selectedProject, {
                      verify: e.target.value as VerifyHealth,
                    })
                  }
                >
                  <option value="Pass">Pass</option>
                  <option value="Fail">Fail</option>
                  <option value="Unknown">Unknown</option>
                </select>
              </div>
            </div>

            <div>
              <div className="card-section-title">1-Click Agent Command Copy ({agent})</div>
              <div className="topbar-actions" style={{ marginBottom: 8 }}>
                <button className="btn btn-sm btn-primary" onClick={() => void handleLaunch(selectedProject)}>
                  <Terminal size={13} /> Copy {agent} Cmd
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => void handleLaunch(selectedProject, "/anti-slop recap")}
                >
                  /anti-slop recap
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => void handleLaunch(selectedProject, "/anti-slop harden")}
                >
                  /anti-slop harden
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => void handleLaunch(selectedProject, "/anti-slop audit")}
                >
                  /anti-slop audit
                </button>
              </div>
              <div className="field-row">
                <input
                  style={{
                    flex: 1,
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: "7px 10px",
                    fontSize: 13,
                  }}
                  placeholder={`Build a custom manager task command for ${agent}...`}
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                />
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    if (!customPrompt.trim()) return;
                    void handleLaunch(selectedProject, customPrompt.trim());
                    setCustomPrompt("");
                  }}
                >
                  Copy Cmd
                </button>
              </div>
            </div>

            <div>
              <div className="card-section-title">Current Plan (.agents/status.md)</div>
              <div className="plan-list">
                {selectedProject.status.plan.map((item, idx) => (
                  <div key={idx} className={`plan-item ${item.done ? "done" : ""}`}>
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
                      className="btn btn-sm"
                      onClick={() => {
                        const nextPlan = selectedProject.status.plan.filter((_, i) => i !== idx);
                        void saveStatusUpdate(selectedProject, { plan: nextPlan });
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="field-row" style={{ marginTop: 8 }}>
                <input
                  style={{
                    flex: 1,
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: "7px 10px",
                    fontSize: 13,
                  }}
                  placeholder="Add next milestone..."
                  value={newPlanText}
                  onChange={(e) => setNewPlanText(e.target.value)}
                />
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    if (!newPlanText.trim()) return;
                    void saveStatusUpdate(selectedProject, {
                      plan: [...selectedProject.status.plan, { text: newPlanText.trim(), done: false }],
                    });
                    setNewPlanText("");
                  }}
                >
                  <Plus size={13} /> Add
                </button>
              </div>
            </div>

            <div>
              <div className="card-section-title">Last Recap</div>
              <div className="plan-list">
                {selectedProject.status.recap.map((r, idx) => (
                  <div key={idx} className="plan-item">
                    <CheckCircle2 size={14} color="#22c55e" />
                    <span style={{ flex: 1 }}>{r}</span>
                    <button
                      className="btn btn-sm"
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
              </div>
              <div className="field-row" style={{ marginTop: 8 }}>
                <input
                  style={{
                    flex: 1,
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: "7px 10px",
                    fontSize: 13,
                  }}
                  placeholder="Add recap bullet..."
                  value={newRecapText}
                  onChange={(e) => setNewRecapText(e.target.value)}
                />
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    if (!newRecapText.trim()) return;
                    void saveStatusUpdate(selectedProject, {
                      recap: [newRecapText.trim(), ...selectedProject.status.recap],
                    });
                    setNewRecapText("");
                  }}
                >
                  <Plus size={13} /> Add
                </button>
              </div>
            </div>

            <div>
              <div className="card-section-title">Blockers / Decisions Needed</div>
              <div className="plan-list">
                {selectedProject.status.blockers.map((b, idx) => (
                  <div key={idx} className="blocker-box" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ flex: 1 }}>{b}</span>
                    <button
                      className="btn btn-sm"
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
              </div>
              <div className="field-row" style={{ marginTop: 8 }}>
                <input
                  style={{
                    flex: 1,
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: "7px 10px",
                    fontSize: 13,
                  }}
                  placeholder="Record a blocker or decision..."
                  value={newBlockerText}
                  onChange={(e) => setNewBlockerText(e.target.value)}
                />
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    if (!newBlockerText.trim()) return;
                    void saveStatusUpdate(selectedProject, {
                      blockers: [...selectedProject.status.blockers, newBlockerText.trim()],
                    });
                    setNewBlockerText("");
                  }}
                >
                  <Plus size={13} /> Add
                </button>
              </div>
            </div>

            {selectedProject.git.recentCommits.length > 0 && (
              <div>
                <div className="card-section-title">Recent Git Commits</div>
                {selectedProject.git.recentCommits.map((c) => (
                  <div key={c.hash} className="commit-item">
                    <span className="commit-hash">{c.hash}</span>
                    <span style={{ color: "var(--muted)" }}>{c.date}</span>
                    <span>{c.subject}</span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ marginTop: "auto", paddingTop: 12, borderTop: "1px solid var(--border)" }}>
              <button
                className="btn btn-sm btn-danger"
                onClick={() => void handleRemove(selectedProject.id)}
              >
                <Trash2 size={13} /> Remove from Dashboard (keeps files on disk)
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Add Project / Scan Folder Modal */}
      {showAddModal && (
        <div className="overlay modal-center" onClick={() => setShowAddModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="card-header">
              <h3 style={{ margin: 0 }}>Track Projects</h3>
              <button className="btn btn-sm" onClick={() => setShowAddModal(false)}>
                <X size={15} />
              </button>
            </div>
            <div className="filter-pills">
              <button
                className={`pill ${addMode === "single" ? "active" : ""}`}
                onClick={() => setAddMode("single")}
              >
                Add Single Repo Path
              </button>
              <button
                className={`pill ${addMode === "scan" ? "active" : ""}`}
                onClick={() => setAddMode("scan")}
              >
                Auto-Scan Parent Folder
              </button>
            </div>
            <div className="field">
              <label>
                {addMode === "single"
                  ? "Full path to a local project directory"
                  : "Parent folder containing multiple git repositories"}
              </label>
              <input
                placeholder="C:\Users\you\Projects"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleAddSubmit();
                }}
              />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button className="btn" onClick={() => setShowAddModal(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={() => void handleAddSubmit()}>
                {addMode === "single" ? "Add Project" : "Scan & Import Repos"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Morning Standup Modal */}
      {standup && (
        <div className="overlay modal-center" onClick={() => setStandup(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="card-header">
              <h3 style={{ margin: 0 }}>Morning Standup Digest</h3>
              <button className="btn btn-sm" onClick={() => setStandup(null)}>
                <X size={15} />
              </button>
            </div>
            <pre className="standup-pre">{standup.markdown}</pre>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                className="btn btn-primary"
                onClick={() => {
                  void navigator.clipboard.writeText(standup.markdown);
                  setCopied(true);
                }}
              >
                {copied ? "Copied!" : "Copy Markdown"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
