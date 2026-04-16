import path from "node:path";
import { readFile } from "node:fs/promises";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  type MessageBoxOptions,
} from "electron";

import type { SaveAnnotationRequest } from "../shared/contracts";
import { loadDocument, saveAnnotation } from "../host-core/documents";
import { scanCorpus } from "../host-core/corpus";
import {
  getCloseDialogDetail,
  mapCloseDialogResponse,
} from "../shared/window-close";

let allowWindowClose = false;

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
  allowWindowClose = false;
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

  mainWindow.on("close", (event) => {
    if (allowWindowClose) {
      return;
    }

    event.preventDefault();
    mainWindow.webContents.send("app:onCloseRequested");
  });

  mainWindow.on("closed", () => {
    allowWindowClose = false;
  });

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

  ipcMain.handle("app:confirmClose", async (event, dirtyCount: number) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options: MessageBoxOptions = {
      type: "warning",
      buttons: ["保存并退出", "不保存退出", "取消"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      message: "存在未保存修改",
      detail: getCloseDialogDetail(dirtyCount),
    };
    const result = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);

    return mapCloseDialogResponse(result.response);
  });

  ipcMain.handle("app:completeClose", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      return;
    }

    allowWindowClose = true;
    window.close();
  });
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
