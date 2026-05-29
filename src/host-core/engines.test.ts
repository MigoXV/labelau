import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { afterEach, describe, expect, it } from "vitest";

import { createPcmWavBuffer } from "./wav";
import { denoiseAudio, runVadPreannotation } from "./engines";

const testRoots: string[] = [];
const servers: grpc.Server[] = [];
const protoRoot = path.resolve(__dirname, "../../protos");

afterEach(async () => {
  delete process.env.LABELAU_VAD_GRPC_URL;
  delete process.env.LABELAU_DENOISE_GRPC_URL;
  for (const server of servers.splice(0)) {
    server.forceShutdown();
  }
  await Promise.all(
    testRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createWavFile(pcm = Buffer.from([0x00, 0x00, 0xff, 0x7f])) {
  const root = await mkdtemp(path.join(tmpdir(), "labelau-engine-"));
  testRoots.push(root);
  const audioPath = path.join(root, "voice.wav");
  await writeFile(audioPath, createPcmWavBuffer(pcm, 16000, 1));
  return audioPath;
}

function loadPackage(protoName: string): grpc.GrpcObject {
  const definition = protoLoader.loadSync(path.join(protoRoot, protoName), {
    keepCase: false,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [protoRoot],
  });
  return grpc.loadPackageDefinition(definition);
}

async function bindServer(server: grpc.Server): Promise<string> {
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (error, boundPort) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(boundPort);
      },
    );
  });
  servers.push(server);
  return `127.0.0.1:${port}`;
}

describe("engine clients", () => {
  it("sends LINEAR16 PCM to VAD and normalizes returned segments", async () => {
    const audioPath = await createWavFile();
    const loaded = loadPackage("ux_vad.proto") as {
      ux_vad: { UxVoiceActivityDetector: grpc.ServiceClientConstructor };
    };
    const server = new grpc.Server();
    server.addService(loaded.ux_vad.UxVoiceActivityDetector.service, {
      Detect(call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) {
        const request = call.request as {
          config: { encoding: number; sampleRateHertz: number };
          audio: Buffer;
        };
        expect(request.config.encoding).toBe(1);
        expect(request.config.sampleRateHertz).toBe(16000);
        expect(Buffer.from(request.audio)).toEqual(Buffer.from([0x00, 0x00, 0xff, 0x7f]));
        callback(null, {
          results: [
            {
              startTime: { seconds: "0", nanos: 500_000_000 },
              endTime: { seconds: "1", nanos: 250_000_000 },
            },
          ],
        });
      },
    });
    process.env.LABELAU_VAD_GRPC_URL = await bindServer(server);

    await expect(runVadPreannotation({ audioPath })).resolves.toEqual([
      { startSec: 0.5, endSec: 1.25 },
    ]);
  });

  it("uses request VAD address before environment defaults", async () => {
    const audioPath = await createWavFile();
    const loaded = loadPackage("ux_vad.proto") as {
      ux_vad: { UxVoiceActivityDetector: grpc.ServiceClientConstructor };
    };
    const server = new grpc.Server();
    server.addService(loaded.ux_vad.UxVoiceActivityDetector.service, {
      Detect(_call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) {
        callback(null, {
          results: [
            {
              startTime: { seconds: "2", nanos: 0 },
              endTime: { seconds: "3", nanos: 0 },
            },
          ],
        });
      },
    });
    process.env.LABELAU_VAD_GRPC_URL = "127.0.0.1:1";
    const vadGrpcUrl = await bindServer(server);

    await expect(runVadPreannotation({ audioPath, vadGrpcUrl })).resolves.toEqual([
      { startSec: 2, endSec: 3 },
    ]);
  });

  it("requires a configured VAD address", async () => {
    const audioPath = await createWavFile();

    await expect(runVadPreannotation({ audioPath })).rejects.toThrow(
      "请在引擎设置中填写 gRPC 地址",
    );
  });

  it("sends LINEAR16 PCM to denoise and wraps returned PCM as WAV", async () => {
    const audioPath = await createWavFile();
    const denoisedPcm = Buffer.from([0x01, 0x00, 0x02, 0x00]);
    const loaded = loadPackage("ux_denoise.proto") as {
      ux_denoise_proto: { UxDenoise: grpc.ServiceClientConstructor };
    };
    const server = new grpc.Server();
    server.addService(loaded.ux_denoise_proto.UxDenoise.service, {
      Denoise(call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) {
        const request = call.request as {
          audioInConfig: { encoding: number; sampleRateHertz: number };
          audioOutConfig: { encoding: number; sampleRateHertz: number };
          audioIn: Buffer;
        };
        expect(request.audioInConfig.encoding).toBe(1);
        expect(request.audioInConfig.sampleRateHertz).toBe(16000);
        expect(request.audioOutConfig.encoding).toBe(1);
        expect(request.audioOutConfig.sampleRateHertz).toBe(16000);
        expect(Buffer.from(request.audioIn)).toEqual(Buffer.from([0x00, 0x00, 0xff, 0x7f]));
        callback(null, { audioOut: denoisedPcm });
      },
    });
    process.env.LABELAU_DENOISE_GRPC_URL = await bindServer(server);

    const result = await denoiseAudio(
      audioPath,
      (id) => `memory://${id}`,
    );
    const bytes = Buffer.from(result.audioContentBase64, "base64");

    expect(result.audioUrl.startsWith("memory://")).toBe(true);
    expect(result.sampleRate).toBe(16000);
    expect(result.channelCount).toBe(1);
    expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
    expect(bytes.subarray(44)).toEqual(denoisedPcm);
  });
});
