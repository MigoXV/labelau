import type { FrequencyScale } from "../shared/contracts";
import type { SystemThemeMode } from "./theme";

type WorkerRequest =
  | {
      kind: "load-document";
      documentId: string;
      channelData: Float32Array[];
      sampleRate: number;
    }
  | {
      kind: "render";
      requestId: number;
      documentId: string;
      channelIndex: number;
      width: number;
      height: number;
      startSec: number;
      endSec: number;
      minFreq: number;
      maxFreq: number;
      frequencyScale: FrequencyScale;
      themeMode: SystemThemeMode;
    };

type WorkerResponse =
  | {
      kind: "loaded";
      documentId: string;
    }
  | {
      kind: "rendered";
      requestId: number;
      width: number;
      height: number;
      pixels: Uint8ClampedArray;
    };

export class SpectrogramWorkerClient {
  private worker = new Worker(
    new URL("../workers/spectrogram.worker.ts", import.meta.url),
    { type: "module" },
  );

  private requestId = 0;
  private pending = new Map<
    number,
    (payload: { width: number; height: number; pixels: Uint8ClampedArray }) => void
  >();

  constructor() {
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const payload = event.data;
      if (payload.kind !== "rendered") {
        return;
      }

      const resolver = this.pending.get(payload.requestId);
      if (!resolver) {
        return;
      }

      this.pending.delete(payload.requestId);
      resolver(payload);
    };
  }

  loadDocument(
    documentId: string,
    channelData: Float32Array[],
    sampleRate: number,
  ): void {
    const payload: WorkerRequest = {
      kind: "load-document",
      documentId,
      channelData,
      sampleRate,
    };

    this.worker.postMessage(payload);
  }

  render(request: Omit<Extract<WorkerRequest, { kind: "render" }>, "kind" | "requestId">) {
    const requestId = ++this.requestId;
    this.worker.postMessage({
      kind: "render",
      requestId,
      ...request,
    } satisfies WorkerRequest);

    return new Promise<ImageData>((resolve) => {
      this.pending.set(requestId, ({ width, height, pixels }) => {
        resolve(new ImageData(new Uint8ClampedArray(pixels), width, height));
      });
    });
  }

  dispose(): void {
    this.pending.clear();
    this.worker.terminate();
  }
}
