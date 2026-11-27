import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { AgentKind, ProjectStatusData } from "../src/core/types.ts";
import {
  autoRecapProject,
  buildStandupSummary,
  createId,
  detectVerifyCommand,
  discoverReposInFolder,
  installBastionIntoRepo,
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

function cleanPathInput(raw: string): string {
  return raw.trim().replace(/^["']+|["']+$/g, "").trim();
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "");
}

function resolveExecCommand(
  mode: "verify" | "agent" | "shell",
  agent: AgentKind,
  prompt: string | undefined,
  verifyCmd: string | null,
): { command: string; args: string[]; label: string } {
  if (mode === "verify") {
    const cmd = verifyCmd || "npm run verify";
    return { command: cmd, args: [], label: cmd };
  }
  if (mode === "shell") {
    const cmd = (prompt ?? "").trim();
    return { command: cmd, args: [], label: cmd };
  }
  const cleanPrompt = (prompt ?? "").trim();
  if (agent === "antigravity") {
    return { command: "agy", args: cleanPrompt ? ["-p", cleanPrompt] : [], label: `agy -p "${cleanPrompt}"` };
  }
  if (agent === "codex") {
    return { command: "codex", args: cleanPrompt ? ["exec", cleanPrompt] : [], label: `codex exec "${cleanPrompt}"` };
  }
  return { command: "claude", args: cleanPrompt ? ["-p", cleanPrompt] : [], label: `claude -p "${cleanPrompt}"` };
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
      const body = await readJsonBody<{ path?: string; name?: string; group?: string }>(req);
      const cleaned = body.path ? cleanPathInput(body.path) : "";
      if (!cleaned) {
        sendJson(req, res, 400, { error: "Project path is required" });
        return;
      }
      const resolved = path.resolve(cleaned);
      const entries = await loadProjectEntries();
      const id = createId(resolved);
      const group = body.group?.trim() || undefined;
      if (!entries.some((e) => e.id === id)) {
        entries.push({
          id,
          name: body.name?.trim() || path.basename(resolved),
          path: resolved,
          group,
        });
        await saveProjectEntries(entries);
      }
      const scanned = await Promise.all(entries.map(scanProject));
      sendJson(req, res, 200, { projects: scanned });
      return;
    }

    if (req.method === "POST" && pathname === "/api/projects/preview-folder") {
      const body = await readJsonBody<{ rootFolder?: string }>(req);
      const cleaned = body.rootFolder ? cleanPathInput(body.rootFolder) : "";
      if (!cleaned) {
        sendJson(req, res, 400, { error: "rootFolder is required" });
        return;
      }
      const discovered = await discoverReposInFolder(cleaned);
      const existing = await loadProjectEntries();
      const existingIds = new Set(existing.map((e) => e.id));
      sendJson(req, res, 200, {
        candidates: discovered.map((d) => ({
          ...d,
          alreadyTracked: existingIds.has(d.id),
        })),
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/projects/batch") {
      const body = await readJsonBody<{ paths?: string[]; group?: string }>(req);
      const paths = Array.isArray(body.paths) ? body.paths : [];
      const group = body.group?.trim() || undefined;
      const entries = await loadProjectEntries();
      let added = 0;
      for (const raw of paths) {
        const cleaned = cleanPathInput(raw);
        if (!cleaned) continue;
        const resolved = path.resolve(cleaned);
        const id = createId(resolved);
        if (!entries.some((e) => e.id === id)) {
          entries.push({ id, name: path.basename(resolved), path: resolved, group });
          added++;
        }
      }
      await saveProjectEntries(entries);
      const scanned = await Promise.all(entries.map(scanProject));
      sendJson(req, res, 200, { added, projects: scanned });
      return;
    }

    const metaMatch = pathname.match(/^\/api\/projects\/([^/]+)\/meta$/);
    if (req.method === "PUT" && metaMatch?.[1]) {
      const id = decodeURIComponent(metaMatch[1]);
      const body = await readJsonBody<{ group?: string; name?: string }>(req);
      const entries = await loadProjectEntries();
      const target = entries.find((e) => e.id === id);
      if (!target) {
        sendJson(req, res, 404, { error: "Project not found" });
        return;
      }
      if (body.group !== undefined) {
        target.group = body.group.trim() || undefined;
      }
      if (body.name !== undefined && body.name.trim()) {
        target.name = body.name.trim();
      }
      await saveProjectEntries(entries);
      const scanned = await Promise.all(entries.map(scanProject));
      sendJson(req, res, 200, { projects: scanned });
      return;
    }

    if (req.method === "POST" && pathname === "/api/projects/scan-folder") {
      const body = await readJsonBody<{ rootFolder?: string }>(req);
      const cleaned = body.rootFolder ? cleanPathInput(body.rootFolder) : "";
      if (!cleaned) {
        sendJson(req, res, 400, { error: "rootFolder is required" });
        return;
      }
      const discovered = await discoverReposInFolder(cleaned);
      const entries = await loadProjectEntries();
      let added = 0;
      let alreadyTracked = 0;
      for (const item of discovered) {
        if (!entries.some((e) => e.id === item.id)) {
          entries.push(item);
          added++;
        } else {
          alreadyTracked++;
        }
      }
      await saveProjectEntries(entries);
      const scanned = await Promise.all(entries.map(scanProject));
      sendJson(req, res, 200, { added, alreadyTracked, totalFound: discovered.length, projects: scanned });
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

    const bastionMatch = pathname.match(/^\/api\/projects\/([^/]+)\/install-bastion$/);
    if (req.method === "POST" && bastionMatch?.[1]) {
      const id = decodeURIComponent(bastionMatch[1]);
      const entries = await loadProjectEntries();
      const target = entries.find((e) => e.id === id);
      if (!target) {
        sendJson(req, res, 404, { error: "Project not found" });
        return;
      }
      const result = await installBastionIntoRepo(target.path);
      const updated = await scanProject(target);
      sendJson(req, res, 200, { ...result, project: updated });
      return;
    }

    const execMatch = pathname.match(/^\/api\/projects\/([^/]+)\/exec$/);
    if (req.method === "POST" && execMatch?.[1]) {
      const id = decodeURIComponent(execMatch[1]);
      const entries = await loadProjectEntries();
      const target = entries.find((e) => e.id === id);
      if (!target) {
        sendJson(req, res, 404, { error: "Project not found" });
        return;
      }
      const body = await readJsonBody<{
        mode?: "verify" | "agent" | "shell";
        agent?: AgentKind;
        prompt?: string;
      }>(req);

      const mode = body.mode ?? "agent";
      const scanned = await scanProject(target);
      const effectiveVerify =
        scanned.antiSlop.verifyCmd ?? (mode === "verify" ? await detectVerifyCommand(target.path) : null);
      if (mode === "verify" && !effectiveVerify) {
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Access-Control-Allow-Origin": corsOrigin(req),
        });
        res.end(
          "No verify/test/build script detected for this repo.\nClick 'Setup Bastion' or add a Verify Cmd in .agents/project-learnings.md.\n",
        );
        return;
      }
      const spec = resolveExecCommand(mode, body.agent ?? "claude", body.prompt, effectiveVerify);
      if (!spec.command) {
        sendJson(req, res, 400, { error: "Command is empty" });
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": corsOrigin(req),
      });

      res.write(`$ ${spec.label}\n\n`);

      const useShell = mode === "verify" || mode === "shell";
      const child = spawn(spec.command, spec.args, {
        cwd: target.path,
        shell: useShell,
        windowsHide: true,
      });

      req.on("close", () => {
        if (!child.killed) child.kill();
      });

      child.stdout?.on("data", (chunk: Buffer) => {
        res.write(stripAnsi(chunk.toString("utf8")));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        res.write(stripAnsi(chunk.toString("utf8")));
      });
      child.on("error", (err) => {
        res.write(`\n[error] ${err.message}\n`);
        res.end();
      });
      child.on("close", async (code) => {
        res.write(`\n[exited with code ${code ?? -1}]\n`);
        if (mode === "verify") {
          try {
            const verifyHealth = code === 0 ? "Pass" : "Fail";
            await writeProjectStatus(target.path, {
              ...scanned.status,
              verify: verifyHealth,
            });
          } catch {
            // ignore status write error
          }
        }
        res.end();
      });
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
