import { open } from "node:fs/promises";

import type { AudioMeta } from "../shared/contracts";

function readAscii(buffer: Buffer, start: number, end: number): string {
  return buffer.toString("ascii", start, end);
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
