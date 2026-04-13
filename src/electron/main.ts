import path from "node:path";
import { readFile } from "node:fs/promises";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
} from "electron";

import type { SaveAnnotationRequest } from "../shared/contracts";
import { loadDocument, saveAnnotation } from "../host-core/documents";
import { scanCorpus } from "../host-core/corpus";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "labelau",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: "#f3f1eb",
    title: "LabelAU",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../../dist/index.html"));
  }

  return mainWindow;
}

async function registerProtocol(): Promise<void> {
  await protocol.handle("labelau", async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "audio") {
      return new Response("Not found", { status: 404 });
    }

    const audioPath = url.searchParams.get("audioPath");
    if (!audioPath) {
      return new Response("Missing audioPath", { status: 400 });
    }

    const bytes = await readFile(audioPath);
    return new Response(bytes, {
      headers: {
        "content-type": "audio/wav",
      },
    });
  });
}

async function registerIpcHandlers(): Promise<void> {
  ipcMain.handle("host:pickDirectory", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });

    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle("host:scanDirectory", async (_event, rootPath: string) => {
    return scanCorpus(rootPath);
  });

  ipcMain.handle("host:loadDocument", async (_event, audioPath: string) => {
    return loadDocument(audioPath, (resolvedAudioPath) => {
      const params = new URLSearchParams({ audioPath: resolvedAudioPath });
      return `labelau://audio?${params.toString()}`;
    });
  });

  ipcMain.handle(
    "host:saveAnnotation",
    async (_event, request: SaveAnnotationRequest) => {
      return saveAnnotation(request);
    },
  );
}

app.whenReady().then(async () => {
  await registerProtocol();
  await registerIpcHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
