export type ProjectState = "Active" | "Waiting on Review" | "Blocked" | "Idle";
export type VerifyHealth = "Pass" | "Fail" | "Stale" | "Unknown";
export type AgentKind = "claude" | "antigravity" | "codex" | "cursor";

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
}

export interface GitHubSyncData {
  available: boolean;
  openPrs: PullRequestInfo[];
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
  group?: string;
  exists: boolean;
  status: ProjectStatusData;
  git: ProjectGitData;
  antiSlop: AntiSlopInfo;
  claudeSync?: ClaudeSyncData;
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

declare global {
  interface Window {
    agentManager?: {
      pickFolder: () => Promise<string | null>;
    };
  }
}
