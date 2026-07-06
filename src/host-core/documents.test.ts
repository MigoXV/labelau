import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { parseAuditionText } from "../shared/audition";
import { serializeTextGrid } from "../shared/textgrid";
import { loadDocument, saveAnnotation } from "./documents";

const testRoots: string[] = [];

function createWaveFile(durationSec = 1, sampleRate = 16000): Buffer {
  const channelCount = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channelCount * (bitsPerSample / 8);
  const blockAlign = channelCount * (bitsPerSample / 8);
  const dataSize = Math.floor(durationSec * byteRate);
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channelCount, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}

function writeBits(buffer: Buffer, startBit: number, bitLength: number, value: number): void {
  for (let index = 0; index < bitLength; index += 1) {
    const bitValue = Math.floor(value / 2 ** (bitLength - index - 1)) & 1;
    const bitIndex = startBit + index;
    const byteIndex = Math.floor(bitIndex / 8);
    const shift = 7 - (bitIndex % 8);
    buffer[byteIndex] = (buffer[byteIndex] ?? 0) | (bitValue << shift);
  }
}

function createFlacFile(durationSec = 1, sampleRate = 16000): Buffer {
  const streamInfo = Buffer.alloc(34);
  writeBits(streamInfo, 80, 20, sampleRate);
  writeBits(streamInfo, 100, 3, 0);
  writeBits(streamInfo, 103, 5, 15);
  writeBits(streamInfo, 108, 36, Math.floor(durationSec * sampleRate));

  return Buffer.concat([
    Buffer.from("fLaC", "ascii"),
    Buffer.from([0x80, 0x00, 0x00, 0x22]),
    streamInfo,
  ]);
}

afterEach(async () => {
  await Promise.all(testRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("document service", () => {
  it("creates a sibling audition csv for wav-only files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "labelau-documents-"));
    testRoots.push(root);

    const audioPath = path.join(root, "sample.wav");
    await writeFile(audioPath, createWaveFile());

    const result = await saveAnnotation({
      audioPath,
      segments: [{ startSec: 0.2, endSec: 0.5 }],
    });

    expect(result.csvPath).toBe(path.join(root, "sample.csv"));
    expect(result.textGridPath).toBe(path.join(root, "sample.TextGrid"));
    const csvText = await readFile(result.csvPath, "utf8");
    expect(parseAuditionText(csvText)).toEqual([{ startSec: 0.2, endSec: 0.5 }]);
    const textGridText = await readFile(result.textGridPath ?? "", "utf8");
    expect(textGridText).toContain('Object class = "TextGrid"');
    expect(textGridText).toContain("xmin = 0.2");
    expect(textGridText).toContain("xmax = 0.5");
  });

  it("loads document metadata and existing segments", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "labelau-load-"));
    testRoots.push(root);

    const audioPath = path.join(root, "voice.wav");
    const csvPath = path.join(root, "voice.csv");
    await writeFile(audioPath, createWaveFile(2.5));
    await writeFile(
      csvPath,
      "Name\tStart\tDuration\tTime Format\tType\tDescription\n0\t0:00.500\t0:00.250\tdecimal\tCue\t\n",
    );

    const document = await loadDocument(audioPath, () => "memory://voice");

    expect(document.stem).toBe("voice");
    expect(document.csvPath).toBe(csvPath);
    expect(document.audioMeta.durationSec).toBeCloseTo(2.5, 3);
    expect(document.segments).toEqual([
      { id: "csv_0", startSec: 0.5, endSec: 0.75, transcript: "" },
    ]);
  });

  it("loads flac document metadata and existing segments", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "labelau-load-"));
    testRoots.push(root);

    const audioPath = path.join(root, "voice.flac");
    const csvPath = path.join(root, "voice.csv");
    await writeFile(audioPath, createFlacFile(1.25));
    await writeFile(
      csvPath,
      "Name\tStart\tDuration\tTime Format\tType\tDescription\n0\t0:00.100\t0:00.200\tdecimal\tCue\t\n",
    );

    const document = await loadDocument(audioPath, () => "memory://voice");

    expect(document.stem).toBe("voice");
    expect(document.csvPath).toBe(csvPath);
    expect(document.audioMeta.durationSec).toBeCloseTo(1.25, 3);
    expect(document.segments[0]?.startSec).toBeCloseTo(0.1, 3);
    expect(document.segments[0]?.endSec).toBeCloseTo(0.3, 3);
  });

  it("loads TextGrid annotations before sibling csv files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "labelau-textgrid-"));
    testRoots.push(root);

    const audioPath = path.join(root, "voice.wav");
    const csvPath = path.join(root, "voice.csv");
    const textGridPath = path.join(root, "voice.TextGrid");
    await writeFile(audioPath, createWaveFile(2));
    await writeFile(
      csvPath,
      "Name\tStart\tDuration\tTime Format\tType\tDescription\n0\t0:00.100\t0:00.100\tdecimal\tCue\tcsv\n",
    );
    await writeFile(
      textGridPath,
      serializeTextGrid([{ startSec: 0.4, endSec: 0.8, transcript: "textgrid" }], 2),
    );

    const document = await loadDocument(audioPath, () => "memory://voice");

    expect(document.csvPath).toBe(csvPath);
    expect(document.textGridPath).toBe(textGridPath);
    expect(document.segments).toEqual([
      {
        id: "textgrid_0",
        startSec: 0.4,
        endSec: 0.8,
        transcript: "textgrid",
      },
    ]);
  });
});
