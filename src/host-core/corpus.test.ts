import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { scanCorpus } from "./corpus";

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

afterEach(async () => {
  await Promise.all(testRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("scanCorpus", () => {
  it("pairs wav and csv in the same directory and ignores csv-only files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "labelau-corpus-"));
    testRoots.push(root);

    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "alpha.wav"), createWaveFile());
    await writeFile(
      path.join(root, "alpha.csv"),
      "Name\tStart\tDuration\tTime Format\tType\tDescription\n0\t0:00.000\t0:01.000\tdecimal\tCue\t\n",
    );
    await writeFile(path.join(root, "beta.wav"), createWaveFile(2));
    await writeFile(path.join(root, "nested", "gamma.csv"), "placeholder");
    await writeFile(path.join(root, "notes.txt"), "plain text");

    const result = await scanCorpus(root);
    const tree = result.tree;
    const rootEntries = tree.entries;

    expect(rootEntries).toHaveLength(2);
    expect(rootEntries[0]?.stem).toBe("alpha");
    expect(rootEntries[0]?.hasAnnotation).toBe(true);
    expect(rootEntries[1]?.stem).toBe("beta");
    expect(rootEntries[1]?.hasAnnotation).toBe(false);
    expect(tree.directories).toHaveLength(0);
    expect(result.warnings).toEqual([]);
  });

  it("skips unsupported wav files and keeps valid entries visible", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "labelau-corpus-"));
    testRoots.push(root);

    await writeFile(path.join(root, "alpha.wav"), createWaveFile());
    await writeFile(path.join(root, "broken.wav"), "not a wav");

    const result = await scanCorpus(root);

    expect(result.tree.entries).toHaveLength(1);
    expect(result.tree.entries[0]?.stem).toBe("alpha");
    expect(result.warnings).toEqual([
      {
        audioPath: path.join(root, "broken.wav"),
        stem: "broken",
        reason: "不支持的 WAV 文件",
      },
    ]);
  });

  it("returns an empty tree with warnings when all wav files are invalid", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "labelau-corpus-"));
    testRoots.push(root);

    await writeFile(path.join(root, "broken.wav"), "not a wav");

    const result = await scanCorpus(root);

    expect(result.tree.entries).toEqual([]);
    expect(result.tree.directories).toEqual([]);
    expect(result.warnings).toEqual([
      {
        audioPath: path.join(root, "broken.wav"),
        stem: "broken",
        reason: "不支持的 WAV 文件",
      },
    ]);
  });

  it("only skips invalid wav files in nested directories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "labelau-corpus-"));
    testRoots.push(root);

    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "alpha.wav"), createWaveFile());
    await writeFile(path.join(root, "nested", "broken.wav"), "not a wav");
    await writeFile(path.join(root, "nested", "gamma.wav"), createWaveFile(0.5));

    const result = await scanCorpus(root);

    expect(result.tree.entries).toHaveLength(1);
    expect(result.tree.entries[0]?.stem).toBe("alpha");
    expect(result.tree.directories).toHaveLength(1);
    expect(result.tree.directories[0]?.entries).toHaveLength(1);
    expect(result.tree.directories[0]?.entries[0]?.stem).toBe("gamma");
    expect(result.warnings).toEqual([
      {
        audioPath: path.join(root, "nested", "broken.wav"),
        stem: "broken",
        reason: "不支持的 WAV 文件",
      },
    ]);
  });
});
