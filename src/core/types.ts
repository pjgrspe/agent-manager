export type ProjectState = "Active" | "Waiting on Review" | "Blocked" | "Idle";
export type VerifyHealth = "Pass" | "Fail" | "Stale" | "Unknown";
export type AgentKind = "claude" | "antigravity" | "codex" | "cursor";
export type ProjectSourceType = "local" | "remote";

export interface PlanItem {
  text: string;
  done: boolean;
}

export interface ProjectStatusData {
  state: ProjectState;
  updated: string;
  verify: VerifyHealth;
  recap: string[];
  plan: PlanItem[];
  blockers: string[];
  hasStatusFile: boolean;
}

export interface GitCommitSummary {
  hash: string;
  date: string;
  subject: string;
}

export interface ProjectGitData {
  isGitRepo: boolean;
  branch: string;
  headSha: string;
  headTimestamp: string | null;
  dirtyCount: number;
  ahead: number;
  behind: number;
  recentCommits: GitCommitSummary[];
}

export interface PullRequestInfo {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  reviewDecision: string;
  branch: string;
  ciStatus: "Pass" | "Fail" | "Pending" | "None";
  approvedBy?: string[];
  commentCount?: number;
  reviewState?: "Approved" | "Changes Requested" | "Commented" | "Pending";
}

export interface MergedPrInfo {
  number: number;
  title: string;
  url: string;
  mergedAt: string;
}

export interface GitHubIssueInfo {
  number: number;
  title: string;
  url: string;
  labels: string[];
}

export interface GitHubMilestoneInfo {
  title: string;
  openIssues: number;
  closedIssues: number;
  dueOn: string | null;
  url: string;
}

export interface GitHubSyncData {
  available: boolean;
  repoSlug: string | null;
  openPrs: PullRequestInfo[];
  mergedPrs: MergedPrInfo[];
  openIssues: GitHubIssueInfo[];
  milestones: GitHubMilestoneInfo[];
  remoteCommits: GitCommitSummary[];
  fetchedAt: string | null;
}

export interface AntiSlopInfo {
  hasAgentsMd: boolean;
  hasClaudeMd: boolean;
  hasSkill: boolean;
  hasLearnings: boolean;
  verifyCmd: string | null;
  skillCount: number;
}

export interface ClaudeSyncData {
  found: boolean;
  lastSessionAt: string | null;
  sessionTodos: PlanItem[];
  memoryFlags: string[];
  memoryCount: number;
  memoryIndex?: string | null;
}

export interface AgentSessionSignal {
  agent: "Claude Code" | "Antigravity";
  lastActiveAt: string | null;
  summary: string;
  tasks: PlanItem[];
}

export interface GroundTruthSummary {
  state: ProjectState;
  reason: string;
  source: "github" | "git" | "verify" | "claude" | "manual";
  verifyHealth: VerifyHealth;
  verifySha: string | null;
  verifyAt: string | null;
  statusFileStale: boolean;
}

export interface ManagedProject {
  id: string;
  name: string;
  path: string;
  sourceType: ProjectSourceType;
  githubRepo?: string;
  group?: string;
  exists: boolean;
  status: ProjectStatusData;
  git: ProjectGitData;
  antiSlop: AntiSlopInfo;
  claudeSync?: ClaudeSyncData;
  agentSessions: AgentSessionSignal[];
  github?: GitHubSyncData;
  truth: GroundTruthSummary;
}

export interface StandupSummary {
  generatedAt: string;
  markdown: string;
  counts: {
    total: number;
    blocked: number;
    waitingOnReview: number;
    active: number;
    idle: number;
  };
}

export type MemorySourceKind =
  | "commit"
  | "pr"
  | "merged_pr"
  | "issue"
  | "milestone"
  | "agent_session"
  | "claude_memory"
  | "blocker"
  | "plan";

export interface MemorySearchHit {
  docKey: string;
  projectId: string;
  projectName: string;
  source: MemorySourceKind;
  title: string;
  snippet: string;
  url: string | null;
  occurredAt: string | null;
}

export interface MemoryIndexStats {
  totalDocs: number;
  bySource: Record<string, number>;
  lastIndexedAt: string | null;
}

export interface PmDigestItem {
  projectId: string;
  projectName: string;
  group?: string;
  summary: string;
  detail?: string;
  url?: string | null;
}

export interface PmSuggestion {
  priority: "high" | "medium" | "info";
  projectId: string;
  projectName: string;
  action: string;
  reason: string;
}

export interface PmDigestBrief {
  suggestions: PmSuggestion[];
  shipped: PmDigestItem[];
  needsAttention: PmDigestItem[];
  plannedWork: PmDigestItem[];
  agentUpdates: PmDigestItem[];
}

export interface PmDigestEntry {
  id?: number;
  period: "daily" | "weekly";
  createdAt: string;
  headline: string;
  stats: {
    commitsCount: number;
    mergedPrsCount: number;
    openPrsCount: number;
    openIssuesCount: number;
    blockedCount: number;
    activeAgentsCount: number;
  };
  brief?: PmDigestBrief;
  markdown: string;
}

declare global {
  interface Window {
    agentManager?: {
      pickFolder: () => Promise<string | null>;
    };
  }
}
