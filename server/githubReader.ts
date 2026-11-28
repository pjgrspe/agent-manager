import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitHubSyncData, PullRequestInfo } from "../src/core/types.ts";

const execFileAsync = promisify(execFile);

interface CacheEntry {
  data: GitHubSyncData;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

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

export async function readGitHubPrs(repoPath: string, force = false): Promise<GitHubSyncData> {
  const now = Date.now();
  const cached = cache.get(repoPath);
  if (!force && cached && cached.expiresAt > now) {
    return cached.data;
  }

  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        "5",
        "--json",
        "number,title,url,isDraft,reviewDecision,headRefName,statusCheckRollup",
      ],
      { cwd: repoPath, timeout: 4500, windowsHide: true },
    );

    const parsed = JSON.parse(stdout) as Array<{
      number: number;
      title: string;
      url: string;
      isDraft?: boolean;
      reviewDecision?: string;
      headRefName?: string;
      statusCheckRollup?: Array<{ conclusion?: string | null; status?: string | null; state?: string | null }>;
    }>;

    const openPrs: PullRequestInfo[] = Array.isArray(parsed)
      ? parsed.map((pr) => ({
          number: pr.number,
          title: pr.title,
          url: pr.url,
          isDraft: Boolean(pr.isDraft),
          reviewDecision: pr.reviewDecision ?? "",
          branch: pr.headRefName ?? "",
          ciStatus: summarizeChecks(pr.statusCheckRollup),
        }))
      : [];

    const data: GitHubSyncData = {
      available: true,
      openPrs,
      fetchedAt: new Date(now).toISOString(),
    };
    cache.set(repoPath, { data, expiresAt: now + CACHE_TTL_MS });
    return data;
  } catch {
    const data: GitHubSyncData = {
      available: false,
      openPrs: [],
      fetchedAt: null,
    };
    cache.set(repoPath, { data, expiresAt: now + CACHE_TTL_MS });
    return data;
  }
}
