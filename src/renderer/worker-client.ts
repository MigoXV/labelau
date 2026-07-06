import type { FrequencyScale } from "../shared/contracts";
import type { SystemThemeMode } from "svara-ui/labelau";

type WorkerRequest =
  | {
      kind: "load-document";
      documentId: string;
      channelData: Int8Array[];
      sampleRate: number;
    }
  | {
      kind: "unload-document";
      documentId: string;
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

type RenderRequest = Omit<
  Extract<WorkerRequest, { kind: "render" }>,
  "kind" | "requestId"
>;

type RenderPayload = {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
};

type LatestRenderJob = {
  requestId: number;
  request: RenderRequest;
  resolve: (imageData: ImageData | null) => void;
};

export class SpectrogramWorkerClient {
  private worker = new Worker(
    new URL("../workers/spectrogram.worker.ts", import.meta.url),
    { type: "module" },
  );

  private requestId = 0;
  private latestRenderRequestId = 0;
  private latestRenderInFlightRequestId: number | null = null;
  private queuedLatestRender: LatestRenderJob | null = null;
  private pending = new Map<number, (payload: RenderPayload) => void>();

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

      if (payload.requestId === this.latestRenderInFlightRequestId) {
        this.latestRenderInFlightRequestId = null;
        this.flushQueuedLatestRender();
      }
    };
  }

  loadDocument(
    documentId: string,
    channelData: Int8Array[],
    sampleRate: number,
  ): void {
    const clonedChannelData = channelData.map((channel) => channel.slice());
    const payload: WorkerRequest = {
      kind: "load-document",
      documentId,
      channelData: clonedChannelData,
      sampleRate,
    };

    this.worker.postMessage(
      payload,
      clonedChannelData.map((channel) => channel.buffer),
    );
  }

  unloadDocument(documentId: string): void {
    this.worker.postMessage({
      kind: "unload-document",
      documentId,
    } satisfies WorkerRequest);
  }

  render(request: RenderRequest) {
    const requestId = ++this.requestId;
    this.worker.postMessage({
      kind: "render",
      requestId,
      ...request,
    } satisfies WorkerRequest);

    return new Promise<ImageData>((resolve) => {
      this.pending.set(requestId, ({ width, height, pixels }) => {
        resolve(new ImageData(pixels, width, height));
      });
    });
  }

  renderLatest(request: RenderRequest) {
    const requestId = ++this.requestId;
    this.latestRenderRequestId = requestId;

    return new Promise<ImageData | null>((resolve) => {
      const job: LatestRenderJob = { requestId, request, resolve };
      if (this.latestRenderInFlightRequestId === null) {
        this.postLatestRender(job);
        return;
      }

      this.queuedLatestRender?.resolve(null);
      this.queuedLatestRender = job;
    });
  }

  private postLatestRender(job: LatestRenderJob): void {
    this.latestRenderInFlightRequestId = job.requestId;
    this.pending.set(job.requestId, ({ width, height, pixels }) => {
      if (job.requestId !== this.latestRenderRequestId) {
        job.resolve(null);
        return;
      }

      job.resolve(new ImageData(pixels, width, height));
    });
    this.worker.postMessage({
      kind: "render",
      requestId: job.requestId,
      ...job.request,
    } satisfies WorkerRequest);
  }

  private flushQueuedLatestRender(): void {
    const job = this.queuedLatestRender;
    if (!job) {
      return;
    }

    this.queuedLatestRender = null;
    this.postLatestRender(job);
  }

  dispose(): void {
    this.queuedLatestRender?.resolve(null);
    this.queuedLatestRender = null;
    this.pending.clear();
    this.worker.terminate();
  }
}
