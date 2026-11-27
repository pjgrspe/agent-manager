const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const APP_ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.MANAGER_PORT || 4311);
const DEV_URL = process.env.MANAGER_WEB_URL || null;
const STANDALONE_URL = `http://127.0.0.1:${PORT}`;

let serverProc = null;

function checkHealth(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensureLocalServer() {
  const healthUrl = `${STANDALONE_URL}/api/health`;
  if (await checkHealth(healthUrl)) return;

  serverProc = spawn("node", ["--experimental-strip-types", "server/index.ts"], {
    cwd: APP_ROOT,
    windowsHide: true,
    stdio: "ignore",
  });

  for (let i = 0; i < 40; i++) {
    if (await checkHealth(healthUrl)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function createWindow() {
  const targetUrl = DEV_URL || STANDALONE_URL;
  if (!DEV_URL) {
    await ensureLocalServer();
  }

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0b0e14",
    title: "Agent Manager — Multi-Project Command Center",
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
