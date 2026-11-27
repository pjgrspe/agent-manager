const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentManager", {
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),
});
