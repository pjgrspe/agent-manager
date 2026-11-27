import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildAutoRecapStatus,
  extractVerifyCommand,
  parseStatusMarkdown,
  serializeStatusMarkdown,
} from "../src/core/statusParser.ts";
import { readClaudeProjectSync } from "./claudeReader.ts";
import type {
  AntiSlopInfo,
  GitCommitSummary,
  ManagedProject,
  ProjectGitData,
  ProjectStatusData,
  StandupSummary,
} from "../src/core/types.ts";

const execFileAsync = promisify(execFile);

export interface StoredProjectEntry {
  id: string;
  name: string;
  path: string;
  group?: string;
}

const DATA_DIR = path.resolve(process.cwd(), ".data");
const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function loadProjectEntries(): Promise<StoredProjectEntry[]> {
  try {
    const raw = await fs.readFile(PROJECTS_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is StoredProjectEntry =>
        typeof x === "object" &&
        x !== null &&
        typeof (x as StoredProjectEntry).id === "string" &&
        typeof (x as StoredProjectEntry).name === "string" &&
        typeof (x as StoredProjectEntry).path === "string",
    );
  } catch {
    // Seed with the parent workspace if this is the first run
    const defaultRepo = path.resolve(process.cwd(), "..");
    if (await pathExists(path.join(defaultRepo, ".git"))) {
      const seed: StoredProjectEntry[] = [
        { id: createId(defaultRepo), name: path.basename(defaultRepo), path: defaultRepo },
      ];
      await saveProjectEntries(seed);
      return seed;
    }
    return [];
  }
}

export async function saveProjectEntries(entries: StoredProjectEntry[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(PROJECTS_FILE, JSON.stringify(entries, null, 2), "utf8");
}

export function createId(repoPath: string): string {
  return crypto
    .createHash("sha256")
    .update(path.resolve(repoPath).toLowerCase())
    .digest("base64url")
    .slice(0, 16);
}

async function runGit(repoPath: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoPath,
      timeout: 4000,
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function inspectGit(repoPath: string): Promise<ProjectGitData> {
  const isGitRepo = await pathExists(path.join(repoPath, ".git"));
  if (!isGitRepo) {
    return { isGitRepo: false, branch: "", dirtyCount: 0, recentCommits: [] };
  }

  const [branchOut, statusOut, logOut] = await Promise.all([
    runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(repoPath, ["status", "--porcelain"]),
    runGit(repoPath, ["log", "-n", "20", "--pretty=format:%h|%cs|%s"]),
  ]);

  const dirtyCount = statusOut ? statusOut.split(/\r?\n/).filter(Boolean).length : 0;
  const recentCommits: GitCommitSummary[] = logOut
    ? logOut
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [hash = "", date = "", ...rest] = line.split("|");
          return { hash, date, subject: rest.join("|") };
        })
    : [];

  return {
    isGitRepo: true,
    branch: branchOut || "HEAD",
    dirtyCount,
    recentCommits,
  };
}

async function inspectAntiSlop(repoPath: string): Promise<AntiSlopInfo> {
  const [hasAgentsMd, hasClaudeMd, hasBastion, hasLegacySkill, hasLearnings] = await Promise.all([
    pathExists(path.join(repoPath, "AGENTS.md")),
    pathExists(path.join(repoPath, "CLAUDE.md")),
    pathExists(path.join(repoPath, ".agents", "skills", "bastion", "SKILL.md")),
    pathExists(path.join(repoPath, ".agents", "skills", "anti-slop-engineering", "SKILL.md")),
    pathExists(path.join(repoPath, ".agents", "project-learnings.md")),
  ]);
  const hasSkill = hasBastion || hasLegacySkill;

  let verifyCmd: string | null = null;
  if (hasLearnings) {
    try {
      const content = await fs.readFile(path.join(repoPath, ".agents", "project-learnings.md"), "utf8");
      verifyCmd = extractVerifyCommand(content);
    } catch {
      verifyCmd = null;
    }
  }

  let skillCount = 0;
  for (const dir of [
    path.join(repoPath, ".agents", "skills"),
    path.join(repoPath, ".claude", "skills"),
  ]) {
    try {
      const items = await fs.readdir(dir, { withFileTypes: true });
      skillCount = Math.max(skillCount, items.filter((d) => d.isDirectory()).length);
    } catch {
      // ignore missing directory
    }
  }

  return { hasAgentsMd, hasClaudeMd, hasSkill, hasLearnings, verifyCmd, skillCount };
}

async function inspectStatus(repoPath: string): Promise<ProjectStatusData> {
  const statusFile = path.join(repoPath, ".agents", "status.md");
  try {
    const content = await fs.readFile(statusFile, "utf8");
    return parseStatusMarkdown(content);
  } catch {
    return {
      state: "Idle",
      updated: "",
      verify: "Unknown",
      recap: [],
      plan: [],
      blockers: [],
      hasStatusFile: false,
    };
  }
}

export async function scanProject(entry: StoredProjectEntry): Promise<ManagedProject> {
  const exists = await pathExists(entry.path);
  if (!exists) {
    return {
      id: entry.id,
      name: entry.name,
      path: entry.path,
      group: entry.group,
      exists: false,
      status: {
        state: "Idle",
        updated: "",
        verify: "Unknown",
        recap: [],
        plan: [],
        blockers: ["Directory not found on disk"],
        hasStatusFile: false,
      },
      git: { isGitRepo: false, branch: "", dirtyCount: 0, recentCommits: [] },
      antiSlop: {
        hasAgentsMd: false,
        hasClaudeMd: false,
        hasSkill: false,
        hasLearnings: false,
        verifyCmd: null,
        skillCount: 0,
      },
    };
  }

  const [status, git, antiSlop, claudeSync] = await Promise.all([
    inspectStatus(entry.path),
    inspectGit(entry.path),
    inspectAntiSlop(entry.path),
    readClaudeProjectSync(entry.path),
  ]);

  // If .agents/status.md has no plan or blockers yet, surface live Claude session todos & memory flags
  const enrichedStatus: ProjectStatusData = {
    ...status,
    plan: status.plan.length > 0 ? status.plan : claudeSync.sessionTodos,
    blockers: status.blockers.length > 0 ? status.blockers : claudeSync.memoryFlags,
  };

  return {
    id: entry.id,
    name: entry.name,
    path: entry.path,
    group: entry.group,
    exists: true,
    status: enrichedStatus,
    git,
    antiSlop,
    claudeSync,
  };
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "bin",
  "obj",
  ".cache",
]);

export async function discoverReposInFolder(
  rootFolder: string,
  maxDepth = 3,
): Promise<StoredProjectEntry[]> {
  const resolved = path.resolve(rootFolder);
  const discovered: StoredProjectEntry[] = [];
  const seen = new Set<string>();

  async function walk(dir: string, depth: number): Promise<void> {
    const hasGit = await pathExists(path.join(dir, ".git"));
    if (hasGit) {
      const id = createId(dir);
      if (!seen.has(id)) {
        seen.add(id);
        discovered.push({ id, name: path.basename(dir), path: dir });
      }
      // Never descend into subfolders of a git repo (prevents tracking frontend/, backend/, packages/, etc.)
      return;
    }

    if (depth >= maxDepth) return;

    let children;
    try {
      children = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const child of children) {
      if (!child.isDirectory() || child.name.startsWith(".") || SKIP_DIRS.has(child.name)) {
        continue;
      }
      await walk(path.join(dir, child.name), depth + 1);
    }
  }

  await walk(resolved, 0);
  return discovered;
}

export async function writeProjectStatus(
  repoPath: string,
  data: Omit<ProjectStatusData, "hasStatusFile">,
): Promise<ProjectStatusData> {
  const agentsDir = path.join(repoPath, ".agents");
  await fs.mkdir(agentsDir, { recursive: true });
  const content = serializeStatusMarkdown({
    ...data,
    updated: new Date().toISOString().slice(0, 10),
  });
  await fs.writeFile(path.join(agentsDir, "status.md"), content, "utf8");
  return parseStatusMarkdown(content);
}

export async function autoRecapProject(entry: StoredProjectEntry): Promise<ManagedProject> {
  const scanned = await scanProject(entry);
  if (!scanned.exists || !scanned.git.isGitRepo) {
    return scanned;
  }
  const nextData = buildAutoRecapStatus(scanned.status, scanned.git);
  const savedStatus = await writeProjectStatus(entry.path, nextData);
  return { ...scanned, status: savedStatus };
}

export async function detectVerifyCommand(repoPath: string): Promise<string | null> {
  const pkgPath = path.join(repoPath, "package.json");
  if (await pathExists(pkgPath)) {
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8")) as {
        scripts?: Record<string, string>;
      };
      const scripts = pkg.scripts ?? {};
      if (scripts.verify) return "npm run verify";
      const parts: string[] = [];
      if (scripts.typecheck) parts.push("npm run typecheck");
      if (scripts.lint) parts.push("npm run lint");
      if (scripts.test && !scripts.test.includes("no test specified")) parts.push("npm test");
      if (scripts.build) parts.push("npm run build");
      if (parts.length > 0) return parts.join(" && ");
    } catch {
      // ignore invalid package.json
    }
  }

  if (await pathExists(path.join(repoPath, "pyproject.toml"))) {
    return "pytest -q";
  }
  if (await pathExists(path.join(repoPath, "Cargo.toml"))) {
    return "cargo test";
  }
  if (await pathExists(path.join(repoPath, "go.mod"))) {
    return "go test ./...";
  }
  return null;
}

async function copyIfAllowed(src: string, dest: string, overwrite: boolean): Promise<boolean> {
  if (!overwrite && (await pathExists(dest))) return false;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
  return true;
}

export async function installBastionIntoRepo(
  repoPath: string,
  bastionSourceRoot: string = path.resolve(process.cwd(), ".."),
): Promise<{ installedFiles: number; detectedVerifyCmd: string | null }> {
  const skillFiles = [
    "SKILL.md",
    "references/stack-guardrails.md",
    "references/project-learnings-template.md",
    "references/skill-audit.md",
    "references/claude-harness.md",
    "references/status-template.md",
  ];

  let installedFiles = 0;

  // Safe mode: never overwrite existing AGENTS.md, CLAUDE.md, learnings, or status
  for (const rootFile of ["AGENTS.md", "CLAUDE.md"]) {
    const src = path.join(bastionSourceRoot, rootFile);
    if (await pathExists(src)) {
      if (await copyIfAllowed(src, path.join(repoPath, rootFile), false)) installedFiles++;
    }
  }

  for (const rel of skillFiles) {
    const src = path.join(bastionSourceRoot, ".agents", "skills", "bastion", rel);
    if (!(await pathExists(src))) continue;
    for (const targetBase of [
      path.join(repoPath, ".agents", "skills", "bastion"),
      path.join(repoPath, ".claude", "skills", "bastion"),
    ]) {
      if (await copyIfAllowed(src, path.join(targetBase, rel), true)) installedFiles++;
    }
  }

  const cmdSrc = path.join(bastionSourceRoot, ".claude", "commands", "bastion.md");
  if (await pathExists(cmdSrc)) {
    if (await copyIfAllowed(cmdSrc, path.join(repoPath, ".claude", "commands", "bastion.md"), true)) {
      installedFiles++;
    }
  }

  const detectedVerifyCmd = await detectVerifyCommand(repoPath);

  const learningsDest = path.join(repoPath, ".agents", "project-learnings.md");
  const learningsTpl = path.join(
    bastionSourceRoot,
    ".agents",
    "skills",
    "bastion",
    "references",
    "project-learnings-template.md",
  );
  if (!(await pathExists(learningsDest)) && (await pathExists(learningsTpl))) {
    await fs.mkdir(path.dirname(learningsDest), { recursive: true });
    let tplContent = await fs.readFile(learningsTpl, "utf8");
    if (detectedVerifyCmd) {
      tplContent = tplContent.replace(
        /\*\*Verify Cmd:\*\*\s*_\(exact quiet single command\)_/,
        `**Verify Cmd:** \`${detectedVerifyCmd}\``,
      );
    }
    await fs.writeFile(learningsDest, tplContent, "utf8");
    installedFiles++;
  }

  const statusDest = path.join(repoPath, ".agents", "status.md");
  const statusTpl = path.join(
    bastionSourceRoot,
    ".agents",
    "skills",
    "bastion",
    "references",
    "status-template.md",
  );
  if (!(await pathExists(statusDest)) && (await pathExists(statusTpl))) {
    if (await copyIfAllowed(statusTpl, statusDest, false)) installedFiles++;
  }

  return { installedFiles, detectedVerifyCmd };
}

export function buildStandupSummary(projects: ManagedProject[]): StandupSummary {
  const counts = {
    total: projects.length,
    blocked: projects.filter((p) => p.status.state === "Blocked" || p.status.blockers.length > 0).length,
    waitingOnReview: projects.filter((p) => p.status.state === "Waiting on Review").length,
    active: projects.filter((p) => p.status.state === "Active").length,
    idle: projects.filter((p) => p.status.state === "Idle").length,
  };

  const lines: string[] = [
    `# Daily Manager Standup (${new Date().toISOString().slice(0, 10)})`,
    `Projects: **${counts.total}** | Blocked: **${counts.blocked}** | Waiting on Review: **${counts.waitingOnReview}** | Active: **${counts.active}**`,
    "",
  ];

  const groups: Array<{ title: string; list: ManagedProject[] }> = [
    {
      title: "🚨 Needs Your Decision / Blocked",
      list: projects.filter((p) => p.status.state === "Blocked" || p.status.blockers.length > 0),
    },
    {
      title: "👀 Waiting on Review",
      list: projects.filter((p) => p.status.state === "Waiting on Review"),
    },
    {
      title: "🚀 Active Work",
      list: projects.filter((p) => p.status.state === "Active"),
    },
  ];

  for (const group of groups) {
    if (group.list.length === 0) continue;
    lines.push(`## ${group.title}`);
    for (const p of group.list) {
      const nextTask = p.status.plan.find((t) => !t.done)?.text ?? p.git.recentCommits[0]?.subject ?? "No plan recorded";
      const blockerText = p.status.blockers.length > 0 ? ` | Blocker: ${p.status.blockers[0]}` : "";
      lines.push(`- **${p.name}** (\`${p.git.branch || "no-git"}\`, Verify: ${p.status.verify}) — Next: ${nextTask}${blockerText}`);
    }
    lines.push("");
  }

  return {
    generatedAt: new Date().toISOString(),
    markdown: lines.join("\n"),
    counts,
  };
}
