import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildAutoRecapStatus,
  computeGroundTruth,
  extractVerifyCommand,
  parseStatusMarkdown,
  serializeStatusMarkdown,
  type VerifyCacheRecord,
} from "../src/core/statusParser.ts";
import { readClaudeProjectSync } from "./claudeReader.ts";
import { readGitHubPrs } from "./githubReader.ts";
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
const VERIFY_CACHE_FILE = path.join(DATA_DIR, "verify-cache.json");
const SCAN_CACHE_FILE = path.join(DATA_DIR, "scan-cache.json");

let memScanCache: { projects: ManagedProject[]; updatedAt: number } | null = null;
let bgScanRunning = false;

async function readBranchFast(repoPath: string): Promise<string> {
  try {
    const head = (await fs.readFile(path.join(repoPath, ".git", "HEAD"), "utf8")).trim();
    if (head.startsWith("ref: refs/heads/")) return head.slice("ref: refs/heads/".length);
    return head.slice(0, 7) || "HEAD";
  } catch {
    return "";
  }
}

async function scanProjectLight(entry: StoredProjectEntry): Promise<ManagedProject> {
  const exists = await pathExists(entry.path);
  const [status, antiSlop, branch] = exists
    ? await Promise.all([inspectStatus(entry.path), inspectAntiSlop(entry.path), readBranchFast(entry.path)])
    : [
        {
          state: "Blocked" as const,
          updated: "",
          verify: "Unknown" as const,
          recap: [],
          plan: [],
          blockers: ["Directory not found on disk"],
          hasStatusFile: false,
        },
        {
          hasAgentsMd: false,
          hasClaudeMd: false,
          hasSkill: false,
          hasLearnings: false,
          verifyCmd: null,
          skillCount: 0,
        },
        "",
      ];

  const git: ProjectGitData = {
    isGitRepo: Boolean(branch),
    branch,
    headSha: "",
    headTimestamp: null,
    dirtyCount: 0,
    ahead: 0,
    behind: 0,
    recentCommits: [],
  };

  const truth = computeGroundTruth({ exists, status, git });
  return {
    id: entry.id,
    name: entry.name,
    path: entry.path,
    group: entry.group,
    exists,
    status: { ...status, state: truth.state, verify: truth.verifyHealth },
    git,
    antiSlop,
    truth,
  };
}

export async function getProjectsFast(forceFresh = false): Promise<ManagedProject[]> {
  const entries = await loadProjectEntries();
  if (entries.length === 0) return [];

  if (!forceFresh) {
    if (!memScanCache) {
      try {
        const raw = await fs.readFile(SCAN_CACHE_FILE, "utf8");
        const parsed = JSON.parse(raw) as { projects?: ManagedProject[]; updatedAt?: number };
        if (Array.isArray(parsed.projects)) {
          memScanCache = { projects: parsed.projects, updatedAt: parsed.updatedAt ?? 0 };
        }
      } catch {
        // no disk cache yet
      }
    }

    if (memScanCache) {
      const byId = new Map(memScanCache.projects.map((p) => [p.id, p]));
      const aligned: ManagedProject[] = [];
      for (const e of entries) {
        const cached = byId.get(e.id);
        if (cached) {
          aligned.push({ ...cached, name: e.name, group: e.group });
        } else {
          aligned.push(await scanProjectLight(e));
        }
      }

      if (Date.now() - memScanCache.updatedAt > 20_000 || aligned.length !== memScanCache.projects.length) {
        triggerBackgroundRefresh();
      }
      return aligned;
    }

    // Cold boot with no disk cache yet: return instant filesystem-only scan (<20ms) and warm Git in background
    const light = await Promise.all(entries.map(scanProjectLight));
    memScanCache = { projects: light, updatedAt: 0 };
    triggerBackgroundRefresh();
    return light;
  }

  return scanAllAndPersist(entries);
}

export function triggerBackgroundRefresh(): void {
  if (bgScanRunning) return;
  bgScanRunning = true;
  void (async () => {
    try {
      const entries = await loadProjectEntries();
      await scanAllAndPersist(entries);
    } catch {
      // ignore background refresh error
    } finally {
      bgScanRunning = false;
    }
  })();
}

export function invalidateScanCache(): void {
  if (memScanCache) {
    memScanCache.updatedAt = 0;
  }
}

async function scanAllAndPersist(entries: StoredProjectEntry[]): Promise<ManagedProject[]> {
  // Scan with modest concurrency (3 at a time) so Windows process creation stays smooth
  const results: ManagedProject[] = [];
  for (let i = 0; i < entries.length; i += 3) {
    const batch = entries.slice(i, i + 3);
    const scannedBatch = await Promise.all(batch.map(scanProject));
    results.push(...scannedBatch);
  }
  memScanCache = { projects: results, updatedAt: Date.now() };
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(SCAN_CACHE_FILE, JSON.stringify(memScanCache), "utf8");
  } catch {
    // ignore cache write error
  }
  return results;
}

export async function loadVerifyCache(): Promise<Record<string, VerifyCacheRecord>> {
  try {
    const raw = await fs.readFile(VERIFY_CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, VerifyCacheRecord>)
      : {};
  } catch {
    return {};
  }
}

export async function recordVerifyRun(
  projectId: string,
  headSha: string,
  passed: boolean,
): Promise<void> {
  const current = await loadVerifyCache();
  current[projectId] = {
    headSha,
    passed,
    ranAt: new Date().toISOString(),
  };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(VERIFY_CACHE_FILE, JSON.stringify(current, null, 2), "utf8");
}

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
    const { stdout } = await execFileAsync("git", ["--no-optional-locks", ...args], {
      cwd: repoPath,
      timeout: 15000,
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
    return {
      isGitRepo: false,
      branch: "",
      headSha: "",
      headTimestamp: null,
      dirtyCount: 0,
      ahead: 0,
      behind: 0,
      recentCommits: [],
    };
  }

  // Only 2 git spawns per repo instead of 6 (huge speedup on Windows)
  const [statusOut, logOut] = await Promise.all([
    runGit(repoPath, ["status", "--porcelain=v2", "--branch"]),
    runGit(repoPath, ["log", "-n", "20", "--pretty=format:%h|%cs|%cI|%s"]),
  ]);

  let branch = "HEAD";
  let headSha = "";
  let ahead = 0;
  let behind = 0;
  let dirtyCount = 0;

  if (statusOut) {
    for (const line of statusOut.split(/\r?\n/)) {
      if (!line) continue;
      if (line.startsWith("# branch.head ")) {
        branch = line.slice("# branch.head ".length).trim() || "HEAD";
      } else if (line.startsWith("# branch.oid ")) {
        const oid = line.slice("# branch.oid ".length).trim();
        if (oid && oid !== "(initial)") headSha = oid.slice(0, 7);
      } else if (line.startsWith("# branch.ab ")) {
        const abMatch = line.match(/\+(\d+)\s+-(\d+)/);
        if (abMatch) {
          ahead = Number(abMatch[1] ?? 0) || 0;
          behind = Number(abMatch[2] ?? 0) || 0;
        }
      } else if (!line.startsWith("# ")) {
        dirtyCount++;
      }
    }
  }

  let headTimestamp: string | null = null;
  const recentCommits: GitCommitSummary[] = [];

  if (logOut) {
    for (const line of logOut.split(/\r?\n/)) {
      if (!line) continue;
      const [hash = "", date = "", iso = "", ...rest] = line.split("|");
      if (!headTimestamp && iso) headTimestamp = iso;
      if (!headSha && hash) headSha = hash;
      recentCommits.push({ hash, date, subject: rest.join("|") });
    }
  }

  return {
    isGitRepo: true,
    branch,
    headSha,
    headTimestamp,
    dirtyCount,
    ahead,
    behind,
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
    const missingStatus: ProjectStatusData = {
      state: "Blocked",
      updated: "",
      verify: "Unknown",
      recap: [],
      plan: [],
      blockers: ["Directory not found on disk"],
      hasStatusFile: false,
    };
    const emptyGit: ProjectGitData = {
      isGitRepo: false,
      branch: "",
      headSha: "",
      headTimestamp: null,
      dirtyCount: 0,
      ahead: 0,
      behind: 0,
      recentCommits: [],
    };
    return {
      id: entry.id,
      name: entry.name,
      path: entry.path,
      group: entry.group,
      exists: false,
      status: missingStatus,
      git: emptyGit,
      antiSlop: {
        hasAgentsMd: false,
        hasClaudeMd: false,
        hasSkill: false,
        hasLearnings: false,
        verifyCmd: null,
        skillCount: 0,
      },
      truth: computeGroundTruth({ exists: false, status: missingStatus, git: emptyGit }),
    };
  }

  const [status, git, antiSlop, claudeSync, github, verifyCache] = await Promise.all([
    inspectStatus(entry.path),
    inspectGit(entry.path),
    inspectAntiSlop(entry.path),
    readClaudeProjectSync(entry.path),
    readGitHubPrs(entry.path),
    loadVerifyCache(),
  ]);

  const truth = computeGroundTruth({
    exists: true,
    status,
    git,
    github,
    claudeSync,
    verifyRecord: verifyCache[entry.id] ?? null,
  });

  // Never inject noisy regex memory blockers; only surface active Claude todos if no manual plan exists
  const recentClaudeSession = Boolean(
    claudeSync.lastSessionAt && Date.now() - Date.parse(claudeSync.lastSessionAt) <= 72 * 60 * 60 * 1000,
  );

  const enrichedStatus: ProjectStatusData = {
    ...status,
    state: truth.state,
    verify: truth.verifyHealth,
    plan: status.plan.length > 0 ? status.plan : recentClaudeSession ? claudeSync.sessionTodos : [],
    blockers: status.blockers,
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
    github,
    truth,
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
