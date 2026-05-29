import { open } from "node:fs/promises";

import type { AudioMeta } from "../shared/contracts";

function readAscii(buffer: Buffer, start: number, end: number): string {
  return buffer.toString("ascii", start, end);
}

export interface WavPcmAudio {
  sampleRate: number;
  channelCount: number;
  bitsPerSample: number;
  pcm: Buffer;
}

function unsupportedPcmWav(filePath: string): Error {
  return new Error(`仅支持 16-bit PCM WAV 音频：${filePath}`);
}

export async function readWavMetadata(filePath: string): Promise<AudioMeta> {
  const handle = await open(filePath, "r");

  try {
    const riffHeader = Buffer.alloc(12);
    await handle.read(riffHeader, 0, riffHeader.length, 0);

    if (
      readAscii(riffHeader, 0, 4) !== "RIFF" ||
      readAscii(riffHeader, 8, 12) !== "WAVE"
    ) {
      throw new Error(`Unsupported WAV file: ${filePath}`);
    }

    let cursor = 12;
    let sampleRate = 0;
    let channelCount = 0;
    let bitsPerSample = 0;
    let byteRate = 0;
    let dataSize = 0;

    while (true) {
      const header = Buffer.alloc(8);
      const { bytesRead } = await handle.read(header, 0, header.length, cursor);
      if (bytesRead < 8) {
        break;
      }

      const chunkId = readAscii(header, 0, 4);
      const chunkSize = header.readUInt32LE(4);
      cursor += 8;

      if (chunkId === "fmt ") {
        const fmtBuffer = Buffer.alloc(Math.min(chunkSize, 32));
        await handle.read(fmtBuffer, 0, fmtBuffer.length, cursor);
        channelCount = fmtBuffer.readUInt16LE(2);
        sampleRate = fmtBuffer.readUInt32LE(4);
        byteRate = fmtBuffer.readUInt32LE(8);
        bitsPerSample = fmtBuffer.readUInt16LE(14);
      }

      if (chunkId === "data") {
        dataSize = chunkSize;
        if (sampleRate > 0 && channelCount > 0) {
          break;
        }
      }

      cursor += chunkSize + (chunkSize % 2);
    }

    if (
      sampleRate <= 0 ||
      channelCount <= 0 ||
      byteRate <= 0 ||
      bitsPerSample <= 0 ||
      dataSize <= 0
    ) {
      throw new Error(`Incomplete WAV metadata: ${filePath}`);
    }

    return {
      sampleRate,
      channelCount,
      durationSec: dataSize / byteRate,
      bitsPerSample,
    };
  } finally {
    await handle.close();
  }
}

export async function readWavPcmAudio(filePath: string): Promise<WavPcmAudio> {
  const handle = await open(filePath, "r");

  try {
    const riffHeader = Buffer.alloc(12);
    await handle.read(riffHeader, 0, riffHeader.length, 0);

    if (
      readAscii(riffHeader, 0, 4) !== "RIFF" ||
      readAscii(riffHeader, 8, 12) !== "WAVE"
    ) {
      throw unsupportedPcmWav(filePath);
    }

    let cursor = 12;
    let audioFormat = 0;
    let sampleRate = 0;
    let channelCount = 0;
    let bitsPerSample = 0;
    let dataOffset = -1;
    let dataSize = 0;

    while (true) {
      const header = Buffer.alloc(8);
      const { bytesRead } = await handle.read(header, 0, header.length, cursor);
      if (bytesRead < 8) {
        break;
      }

      const chunkId = readAscii(header, 0, 4);
      const chunkSize = header.readUInt32LE(4);
      cursor += 8;

      if (chunkId === "fmt ") {
        const fmtBuffer = Buffer.alloc(Math.min(chunkSize, 32));
        await handle.read(fmtBuffer, 0, fmtBuffer.length, cursor);
        audioFormat = fmtBuffer.readUInt16LE(0);
        channelCount = fmtBuffer.readUInt16LE(2);
        sampleRate = fmtBuffer.readUInt32LE(4);
        bitsPerSample = fmtBuffer.readUInt16LE(14);
      }

      if (chunkId === "data") {
        dataOffset = cursor;
        dataSize = chunkSize;
      }

      cursor += chunkSize + (chunkSize % 2);
    }

    if (
      audioFormat !== 1 ||
      sampleRate <= 0 ||
      channelCount <= 0 ||
      bitsPerSample !== 16 ||
      dataOffset < 0 ||
      dataSize <= 0
    ) {
      throw unsupportedPcmWav(filePath);
    }

    const pcm = Buffer.alloc(dataSize);
    await handle.read(pcm, 0, pcm.length, dataOffset);

    return {
      sampleRate,
      channelCount,
      bitsPerSample,
      pcm,
    };
  } finally {
    await handle.close();
  }
}

export function createPcmWavBuffer(
  pcm: Buffer,
  sampleRate: number,
  channelCount: number,
): Buffer {
  const bitsPerSample = 16;
  const blockAlign = channelCount * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channelCount, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}
