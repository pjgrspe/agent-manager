import type { ManagedProject, PlanItem, ProjectState, ProjectStatusData, VerifyHealth } from "./types.ts";

const VALID_STATES: ReadonlySet<ProjectState> = new Set([
  "Active",
  "Waiting on Review",
  "Blocked",
  "Idle",
]);

const VALID_VERIFY: ReadonlySet<VerifyHealth> = new Set(["Pass", "Fail", "Unknown"]);

function normalizeState(raw: string | undefined): ProjectState {
  const cleaned = raw?.replace(/`/g, "").trim() as ProjectState | undefined;
  return cleaned && VALID_STATES.has(cleaned) ? cleaned : "Idle";
}

function normalizeVerify(raw: string | undefined): VerifyHealth {
  const cleaned = raw?.replace(/`/g, "").trim() as VerifyHealth | undefined;
  return cleaned && VALID_VERIFY.has(cleaned) ? cleaned : "Unknown";
}

function isPlaceholder(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length === 0 ||
    trimmed === "(none)" ||
    trimmed === "_(none)_" ||
    trimmed.startsWith("_(") ||
    trimmed.startsWith("(")
  );
}

export function parseStatusMarkdown(markdown: string): ProjectStatusData {
  const stateMatch = markdown.match(/\*\*State:\*\*\s*`?([^`\n<]+)`?/i);
  const updatedMatch = markdown.match(/\*\*Updated:\*\*\s*_?([^_\n]+)_?/i);
  const verifyMatch = markdown.match(/\*\*Verify:\*\*\s*`?([^`\n<]+)`?/i);

  const recap: string[] = [];
  const plan: PlanItem[] = [];
  const blockers: string[] = [];

  let section: "none" | "recap" | "plan" | "blockers" = "none";

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^##\s+Last Recap/i.test(line)) {
      section = "recap";
      continue;
    }
    if (/^##\s+Current Plan/i.test(line)) {
      section = "plan";
      continue;
    }
    if (/^##\s+Blockers/i.test(line)) {
      section = "blockers";
      continue;
    }
    if (line.startsWith("## ")) {
      section = "none";
      continue;
    }

    if (section === "recap" && line.startsWith("- ")) {
      const text = line.slice(2).trim();
      if (!isPlaceholder(text)) recap.push(text);
    } else if (section === "plan") {
      const checkboxMatch = line.match(/^-\s*\[([ xX])\]\s*(.+)$/);
      if (checkboxMatch && checkboxMatch[2]) {
        const text = checkboxMatch[2].trim();
        if (!isPlaceholder(text)) {
          plan.push({ done: checkboxMatch[1]?.toLowerCase() === "x", text });
        }
      } else if (line.startsWith("- ")) {
        const text = line.slice(2).trim();
        if (!isPlaceholder(text)) plan.push({ done: false, text });
      }
    } else if (section === "blockers" && line.startsWith("- ")) {
      const text = line.slice(2).trim();
      if (!isPlaceholder(text)) blockers.push(text);
    }
  }

  return {
    state: normalizeState(stateMatch?.[1]),
    updated: updatedMatch?.[1]?.trim() ?? "",
    verify: normalizeVerify(verifyMatch?.[1]),
    recap,
    plan,
    blockers,
    hasStatusFile: true,
  };
}

export function serializeStatusMarkdown(data: Omit<ProjectStatusData, "hasStatusFile">): string {
  const today = data.updated || new Date().toISOString().slice(0, 10);
  const recapLines =
    data.recap.length > 0 ? data.recap.map((r) => `- ${r}`) : ["- _(no recap yet)_"];
  const planLines =
    data.plan.length > 0
      ? data.plan.map((p) => `- [${p.done ? "x" : " "}] ${p.text}`)
      : ["- [ ] _(add next milestone)_"];
  const blockerLines =
    data.blockers.length > 0 ? data.blockers.map((b) => `- ${b}`) : ["- _(none)_"];

  return [
    "# Project Status (Manager View — Max 60 Lines)",
    "",
    `- **State:** \`${data.state}\` <!-- Active | Waiting on Review | Blocked | Idle -->`,
    `- **Updated:** ${today}`,
    `- **Verify:** \`${data.verify}\` <!-- Pass | Fail | Unknown -->`,
    "",
    "## Last Recap",
    ...recapLines,
    "",
    "## Current Plan (Next 3)",
    ...planLines,
    "",
    "## Blockers / Decisions Needed",
    ...blockerLines,
    "",
  ].join("\n");
}

export function extractVerifyCommand(learningsMarkdown: string): string | null {
  const match = learningsMarkdown.match(/\*\*Verify Cmd:\*\*\s*`?([^`\n_]+)`?/i);
  const value = match?.[1]?.trim();
  if (!value || value.startsWith("(") || value.toLowerCase().includes("exact")) {
    return null;
  }
  return value;
}

export function buildAutoRecapStatus(
  existing: ProjectStatusData,
  git: { isGitRepo: boolean; branch: string; dirtyCount: number; recentCommits: Array<{ hash: string; date: string; subject: string }> },
  todayIso: string = new Date().toISOString().slice(0, 10),
): Omit<ProjectStatusData, "hasStatusFile"> {
  const recap: string[] = [];

  if (git.isGitRepo) {
    for (const c of git.recentCommits.slice(0, 3)) {
      recap.push(`[${c.date}] ${c.subject} (${c.hash})`);
    }
    if (git.dirtyCount > 0) {
      recap.unshift(`WIP on ${git.branch}: ${git.dirtyCount} uncommitted file(s)`);
    }
  }

  let nextState: ProjectState = existing.state;
  if (existing.blockers.length > 0) {
    nextState = "Blocked";
  } else if (existing.state !== "Waiting on Review") {
    const hasRecentCommit = git.recentCommits[0]?.date === todayIso;
    nextState = git.dirtyCount > 0 || hasRecentCommit ? "Active" : "Idle";
  }

  return {
    state: nextState,
    updated: todayIso,
    verify: existing.verify,
    recap: recap.length > 0 ? recap : existing.recap,
    plan: existing.plan,
    blockers: existing.blockers,
  };
}

export function isProjectBlocked(project: Pick<ManagedProject, "status">): boolean {
  return project.status.state === "Blocked" || project.status.blockers.length > 0;
}

export function matchesStateFilter(
  project: Pick<ManagedProject, "status">,
  filter: "ControlCenter" | "All" | ProjectState,
): boolean {
  if (filter === "All" || filter === "ControlCenter") return true;
  if (filter === "Blocked") return isProjectBlocked(project);
  return project.status.state === filter;
}
