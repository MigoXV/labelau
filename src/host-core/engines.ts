import path from "node:path";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

import type {
  AnnotationSegment,
  DenoiseAudioResult,
  RunVadPreannotationRequest,
  RunAsrPreannotationRequest,
  EngineConfig,
  TestEngineConnectionRequest,
  TestEngineConnectionResult,
  VadSegment,
} from "../shared/contracts";
import {
  assertNonOverlappingSegments,
  hydrateAnnotationSegments,
} from "../shared/annotations";
import { getAudioExtension } from "../shared/audio-format";
import { normalizeSegments } from "../shared/vad";

import { createPcmWavBuffer, readWavPcmAudio } from "./wav";

const ENGINE_DEADLINE_MS = 60_000;
const ENGINE_MAX_MESSAGE_BYTES = 500 * 1024 * 1024;
const PROTO_ROOT = path.resolve(__dirname, "../../protos");
const VAD_PROTO_PATH = path.join(PROTO_ROOT, "ux_vad.proto");
const ASR_PROTO_PATH = path.join(PROTO_ROOT, "ux_asr.proto");
const DENOISE_PROTO_PATH = path.join(PROTO_ROOT, "ux_denoise.proto");

type GrpcCallback<TResponse> = (error: Error | null, response?: TResponse) => void;
type UnaryMethod<TRequest, TResponse> = (
  request: TRequest,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
  callback: GrpcCallback<TResponse>,
) => void;

interface GrpcClientLifecycle {
  waitForReady(deadline: grpc.Deadline, callback: (error?: Error) => void): void;
  close(): void;
}

interface VadClient extends GrpcClientLifecycle {
  Detect: UnaryMethod<
    { config: { encoding: number; sampleRateHertz: number }; audio: Buffer },
    { results?: Array<{ startTime?: DurationLike; endTime?: DurationLike }> }
  >;
}

interface AsrClient extends GrpcClientLifecycle {
  Recognize: UnaryMethod<
    {
      config: {
        encoding: number;
        sampleRateHertz: number;
        languageCode: string;
      };
      audio: Buffer;
    },
    {
      results?: Array<{
        startTime?: DurationLike;
        endTime?: DurationLike;
        transcript?: string;
      }>;
    }
  >;
}

interface DenoiseClient extends GrpcClientLifecycle {
  Denoise: UnaryMethod<
    {
      audioInConfig: { encoding: number; sampleRateHertz: number };
      audioOutConfig: { encoding: number; sampleRateHertz: number };
      audioIn: Buffer;
    },
    { audioOut?: Buffer | Uint8Array | string }
  >;
}

interface DurationLike {
  seconds?: number | string;
  nanos?: number;
}

function assertWavAudio(audioPath: string): void {
  if (getAudioExtension(audioPath) !== ".wav") {
    throw new Error("VAD 预标注和降噪第一版仅支持 16-bit PCM WAV 音频");
  }
}

function loadGrpcPackage(protoPath: string): grpc.GrpcObject {
  const definition = protoLoader.loadSync(protoPath, {
    keepCase: false,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_ROOT],
  });

  return grpc.loadPackageDefinition(definition);
}

function createVadClient(address: string): VadClient {
  const loaded = loadGrpcPackage(VAD_PROTO_PATH) as {
    ux_vad?: {
      UxVoiceActivityDetector?: grpc.ServiceClientConstructor;
    };
  };
  const Client = loaded.ux_vad?.UxVoiceActivityDetector;
  if (!Client) {
    throw new Error("无法加载 VAD gRPC proto");
  }

  return new Client(address, grpc.credentials.createInsecure(), {
    "grpc.max_send_message_length": ENGINE_MAX_MESSAGE_BYTES,
    "grpc.max_receive_message_length": ENGINE_MAX_MESSAGE_BYTES,
  }) as unknown as VadClient;
}

function createAsrClient(address: string): AsrClient {
  const loaded = loadGrpcPackage(ASR_PROTO_PATH) as {
    ux_asr?: {
      UxSpeechRecognizer?: grpc.ServiceClientConstructor;
    };
  };
  const Client = loaded.ux_asr?.UxSpeechRecognizer;
  if (!Client) {
    throw new Error("无法加载 ASR gRPC proto");
  }

  return new Client(address, grpc.credentials.createInsecure(), {
    "grpc.max_send_message_length": ENGINE_MAX_MESSAGE_BYTES,
    "grpc.max_receive_message_length": ENGINE_MAX_MESSAGE_BYTES,
  }) as unknown as AsrClient;
}

function createDenoiseClient(address: string): DenoiseClient {
  const loaded = loadGrpcPackage(DENOISE_PROTO_PATH) as {
    ux_denoise_proto?: {
      UxDenoise?: grpc.ServiceClientConstructor;
    };
  };
  const Client = loaded.ux_denoise_proto?.UxDenoise;
  if (!Client) {
    throw new Error("无法加载降噪 gRPC proto");
  }

  return new Client(address, grpc.credentials.createInsecure(), {
    "grpc.max_send_message_length": ENGINE_MAX_MESSAGE_BYTES,
    "grpc.max_receive_message_length": ENGINE_MAX_MESSAGE_BYTES,
  }) as unknown as DenoiseClient;
}

function callUnary<TRequest, TResponse>(
  method: UnaryMethod<TRequest, TResponse>,
  request: TRequest,
): Promise<TResponse> {
  return new Promise((resolve, reject) => {
    method.call(
      undefined,
      request,
      new grpc.Metadata(),
      { deadline: Date.now() + ENGINE_DEADLINE_MS },
      (error, response) => {
        if (error) {
          reject(error);
          return;
        }

        if (!response) {
          reject(new Error("引擎返回空响应"));
          return;
        }

        resolve(response);
      },
    );
  });
}

function durationToSeconds(duration?: DurationLike): number {
  if (!duration) {
    return 0;
  }

  return Number(duration.seconds ?? 0) + (duration.nanos ?? 0) / 1_000_000_000;
}

function toBuffer(bytes: Buffer | Uint8Array | string | undefined): Buffer {
  if (!bytes) {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(bytes)) {
    return bytes;
  }
  if (typeof bytes === "string") {
    return Buffer.from(bytes, "base64");
  }
  return Buffer.from(bytes);
}

function mapGrpcError(error: unknown, fallback: string): Error {
  if (!(error instanceof Error)) {
    return new Error(fallback);
  }

  const grpcError = error as Error & { code?: number; details?: string };
  const details = grpcError.details || grpcError.message;
  return new Error(`${fallback}：${details}`);
}

function getConfiguredAddress(
  requestAddress: string | undefined,
  environmentAddress: string | undefined,
  label: string,
): string {
  const address = requestAddress?.trim() || environmentAddress;
  if (!address) {
    throw new Error(`未配置${label}引擎地址：请在引擎设置中填写 gRPC 地址`);
  }
  return address;
}

export async function runVadPreannotation(
  request: RunVadPreannotationRequest,
): Promise<VadSegment[]> {
  const address = getConfiguredAddress(
    request.vadGrpcUrl,
    process.env.LABELAU_VAD_GRPC_URL,
    " VAD ",
  );

  assertWavAudio(request.audioPath);
  const audio = await readWavPcmAudio(request.audioPath);
  const pcm = request.audioContentBase64
    ? Buffer.from(request.audioContentBase64, "base64").subarray(44)
    : audio.pcm;

  try {
    const client = createVadClient(address);
    const response = await callUnary(client.Detect.bind(client), {
      config: {
        encoding: 1,
        sampleRateHertz: audio.sampleRate,
      },
      audio: pcm,
    });

    return normalizeSegments(
      (response.results ?? []).map((result) => ({
        startSec: durationToSeconds(result.startTime),
        endSec: durationToSeconds(result.endTime),
      })),
    );
  } catch (error) {
    throw mapGrpcError(error, "VAD 预标注失败");
  }
}

export async function runAsrPreannotation(
  request: RunAsrPreannotationRequest,
): Promise<AnnotationSegment[]> {
  const address = getConfiguredAddress(
    request.asrGrpcUrl,
    process.env.LABELAU_ASR_GRPC_URL,
    " ASR ",
  );

  assertWavAudio(request.audioPath);
  const audio = await readWavPcmAudio(request.audioPath);
  const pcm = request.audioContentBase64
    ? Buffer.from(request.audioContentBase64, "base64").subarray(44)
    : audio.pcm;

  try {
    const client = createAsrClient(address);
    const response = await callUnary(client.Recognize.bind(client), {
      config: {
        encoding: 1,
        sampleRateHertz: audio.sampleRate,
        languageCode: "zh-CN",
      },
      audio: pcm,
    });
    const rawSegments = (response.results ?? []).map((result, index) => ({
      id: `asr_${index}`,
      startSec: durationToSeconds(result.startTime),
      endSec: durationToSeconds(result.endTime),
      transcript: result.transcript ?? "",
    }));
    assertNonOverlappingSegments(rawSegments, "ASR 返回片段");
    const segments = hydrateAnnotationSegments(rawSegments);
    return segments;
  } catch (error) {
    throw mapGrpcError(error, "ASR 预标注失败");
  }
}

export async function denoiseAudio(
  audioPath: string,
  resolveAudioUrl: (id: string) => string,
  denoiseGrpcUrl?: string,
): Promise<DenoiseAudioResult> {
  const address = getConfiguredAddress(
    denoiseGrpcUrl,
    process.env.LABELAU_DENOISE_GRPC_URL,
    "降噪",
  );

  assertWavAudio(audioPath);
  const audio = await readWavPcmAudio(audioPath);

  try {
    const client = createDenoiseClient(address);
    const response = await callUnary(client.Denoise.bind(client), {
      audioInConfig: {
        encoding: 1,
        sampleRateHertz: audio.sampleRate,
      },
      audioOutConfig: {
        encoding: 1,
        sampleRateHertz: audio.sampleRate,
      },
      audioIn: audio.pcm,
    });
    const denoisedPcm = toBuffer(response.audioOut);
    if (denoisedPcm.length === 0) {
      throw new Error("降噪引擎返回空音频");
    }

    const wav = createPcmWavBuffer(denoisedPcm, audio.sampleRate, audio.channelCount);
    const id = cacheDenoisedAudio(wav);

    return {
      audioUrl: resolveAudioUrl(id),
      audioContentBase64: wav.toString("base64"),
      sampleRate: audio.sampleRate,
      channelCount: audio.channelCount,
      durationSec: denoisedPcm.length / (audio.sampleRate * audio.channelCount * 2),
    };
  } catch (error) {
    throw mapGrpcError(error, "降噪失败");
  }
}

const denoisedAudioCache = new Map<string, Buffer>();

export function cacheDenoisedAudio(audio: Buffer): string {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  denoisedAudioCache.set(id, audio);
  return id;
}

export function getDenoisedAudio(id: string): Buffer | null {
  return denoisedAudioCache.get(id) ?? null;
}

export function getEngineConfigDefaults(): EngineConfig {
  return {
    vadGrpcUrl: process.env.LABELAU_VAD_GRPC_URL ?? "",
    asrGrpcUrl: process.env.LABELAU_ASR_GRPC_URL ?? "",
    denoiseGrpcUrl: process.env.LABELAU_DENOISE_GRPC_URL ?? "",
  };
}

function waitForReady(client: GrpcClientLifecycle): Promise<void> {
  return new Promise((resolve, reject) => {
    client.waitForReady(Date.now() + 5_000, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function testEngineConnection(
  request: TestEngineConnectionRequest,
): Promise<TestEngineConnectionResult> {
  const label =
    request.engine === "vad" ? "VAD" : request.engine === "asr" ? "ASR" : "降噪";

  let address: string;
  try {
    address = getConfiguredAddress(
      request.grpcUrl,
      request.engine === "vad"
        ? process.env.LABELAU_VAD_GRPC_URL
        : request.engine === "asr"
          ? process.env.LABELAU_ASR_GRPC_URL
          : process.env.LABELAU_DENOISE_GRPC_URL,
      request.engine === "vad"
        ? " VAD "
        : request.engine === "asr"
          ? " ASR "
          : "降噪",
    );
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : `${label} 引擎地址未配置`,
    };
  }

  const client =
    request.engine === "vad"
      ? createVadClient(address)
      : request.engine === "asr"
        ? createAsrClient(address)
        : createDenoiseClient(address);
  try {
    await waitForReady(client);
    return {
      ok: true,
      message: `${label} 引擎连接成功：${address}`,
    };
  } catch (error) {
    return {
      ok: false,
      message: mapGrpcError(error, `${label} 引擎连接失败`).message,
    };
  } finally {
    client.close();
  }
}
