import { contextBridge, ipcRenderer } from "electron";

import type {
  ExportAudioFolderRequest,
  HostBridge,
  DenoiseAudioRequest,
  RunAsrPreannotationRequest,
  RunVadPreannotationRequest,
  SaveAnnotationRequest,
  TestEngineConnectionRequest,
} from "../shared/contracts";

const hostBridge: HostBridge = {
  mode: "electron",
  pickDirectory: () => ipcRenderer.invoke("host:pickDirectory"),
  listServerDirectory: (path) =>
    ipcRenderer.invoke("host:listServerDirectory", path),
  scanDirectory: (rootPath) => ipcRenderer.invoke("host:scanDirectory", rootPath),
  loadDocument: (audioPath) => ipcRenderer.invoke("host:loadDocument", audioPath),
  saveAnnotation: (request: SaveAnnotationRequest) =>
    ipcRenderer.invoke("host:saveAnnotation", request),
  runVadPreannotation: (request: RunVadPreannotationRequest) =>
    ipcRenderer.invoke("host:runVadPreannotation", request),
  runAsrPreannotation: (request: RunAsrPreannotationRequest) =>
    ipcRenderer.invoke("host:runAsrPreannotation", request),
  denoiseAudio: (request: DenoiseAudioRequest) =>
    ipcRenderer.invoke("host:denoiseAudio", request),
  getEngineConfigDefaults: () =>
    ipcRenderer.invoke("host:getEngineConfigDefaults"),
  testEngineConnection: (request: TestEngineConnectionRequest) =>
    ipcRenderer.invoke("host:testEngineConnection", request),
  importAudioFiles: async () => {
    throw new Error("Electron 模式请使用“打开目录”导入本地音频");
  },
  exportAudioFolder: (request: ExportAudioFolderRequest) =>
    ipcRenderer.invoke("host:exportAudioFolder", request),
  onWindowCloseRequested: (listener) => {
    const wrappedListener = () => listener();
    ipcRenderer.on("app:onCloseRequested", wrappedListener);
    return () => {
      ipcRenderer.removeListener("app:onCloseRequested", wrappedListener);
    };
  },
  confirmWindowClose: (dirtyCount) =>
    ipcRenderer.invoke("app:confirmClose", dirtyCount),
  completeWindowClose: () => ipcRenderer.invoke("app:completeClose"),
};

contextBridge.exposeInMainWorld("labelauHost", hostBridge);
