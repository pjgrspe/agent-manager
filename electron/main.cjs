const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const APP_ROOT = path.resolve(__dirname, "..");
const PREFERRED_PORT = Number(process.env.MANAGER_PORT || 4311);
const DEV_URL = process.env.MANAGER_WEB_URL || null;

let serverProc = null;

function checkHealth(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(800, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function findFreePort(startPort) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", () => {
      if (startPort < PREFERRED_PORT + 20) {
        resolve(findFreePort(startPort + 1));
      } else {
        reject(new Error("No free local port available"));
      }
    });
    srv.listen(startPort, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : startPort;
      srv.close(() => resolve(port));
    });
  });
}

async function ensureLocalServer() {
  const preferredUrl = `http://127.0.0.1:${PREFERRED_PORT}`;
  if (await checkHealth(`${preferredUrl}/api/health`)) {
    return preferredUrl;
  }

  const port = await findFreePort(PREFERRED_PORT);
  const url = `http://127.0.0.1:${port}`;

  serverProc = spawn("node", ["--experimental-strip-types", "server/index.ts"], {
    cwd: APP_ROOT,
    env: { ...process.env, MANAGER_PORT: String(port) },
    windowsHide: true,
    stdio: "ignore",
  });

  for (let i = 0; i < 40; i++) {
    if (await checkHealth(`${url}/api/health`)) return url;
    await new Promise((r) => setTimeout(r, 150));
  }

  return url;
}

async function createWindow() {
  const targetUrl = DEV_URL || (await ensureLocalServer());

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#07070a",
    title: "Citadel — Control Center",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  win.loadURL(targetUrl);
}

ipcMain.handle("dialog:pickFolder", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    title: "Select Project or Workspace Folder",
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

app.whenReady().then(() => {
  void createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("before-quit", () => {
  if (serverProc && !serverProc.killed) {
    serverProc.kill();
    serverProc = null;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
