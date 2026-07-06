import type {
  ExportAudioFolderRequest,
  ExportAudioFolderResult,
  HostBridge,
  ImportAudioFilesResult,
  LoadedAudioDocument,
  ScanDirectoryResult,
  ServerDirectoryListing,
  AnnotationSegment,
  DenoiseAudioRequest,
  DenoiseAudioResult,
  EngineConfig,
  RunAsrPreannotationRequest,
  RunVadPreannotationRequest,
  SaveAnnotationRequest,
  SaveAnnotationResult,
  TestEngineConnectionRequest,
  TestEngineConnectionResult,
  VadSegment,
} from "../../shared/contracts";
import { SERVICE_PORT } from "../../shared/constants";

function getServiceOrigin(): string {
  const configuredOrigin = import.meta.env.VITE_HOST_SERVICE_URL;
  if (configuredOrigin) {
    return configuredOrigin;
  }

  return `${window.location.protocol}//${window.location.hostname}:${SERVICE_PORT}`;
}

async function downloadBlob(url: string, fileName: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(payload?.error ?? "下载 AudioFolder 压缩包失败");
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

async function requestJson<TResponse>(
  endpoint: string,
  body: unknown,
): Promise<Response> {
  return fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function postJson<TResponse>(
  path: string,
  body: unknown,
): Promise<TResponse> {
  try {
    const proxiedResponse = await requestJson<TResponse>(path, body);
    if (proxiedResponse.ok) {
      return proxiedResponse.json() as Promise<TResponse>;
    }

    if (proxiedResponse.status !== 404) {
      const payload = (await proxiedResponse.json().catch(() => null)) as
        | { error?: string }
        | null;
      throw new Error(
        payload?.error ??
          `Request failed: ${proxiedResponse.status} ${proxiedResponse.statusText} (${path})`,
      );
    }
  } catch {
    // Ignore and retry through the dedicated host service origin below.
  }

  const endpoint = `${getServiceOrigin()}${path}`;
  let response: Response;

  try {
    response = await requestJson<TResponse>(endpoint, body);
  } catch {
    throw new Error(
      `Host service is unreachable at ${endpoint}. Start it with "pnpm dev:all" or "pnpm dev:service".`,
    );
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(
      payload?.error ??
        `Request failed: ${response.status} ${response.statusText} (${endpoint})`,
    );
  }

  return response.json() as Promise<TResponse>;
}

export const browserHostBridge: HostBridge = {
  mode: "browser",
  async pickDirectory() {
    return null;
  },
  listServerDirectory(path?: string) {
    return postJson<ServerDirectoryListing>("/api/listServerDirectory", { path });
  },
  scanDirectory(rootPath: string) {
    return postJson<ScanDirectoryResult>("/api/scanDirectory", { rootPath });
  },
  async loadDocument(audioPath: string) {
    const document = await postJson<LoadedAudioDocument>("/api/loadDocument", {
      audioPath,
    });

    return {
      ...document,
      audioUrl: document.audioUrl.startsWith("http")
        ? document.audioUrl
        : `${getServiceOrigin()}${document.audioUrl}`,
    };
  },
  saveAnnotation(request: SaveAnnotationRequest) {
    return postJson<SaveAnnotationResult>("/api/saveAnnotation", request);
  },
  runVadPreannotation(request: RunVadPreannotationRequest) {
    return postJson<VadSegment[]>("/api/runVadPreannotation", request);
  },
  runAsrPreannotation(request: RunAsrPreannotationRequest) {
    return postJson<AnnotationSegment[]>("/api/runAsrPreannotation", request);
  },
  async denoiseAudio(request: DenoiseAudioRequest) {
    const result = await postJson<DenoiseAudioResult>("/api/denoiseAudio", request);
    return {
      ...result,
      audioUrl: result.audioUrl.startsWith("http")
        ? result.audioUrl
        : `${getServiceOrigin()}${result.audioUrl}`,
    };
  },
  async getEngineConfigDefaults() {
    const endpoint = `${getServiceOrigin()}/api/engineConfigDefaults`;
    try {
      const response = await fetch(endpoint);
      if (!response.ok) {
        return { vadGrpcUrl: "", asrGrpcUrl: "", denoiseGrpcUrl: "" };
      }
      return response.json() as Promise<EngineConfig>;
    } catch {
      return { vadGrpcUrl: "", asrGrpcUrl: "", denoiseGrpcUrl: "" };
    }
  },
  testEngineConnection(request: TestEngineConnectionRequest) {
    return postJson<TestEngineConnectionResult>(
      "/api/testEngineConnection",
      request,
    );
  },
  async importAudioFiles(
    rootPath: string,
    files: File[],
    onProgress?: (progressPercent: number) => void,
  ) {
    const formData = new FormData();
    formData.append("rootPath", rootPath);
    const relativePaths: string[] = [];
    for (const file of files) {
      const relativePath =
        (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
        file.name;
      relativePaths.push(relativePath);
      formData.append("files", file, file.name);
    }
    formData.append("relativePaths", JSON.stringify(relativePaths));

    const endpoint = `${getServiceOrigin()}${"/api/importAudioFiles"}`;
    return new Promise<ImportAudioFilesResult>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("POST", endpoint);
      request.upload.onprogress = (event) => {
        if (!event.lengthComputable) {
          return;
        }
        onProgress?.((event.loaded / event.total) * 100);
      };
      request.onerror = () => reject(new Error("导入音频失败"));
      request.onload = () => {
        const payload = JSON.parse(request.responseText || "{}") as
          | ImportAudioFilesResult
          | { error?: string };
        if (request.status < 200 || request.status >= 300) {
          reject(new Error("error" in payload ? payload.error ?? "导入音频失败" : "导入音频失败"));
          return;
        }
        resolve(payload as ImportAudioFilesResult);
      };
      request.send(formData);
    });
  },
  async exportAudioFolder(request: ExportAudioFolderRequest) {
    const result = await postJson<ExportAudioFolderResult>(
      "/api/exportAudioFolder",
      request,
    );
    if (result.downloadUrl) {
      const downloadUrl = result.downloadUrl.startsWith("http")
        ? result.downloadUrl
        : `${getServiceOrigin()}${result.downloadUrl}`;
      await downloadBlob(downloadUrl, result.fileName);
    }
    return result;
  },
  onWindowCloseRequested() {
    return () => undefined;
  },
  async confirmWindowClose() {
    return "cancel";
  },
  async completeWindowClose() {},
};
