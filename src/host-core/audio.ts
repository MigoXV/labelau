import path from "node:path";
import { open, stat } from "node:fs/promises";

import type { AudioMeta } from "../shared/contracts";
import { getAudioExtension } from "../shared/audio-format";

import { readWavMetadata } from "./wav";

const MPEG_BITRATES: Record<string, number[]> = {
  "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

const MPEG_SAMPLE_RATES: Record<number, number[]> = {
  1: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  2.5: [11025, 12000, 8000],
};

function unsupportedAudio(filePath: string): Error {
  return new Error(`Unsupported audio file: ${filePath}`);
}

function incompleteAudioMetadata(filePath: string): Error {
  return new Error(`Incomplete audio metadata: ${filePath}`);
}

function readBits(buffer: Buffer, startBit: number, bitLength: number): number {
  let value = 0;
  for (let index = 0; index < bitLength; index += 1) {
    const bitIndex = startBit + index;
    const byte = buffer[Math.floor(bitIndex / 8)] ?? 0;
    value = (value << 1) | ((byte >> (7 - (bitIndex % 8))) & 1);
  }

  return value;
}

async function readFlacMetadata(filePath: string): Promise<AudioMeta> {
  const handle = await open(filePath, "r");

  try {
    const marker = Buffer.alloc(4);
    await handle.read(marker, 0, marker.length, 0);
    if (marker.toString("ascii") !== "fLaC") {
      throw unsupportedAudio(filePath);
    }

    let cursor = 4;
    while (true) {
      const header = Buffer.alloc(4);
      const { bytesRead } = await handle.read(header, 0, header.length, cursor);
      if (bytesRead < header.length) {
        break;
      }

      const isLast = (header[0] & 0x80) !== 0;
      const blockType = header[0] & 0x7f;
      const blockSize = header.readUIntBE(1, 3);
      cursor += header.length;

      if (blockType === 0) {
        if (blockSize < 34) {
          throw incompleteAudioMetadata(filePath);
        }

        const streamInfo = Buffer.alloc(34);
        await handle.read(streamInfo, 0, streamInfo.length, cursor);
        const sampleRate = readBits(streamInfo, 80, 20);
        const channelCount = readBits(streamInfo, 100, 3) + 1;
        const bitsPerSample = readBits(streamInfo, 103, 5) + 1;
        const totalSamples =
          readBits(streamInfo, 108, 18) * 2 ** 18 + readBits(streamInfo, 126, 18);

        if (sampleRate <= 0 || channelCount <= 0) {
          throw incompleteAudioMetadata(filePath);
        }

        return {
          sampleRate,
          channelCount,
          durationSec: totalSamples / sampleRate,
          bitsPerSample,
        };
      }

      cursor += blockSize;
      if (isLast) {
        break;
      }
    }

    throw incompleteAudioMetadata(filePath);
  } finally {
    await handle.close();
  }
}

function readId3v2Size(header: Buffer): number {
  return (
    ((header[6] & 0x7f) << 21) |
    ((header[7] & 0x7f) << 14) |
    ((header[8] & 0x7f) << 7) |
    (header[9] & 0x7f)
  );
}

async function readMp3Metadata(filePath: string): Promise<AudioMeta> {
  const fileStat = await stat(filePath);
  const handle = await open(filePath, "r");

  try {
    const header = Buffer.alloc(10);
    await handle.read(header, 0, header.length, 0);
    let cursor = header.toString("ascii", 0, 3) === "ID3" ? 10 + readId3v2Size(header) : 0;

    const scanLimit = Math.min(fileStat.size, cursor + 64 * 1024);
    const frameHeader = Buffer.alloc(4);
    while (cursor + frameHeader.length <= scanLimit) {
      await handle.read(frameHeader, 0, frameHeader.length, cursor);
      const value = frameHeader.readUInt32BE(0);
      if (((value & 0xffe00000) >>> 0) !== 0xffe00000) {
        cursor += 1;
        continue;
      }

      const versionBits = (value >>> 19) & 0x03;
      const layerBits = (value >>> 17) & 0x03;
      const bitrateIndex = (value >>> 12) & 0x0f;
      const sampleRateIndex = (value >>> 10) & 0x03;
      const channelMode = (value >>> 6) & 0x03;

      const version = versionBits === 0x03 ? 1 : versionBits === 0x02 ? 2 : versionBits === 0x00 ? 2.5 : 0;
      const layer = layerBits === 0x03 ? 1 : layerBits === 0x02 ? 2 : layerBits === 0x01 ? 3 : 0;
      const sampleRate = MPEG_SAMPLE_RATES[version]?.[sampleRateIndex] ?? 0;
      const bitrateKbps = MPEG_BITRATES[`${version === 1 ? 1 : 2}-${layer}`]?.[bitrateIndex] ?? 0;

      if (version === 0 || layer === 0 || sampleRate <= 0 || bitrateKbps <= 0) {
        cursor += 1;
        continue;
      }

      const id3v1Header = Buffer.alloc(3);
      if (fileStat.size >= 128) {
        await handle.read(id3v1Header, 0, id3v1Header.length, fileStat.size - 128);
      }
      const id3v1Size = id3v1Header.toString("ascii") === "TAG" ? 128 : 0;
      const audioBytes = Math.max(fileStat.size - cursor - id3v1Size, 0);
      const durationSec = (audioBytes * 8) / (bitrateKbps * 1000);

      if (durationSec <= 0) {
        throw incompleteAudioMetadata(filePath);
      }

      return {
        sampleRate,
        channelCount: channelMode === 0x03 ? 1 : 2,
        durationSec,
        bitsPerSample: 0,
      };
    }

    throw unsupportedAudio(filePath);
  } finally {
    await handle.close();
  }
}

export async function readAudioMetadata(filePath: string): Promise<AudioMeta> {
  const extension = getAudioExtension(path.basename(filePath));
  if (extension === ".wav") {
    try {
      return await readWavMetadata(filePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.startsWith("Unsupported WAV file:")) {
        throw unsupportedAudio(filePath);
      }
      if (message.startsWith("Incomplete WAV metadata:")) {
        throw incompleteAudioMetadata(filePath);
      }
      throw error;
    }
  }

  if (extension === ".flac") {
    return readFlacMetadata(filePath);
  }

  if (extension === ".mp3") {
    return readMp3Metadata(filePath);
  }

  throw unsupportedAudio(filePath);
}
