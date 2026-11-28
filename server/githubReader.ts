import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  GitCommitSummary,
  GitHubIssueInfo,
  GitHubMilestoneInfo,
  GitHubSyncData,
  MergedPrInfo,
  PullRequestInfo,
} from "../src/core/types.ts";

const execFileAsync = promisify(execFile);

interface CacheEntry {
  data: GitHubSyncData;
  expiresAt: number;
}

const CACHE_TTL_MS = 90_000;
const cache = new Map<string, CacheEntry>();
const inFlight = new Set<string>();

export function parseGitHubSlugFromUrl(rawUrl: string): string | null {
  const cleaned = rawUrl.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const urlMatch = cleaned.match(/github\.com[:/]([^/\s]+\/[^/\s]+)$/i);
  if (urlMatch?.[1]) return urlMatch[1];
  const shortMatch = cleaned.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/);
  return shortMatch?.[1] ?? null;
}

export async function detectGitHubRepoSlug(repoPath: string): Promise<string | null> {
  try {
    const config = await fs.readFile(path.join(repoPath, ".git", "config"), "utf8");
    const originBlock = config.match(/\[remote "origin"\][\s\S]*?(?=\n\[|$)/i)?.[0] ?? config;
    const urlLine = originBlock.match(/^\s*url\s*=\s*(.+)$/m)?.[1];
    return urlLine ? parseGitHubSlugFromUrl(urlLine) : null;
  } catch {
    return null;
  }
}

function summarizeChecks(
  rollup: Array<{ conclusion?: string | null; status?: string | null; state?: string | null }> | undefined,
): "Pass" | "Fail" | "Pending" | "None" {
  if (!Array.isArray(rollup) || rollup.length === 0) return "None";
  let hasPending = false;
  for (const check of rollup) {
    const conclusion = (check.conclusion ?? check.state ?? "").toUpperCase();
    const status = (check.status ?? "").toUpperCase();
    if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR"].includes(conclusion)) {
      return "Fail";
    }
    if (["IN_PROGRESS", "QUEUED", "PENDING", "EXPECTED"].includes(status) || conclusion === "PENDING") {
      hasPending = true;
    }
  }
  return hasPending ? "Pending" : "Pass";
}

async function runGhJson<T>(args: string[]): Promise<T | null> {
  try {
    const { stdout } = await execFileAsync("gh", args, {
      timeout: 7000,
      windowsHide: true,
    });
    return JSON.parse(stdout) as T;
  } catch {
    return null;
  }
}

function refreshSlugInBackground(slug: string, includeCommits: boolean): void {
  const cacheKey = `${slug}:${includeCommits ? "r" : "l"}`;
  if (inFlight.has(cacheKey)) return;
  inFlight.add(cacheKey);

  void (async () => {
    const now = Date.now();
    try {
      const [openPrRaw, mergedPrRaw, issuesRaw, milestonesRaw, commitsRaw] = await Promise.all([
        runGhJson<
          Array<{
            number: number;
            title: string;
            url: string;
            isDraft?: boolean;
            reviewDecision?: string;
            headRefName?: string;
            statusCheckRollup?: Array<{
              conclusion?: string | null;
              status?: string | null;
              state?: string | null;
            }>;
          }>
        >([
          "pr",
          "list",
          "-R",
          slug,
          "--state",
          "open",
          "--limit",
          "6",
          "--json",
          "number,title,url,isDraft,reviewDecision,headRefName,statusCheckRollup",
        ]),
        runGhJson<Array<{ number: number; title: string; url: string; mergedAt?: string }>>([
          "pr",
          "list",
          "-R",
          slug,
          "--state",
          "merged",
          "--limit",
          "5",
          "--json",
          "number,title,url,mergedAt",
        ]),
        runGhJson<Array<{ number: number; title: string; url: string; labels?: Array<{ name: string }> }>>([
          "issue",
          "list",
          "-R",
          slug,
          "--state",
          "open",
          "--limit",
          "8",
          "--json",
          "number,title,url,labels",
        ]),
        runGhJson<
          Array<{
            title: string;
            open_issues: number;
            closed_issues: number;
            due_on?: string | null;
            html_url: string;
          }>
        >(["api", `repos/${slug}/milestones?state=open&per_page=5`]),
        includeCommits
          ? runGhJson<
              Array<{
                sha: string;
                commit: { message: string; committer?: { date?: string }; author?: { date?: string } };
              }>
            >(["api", `repos/${slug}/commits?per_page=15`])
          : Promise.resolve(null),
      ]);

      const anySuccess =
        openPrRaw !== null || mergedPrRaw !== null || issuesRaw !== null || milestonesRaw !== null;

      const openPrs: PullRequestInfo[] = Array.isArray(openPrRaw)
        ? openPrRaw.map((pr) => ({
            number: pr.number,
            title: pr.title,
            url: pr.url,
            isDraft: Boolean(pr.isDraft),
            reviewDecision: pr.reviewDecision ?? "",
            branch: pr.headRefName ?? "",
            ciStatus: summarizeChecks(pr.statusCheckRollup),
          }))
        : [];

      const mergedPrs: MergedPrInfo[] = Array.isArray(mergedPrRaw)
        ? mergedPrRaw.map((pr) => ({
            number: pr.number,
            title: pr.title,
            url: pr.url,
            mergedAt: (pr.mergedAt ?? "").slice(0, 10),
          }))
        : [];

      const openIssues: GitHubIssueInfo[] = Array.isArray(issuesRaw)
        ? issuesRaw.map((iss) => ({
            number: iss.number,
            title: iss.title,
            url: iss.url,
            labels: Array.isArray(iss.labels) ? iss.labels.map((l) => l.name) : [],
          }))
        : [];

      const milestones: GitHubMilestoneInfo[] = Array.isArray(milestonesRaw)
        ? milestonesRaw.map((m) => ({
            title: m.title,
            openIssues: m.open_issues ?? 0,
            closedIssues: m.closed_issues ?? 0,
            dueOn: m.due_on ? m.due_on.slice(0, 10) : null,
            url: m.html_url,
          }))
        : [];

      const remoteCommits: GitCommitSummary[] = Array.isArray(commitsRaw)
        ? commitsRaw.map((c) => {
            const iso = c.commit.committer?.date ?? c.commit.author?.date ?? "";
            return {
              hash: c.sha.slice(0, 7),
              date: iso.slice(0, 10),
              subject: (c.commit.message.split(/\r?\n/)[0] ?? "").trim(),
            };
          })
        : [];

      cache.set(cacheKey, {
        data: {
          available: anySuccess,
          repoSlug: slug,
          openPrs,
          mergedPrs,
          openIssues,
          milestones,
          remoteCommits,
          fetchedAt: anySuccess ? new Date(now).toISOString() : null,
        },
        expiresAt: now + CACHE_TTL_MS,
      });
    } finally {
      inFlight.delete(cacheKey);
    }
  })();
}

// Non-blocking stale-while-revalidate: works for BOTH local repos and remote-only GitHub owner/repo
export async function readGitHubProjectData(opts: {
  repoPath?: string;
  githubRepo?: string;
  includeCommits?: boolean;
}): Promise<GitHubSyncData> {
  const slug =
    opts.githubRepo?.trim() ||
    (opts.repoPath ? await detectGitHubRepoSlug(opts.repoPath) : null);

  if (!slug) {
    return {
      available: false,
      repoSlug: null,
      openPrs: [],
      mergedPrs: [],
      openIssues: [],
      milestones: [],
      remoteCommits: [],
      fetchedAt: null,
    };
  }

  const includeCommits = Boolean(opts.includeCommits);
  const cacheKey = `${slug}:${includeCommits ? "r" : "l"}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);

  if (!cached || cached.expiresAt <= now) {
    setTimeout(() => refreshSlugInBackground(slug, includeCommits), 600);
  }

  return (
    cached?.data ?? {
      available: false,
      repoSlug: slug,
      openPrs: [],
      mergedPrs: [],
      openIssues: [],
      milestones: [],
      remoteCommits: [],
      fetchedAt: null,
    }
  );
}
