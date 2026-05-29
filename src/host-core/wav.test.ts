import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createPcmWavBuffer, readWavPcmAudio } from "./wav";

const testRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    testRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("wav pcm helpers", () => {
  it("reads 16-bit PCM WAV bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "labelau-wav-"));
    testRoots.push(root);
    const pcm = Buffer.from([0x00, 0x00, 0xff, 0x7f]);
    const wavPath = path.join(root, "voice.wav");
    await writeFile(wavPath, createPcmWavBuffer(pcm, 16000, 1));

    const audio = await readWavPcmAudio(wavPath);

    expect(audio.sampleRate).toBe(16000);
    expect(audio.channelCount).toBe(1);
    expect(audio.bitsPerSample).toBe(16);
    expect(audio.pcm).toEqual(pcm);
  });

  it("rejects non 16-bit PCM WAV files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "labelau-wav-"));
    testRoots.push(root);
    const wav = createPcmWavBuffer(Buffer.from([0x00]), 16000, 1);
    wav.writeUInt16LE(8, 34);
    const wavPath = path.join(root, "voice.wav");
    await writeFile(wavPath, wav);

    await expect(readWavPcmAudio(wavPath)).rejects.toThrow(
      "仅支持 16-bit PCM WAV 音频",
    );
  });
});
