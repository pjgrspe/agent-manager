import type { AgentKind, ManagedProject, ProjectStatusData, StandupSummary } from "./types.ts";

const API_BASE = "/api";

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return data;
}

export async function fetchProjects(): Promise<ManagedProject[]> {
  const res = await requestJson<{ projects: ManagedProject[] }>("/projects");
  return res.projects;
}

export async function addProject(path: string, name?: string): Promise<ManagedProject[]> {
  const res = await requestJson<{ projects: ManagedProject[] }>("/projects", {
    method: "POST",
    body: JSON.stringify({ path, name }),
  });
  return res.projects;
}

export async function scanFolder(rootFolder: string): Promise<{ added: number; projects: ManagedProject[] }> {
  return requestJson<{ added: number; projects: ManagedProject[] }>("/projects/scan-folder", {
    method: "POST",
    body: JSON.stringify({ rootFolder }),
  });
}

export async function removeProject(id: string): Promise<ManagedProject[]> {
  const res = await requestJson<{ projects: ManagedProject[] }>(`/projects/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return res.projects;
}

export async function updateProjectStatus(
  id: string,
  status: Omit<ProjectStatusData, "hasStatusFile">,
): Promise<ProjectStatusData> {
  const res = await requestJson<{ status: ProjectStatusData }>(`/projects/${encodeURIComponent(id)}/status`, {
    method: "PUT",
    body: JSON.stringify(status),
  });
  return res.status;
}

export async function autoRecapAll(): Promise<ManagedProject[]> {
  const res = await requestJson<{ projects: ManagedProject[] }>("/projects/auto-recap-all", {
    method: "POST",
  });
  return res.projects;
}

export async function autoRecapOne(id: string): Promise<ManagedProject> {
  const res = await requestJson<{ project: ManagedProject }>(
    `/projects/${encodeURIComponent(id)}/auto-recap`,
    { method: "POST" },
  );
  return res.project;
}

export async function buildAgentCommand(
  id: string,
  agent: AgentKind,
  prompt?: string,
): Promise<string> {
  const res = await requestJson<{ command: string }>(
    `/projects/${encodeURIComponent(id)}/launch-agent`,
    {
      method: "POST",
      body: JSON.stringify({ agent, prompt }),
    },
  );
  return res.command;
}

export async function streamProjectExec(
  id: string,
  opts: { mode: "verify" | "agent" | "shell"; agent: AgentKind; prompt?: string },
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(id)}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`Execution failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk(decoder.decode(value, { stream: true }));
  }
}

export async function fetchStandup(): Promise<StandupSummary> {
  return requestJson<StandupSummary>("/standup");
}
