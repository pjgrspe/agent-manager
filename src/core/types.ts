export type ProjectState = "Active" | "Waiting on Review" | "Blocked" | "Idle";
export type VerifyHealth = "Pass" | "Fail" | "Unknown";
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
  dirtyCount: number;
  recentCommits: GitCommitSummary[];
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
