import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { AgentKind, ProjectStatusData } from "../src/core/types.ts";
import {
  autoRecapProject,
  buildStandupSummary,
  createId,
  discoverReposInFolder,
  loadProjectEntries,
  saveProjectEntries,
  scanProject,
  writeProjectStatus,
} from "./scanner.ts";

const PORT = Number(process.env.MANAGER_PORT ?? 4311);
const DIST_DIR = path.resolve(process.cwd(), "dist");
const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
]);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function corsOrigin(req: http.IncomingMessage): string {
  const origin = req.headers.origin;
  return origin && ALLOWED_ORIGINS.has(origin) ? origin : `http://127.0.0.1:${PORT}`;
}

function sendJson(req: http.IncomingMessage, res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": corsOrigin(req),
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(payload));
}

async function tryServeStatic(pathname: string, res: http.ServerResponse): Promise<boolean> {
  const safePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const fullPath = path.resolve(DIST_DIR, safePath);
  if (!fullPath.startsWith(DIST_DIR)) return false;

  try {
    const stat = await fs.stat(fullPath);
    if (!stat.isFile()) return false;
    const content = await fs.readFile(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream" });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return (raw ? JSON.parse(raw) : {}) as T;
}

function buildAgentCommand(repoPath: string, agent: AgentKind = "claude", initialPrompt?: string): string {
  const escapedPath = repoPath.replace(/'/g, "''");
  const safePrompt = initialPrompt?.replace(/"/g, '\\"').trim();

  let agentCmd: string;
  switch (agent) {
    case "antigravity":
      agentCmd = safePrompt ? `agy "${safePrompt}"` : "agy";
      break;
    case "codex":
      agentCmd = safePrompt ? `codex "${safePrompt}"` : "codex";
      break;
    case "cursor":
      agentCmd = "cursor .";
      break;
    case "claude":
    default:
      agentCmd = safePrompt ? `claude "${safePrompt}"` : "claude";
      break;
  }

  return `Set-Location -LiteralPath '${escapedPath}'; ${agentCmd}`;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": corsOrigin(req),
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    const pathname = url.pathname;

    if ((req.method === "GET" || req.method === "HEAD") && pathname === "/api/health") {
      if (req.method === "HEAD") {
        res.writeHead(200);
        res.end();
        return;
      }
      sendJson(req, res, 200, { ok: true, port: PORT });
      return;
    }

    if (req.method === "GET" && pathname === "/api/projects") {
      const entries = await loadProjectEntries();
      const scanned = await Promise.all(entries.map(scanProject));
      sendJson(req, res, 200, { projects: scanned });
      return;
    }

    if (req.method === "GET" && pathname === "/api/standup") {
      const entries = await loadProjectEntries();
      const scanned = await Promise.all(entries.map(scanProject));
      sendJson(req, res, 200, buildStandupSummary(scanned));
      return;
    }

    if (req.method === "POST" && pathname === "/api/projects") {
      const body = await readJsonBody<{ path?: string; name?: string }>(req);
      if (!body.path || !body.path.trim()) {
        sendJson(req, res, 400, { error: "Project path is required" });
        return;
      }
      const resolved = path.resolve(body.path.trim());
      const entries = await loadProjectEntries();
      const id = createId(resolved);
      if (!entries.some((e) => e.id === id)) {
        entries.push({
          id,
          name: body.name?.trim() || path.basename(resolved),
          path: resolved,
        });
        await saveProjectEntries(entries);
      }
      const scanned = await Promise.all(entries.map(scanProject));
      sendJson(req, res, 200, { projects: scanned });
      return;
    }

    if (req.method === "POST" && pathname === "/api/projects/scan-folder") {
      const body = await readJsonBody<{ rootFolder?: string }>(req);
      if (!body.rootFolder || !body.rootFolder.trim()) {
        sendJson(req, res, 400, { error: "rootFolder is required" });
        return;
      }
      const discovered = await discoverReposInFolder(body.rootFolder.trim());
      const entries = await loadProjectEntries();
      let added = 0;
      for (const item of discovered) {
        if (!entries.some((e) => e.id === item.id)) {
          entries.push(item);
          added++;
        }
      }
      await saveProjectEntries(entries);
      const scanned = await Promise.all(entries.map(scanProject));
      sendJson(req, res, 200, { added, projects: scanned });
      return;
    }

    const deleteMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (req.method === "DELETE" && deleteMatch?.[1]) {
      const id = decodeURIComponent(deleteMatch[1]);
      const entries = (await loadProjectEntries()).filter((e) => e.id !== id);
      await saveProjectEntries(entries);
      const scanned = await Promise.all(entries.map(scanProject));
      sendJson(req, res, 200, { projects: scanned });
      return;
    }

    const statusMatch = pathname.match(/^\/api\/projects\/([^/]+)\/status$/);
    if (req.method === "PUT" && statusMatch?.[1]) {
      const id = decodeURIComponent(statusMatch[1]);
      const entries = await loadProjectEntries();
      const target = entries.find((e) => e.id === id);
      if (!target) {
        sendJson(req, res, 404, { error: "Project not found" });
        return;
      }
      const body = await readJsonBody<Omit<ProjectStatusData, "hasStatusFile">>(req);
      const updatedStatus = await writeProjectStatus(target.path, body);
      sendJson(req, res, 200, { status: updatedStatus });
      return;
    }

    if (req.method === "POST" && pathname === "/api/projects/auto-recap-all") {
      const entries = await loadProjectEntries();
      const updated = await Promise.all(entries.map(autoRecapProject));
      sendJson(req, res, 200, { projects: updated });
      return;
    }

    const autoRecapMatch = pathname.match(/^\/api\/projects\/([^/]+)\/auto-recap$/);
    if (req.method === "POST" && autoRecapMatch?.[1]) {
      const id = decodeURIComponent(autoRecapMatch[1]);
      const entries = await loadProjectEntries();
      const target = entries.find((e) => e.id === id);
      if (!target) {
        sendJson(req, res, 404, { error: "Project not found" });
        return;
      }
      const updated = await autoRecapProject(target);
      sendJson(req, res, 200, { project: updated });
      return;
    }

    const launchMatch = pathname.match(/^\/api\/projects\/([^/]+)\/(?:launch-agent|launch-claude)$/);
    if (req.method === "POST" && launchMatch?.[1]) {
      const id = decodeURIComponent(launchMatch[1]);
      const entries = await loadProjectEntries();
      const target = entries.find((e) => e.id === id);
      if (!target) {
        sendJson(req, res, 404, { error: "Project not found" });
        return;
      }
      const body = await readJsonBody<{ agent?: AgentKind; prompt?: string }>(req);
      const command = buildAgentCommand(target.path, body.agent ?? "claude", body.prompt);
      sendJson(req, res, 200, { command, repoPath: target.path });
      return;
    }

    if (req.method === "GET" && !pathname.startsWith("/api/")) {
      if (await tryServeStatic(pathname, res)) return;
      if (await tryServeStatic("/", res)) return;
    }

    sendJson(req, res, 404, { error: "Not found" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected server error";
    sendJson(req, res, 500, { error: message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[agent-manager] API listening on http://127.0.0.1:${PORT}`);
});
