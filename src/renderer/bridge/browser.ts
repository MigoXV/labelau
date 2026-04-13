import type {
  CorpusEntryTree,
  HostBridge,
  LoadedAudioDocument,
  SaveAnnotationRequest,
  SaveAnnotationResult,
} from "../../shared/contracts";
import { SERVICE_PORT } from "../../shared/constants";

function getServiceOrigin(): string {
  const configuredOrigin = import.meta.env.VITE_HOST_SERVICE_URL;
  if (configuredOrigin) {
    return configuredOrigin;
  }

  return `${window.location.protocol}//${window.location.hostname}:${SERVICE_PORT}`;
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
      `Host service is unreachable at ${endpoint}. Start it with "pnpm dev:web" or "pnpm dev:service".`,
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
    const directory = window.prompt("输入待扫描目录的绝对路径");
    return directory?.trim() ? directory.trim() : null;
  },
  scanDirectory(rootPath: string) {
    return postJson<CorpusEntryTree>("/api/scanDirectory", { rootPath });
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
};
