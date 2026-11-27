import http from "node:http";
import path from "node:path";
import type { ProjectStatusData } from "../src/core/types.ts";
import {
  buildStandupSummary,
  createId,
  discoverReposInFolder,
  loadProjectEntries,
  saveProjectEntries,
  scanProject,
  writeProjectStatus,
} from "./scanner.ts";

const PORT = Number(process.env.MANAGER_PORT ?? 4311);
const ALLOWED_ORIGIN = "http://localhost:5173";

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return (raw ? JSON.parse(raw) : {}) as T;
}

function buildClaudeCommand(repoPath: string, initialPrompt?: string): string {
  const escapedPath = repoPath.replace(/'/g, "''");
  const safePrompt = initialPrompt?.replace(/"/g, '\\"').trim();
  const claudeCmd = safePrompt ? `claude "${safePrompt}"` : "claude";
  return `Set-Location -LiteralPath '${escapedPath}'; ${claudeCmd}`;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/api/health") {
      sendJson(res, 200, { ok: true, port: PORT });
      return;
    }

    if (req.method === "GET" && pathname === "/api/projects") {
      const entries = await loadProjectEntries();
      const scanned = await Promise.all(entries.map(scanProject));
      sendJson(res, 200, { projects: scanned });
      return;
    }

    if (req.method === "GET" && pathname === "/api/standup") {
      const entries = await loadProjectEntries();
      const scanned = await Promise.all(entries.map(scanProject));
      sendJson(res, 200, buildStandupSummary(scanned));
      return;
    }

    if (req.method === "POST" && pathname === "/api/projects") {
      const body = await readJsonBody<{ path?: string; name?: string }>(req);
      if (!body.path || !body.path.trim()) {
        sendJson(res, 400, { error: "Project path is required" });
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
      sendJson(res, 200, { projects: scanned });
      return;
    }

    if (req.method === "POST" && pathname === "/api/projects/scan-folder") {
      const body = await readJsonBody<{ rootFolder?: string }>(req);
      if (!body.rootFolder || !body.rootFolder.trim()) {
        sendJson(res, 400, { error: "rootFolder is required" });
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
      sendJson(res, 200, { added, projects: scanned });
      return;
    }

    const deleteMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (req.method === "DELETE" && deleteMatch?.[1]) {
      const id = decodeURIComponent(deleteMatch[1]);
      const entries = (await loadProjectEntries()).filter((e) => e.id !== id);
      await saveProjectEntries(entries);
      const scanned = await Promise.all(entries.map(scanProject));
      sendJson(res, 200, { projects: scanned });
      return;
    }

    const statusMatch = pathname.match(/^\/api\/projects\/([^/]+)\/status$/);
    if (req.method === "PUT" && statusMatch?.[1]) {
      const id = decodeURIComponent(statusMatch[1]);
      const entries = await loadProjectEntries();
      const target = entries.find((e) => e.id === id);
      if (!target) {
        sendJson(res, 404, { error: "Project not found" });
        return;
      }
      const body = await readJsonBody<Omit<ProjectStatusData, "hasStatusFile">>(req);
      const updatedStatus = await writeProjectStatus(target.path, body);
      sendJson(res, 200, { status: updatedStatus });
      return;
    }

    const launchMatch = pathname.match(/^\/api\/projects\/([^/]+)\/launch-claude$/);
    if (req.method === "POST" && launchMatch?.[1]) {
      const id = decodeURIComponent(launchMatch[1]);
      const entries = await loadProjectEntries();
      const target = entries.find((e) => e.id === id);
      if (!target) {
        sendJson(res, 404, { error: "Project not found" });
        return;
      }
      const body = await readJsonBody<{ prompt?: string }>(req);
      const command = buildClaudeCommand(target.path, body.prompt);
      sendJson(res, 200, { command, repoPath: target.path });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected server error";
    sendJson(res, 500, { error: message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[claude-manager] API listening on http://127.0.0.1:${PORT}`);
});
