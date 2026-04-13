import { contextBridge, ipcRenderer } from "electron";

import type {
  HostBridge,
  SaveAnnotationRequest,
} from "../shared/contracts";

const hostBridge: HostBridge = {
  mode: "electron",
  pickDirectory: () => ipcRenderer.invoke("host:pickDirectory"),
  scanDirectory: (rootPath) => ipcRenderer.invoke("host:scanDirectory", rootPath),
  loadDocument: (audioPath) => ipcRenderer.invoke("host:loadDocument", audioPath),
  saveAnnotation: (request: SaveAnnotationRequest) =>
    ipcRenderer.invoke("host:saveAnnotation", request),
};

contextBridge.exposeInMainWorld("labelauHost", hostBridge);
