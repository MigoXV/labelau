import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

import { serializeTextGrid } from "../shared/textgrid";
import { exportAudioFolderArchive } from "./audiofolder-export";

const cleanupPaths: string[] = [];

async function loadArchive(zipPath: string) {
  return JSZip.loadAsync(await readFile(zipPath));
}

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((targetPath) =>
      rm(targetPath, { recursive: true, force: true }),
    ),
  );
});

describe("exportAudioFolderArchive", () => {
  it("exports only annotated audio files into the test split", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "labelau-audiofolder-"));
    cleanupPaths.push(root);

    await writeFile(path.join(root, "alpha.wav"), Buffer.from("wav"));
    await writeFile(
      path.join(root, "alpha.csv"),
      "Name\tStart\tDuration\tTime Format\tType\tDescription\n0\t0:00.500\t0:00.250\tdecimal\tCue\t\n",
      "utf8",
    );
    await writeFile(path.join(root, "beta.mp3"), Buffer.from("mp3"));

    const result = await exportAudioFolderArchive({
      rootPath: root,
      audioPaths: [path.join(root, "alpha.wav"), path.join(root, "beta.mp3")],
      splitName: "test",
    });
    cleanupPaths.push(path.dirname(result.zipPath));

    expect(result.exportedCount).toBe(1);

    const archive = await loadArchive(result.zipPath);
    const fileEntries = Object.keys(archive.files).filter(
      (name) => !archive.files[name]?.dir,
    );
    expect(fileEntries).toEqual(["test/alpha.wav", "test/metadata.jsonl"]);

    const metadataText = await archive.file("test/metadata.jsonl")?.async("string");
    expect(metadataText?.trim()).toBe(
      JSON.stringify({
        file_name: "alpha.wav",
        id: "alpha",
        seconds: {
          starts: [0.5],
          durations: [0.25],
        },
        transcripts: [""],
        segments: [
          {
            start: 0.5,
            end: 0.75,
            duration: 0.25,
            text: "",
          },
        ],
      }),
    );
  });

  it("creates unique zip file names for duplicate stems", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "labelau-audiofolder-"));
    cleanupPaths.push(root);
    await mkdir(path.join(root, "nested"), { recursive: true });

    await writeFile(path.join(root, "dup.wav"), Buffer.from("root"));
    await writeFile(
      path.join(root, "dup.csv"),
      "Name\tStart\tDuration\tTime Format\tType\tDescription\n0\t0:00.000\t0:00.100\tdecimal\tCue\t\n",
      "utf8",
    );
    await writeFile(path.join(root, "nested", "dup.wav"), Buffer.from("nested"));
    await writeFile(
      path.join(root, "nested", "dup.csv"),
      "Name\tStart\tDuration\tTime Format\tType\tDescription\n0\t0:00.250\t0:00.100\tdecimal\tCue\t\n",
      "utf8",
    );

    const result = await exportAudioFolderArchive({
      rootPath: root,
      audioPaths: [path.join(root, "dup.wav"), path.join(root, "nested", "dup.wav")],
      splitName: "test",
    });
    cleanupPaths.push(path.dirname(result.zipPath));

    const archive = await loadArchive(result.zipPath);
    const metadataText = await archive.file("test/metadata.jsonl")?.async("string");
    const lines = (metadataText ?? "").trim().split("\n").map((line) => JSON.parse(line));

    expect(result.exportedCount).toBe(2);
    expect(lines.map((line: { file_name: string }) => line.file_name).sort()).toEqual([
      "dup.wav",
      "nested__dup.wav",
    ]);
    expect(archive.file("test/dup.wav")).toBeTruthy();
    expect(archive.file("test/nested__dup.wav")).toBeTruthy();
  });

  it("exports audio files annotated only by TextGrid", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "labelau-audiofolder-"));
    cleanupPaths.push(root);

    await writeFile(path.join(root, "alpha.wav"), Buffer.from("wav"));
    await writeFile(
      path.join(root, "alpha.TextGrid"),
      serializeTextGrid(
        [{ startSec: 0.2, endSec: 0.6, transcript: "hello" }],
        1,
      ),
      "utf8",
    );

    const result = await exportAudioFolderArchive({
      rootPath: root,
      audioPaths: [path.join(root, "alpha.wav")],
      splitName: "test",
    });
    cleanupPaths.push(path.dirname(result.zipPath));

    const archive = await loadArchive(result.zipPath);
    const metadataText = await archive.file("test/metadata.jsonl")?.async("string");
    const metadata = JSON.parse(metadataText?.trim() ?? "{}") as {
      file_name: string;
      transcripts: string[];
      segments: Array<{
        start: number;
        end: number;
        duration: number;
        text: string;
      }>;
    };
    expect(result.exportedCount).toBe(1);
    expect(metadata).toMatchObject({
      file_name: "alpha.wav",
      transcripts: ["hello"],
      segments: [
        {
          start: 0.2,
          end: 0.6,
          text: "hello",
        },
      ],
    });
    expect(metadata.segments[0]?.duration).toBeCloseTo(0.4, 6);
  });

  it("rejects audio paths outside the root path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "labelau-audiofolder-"));
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "labelau-outside-"));
    cleanupPaths.push(root, outsideRoot);

    await writeFile(path.join(outsideRoot, "rogue.wav"), Buffer.from("rogue"));
    await writeFile(
      path.join(outsideRoot, "rogue.csv"),
      "Name\tStart\tDuration\tTime Format\tType\tDescription\n0\t0:00.000\t0:00.100\tdecimal\tCue\t\n",
      "utf8",
    );

    await expect(
      exportAudioFolderArchive({
        rootPath: root,
        audioPaths: [path.join(outsideRoot, "rogue.wav")],
        splitName: "test",
      }),
    ).rejects.toThrow("导出文件超出根目录范围");
  });

  it("fails when no annotated audio files are exportable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "labelau-audiofolder-"));
    cleanupPaths.push(root);

    await writeFile(path.join(root, "empty.wav"), Buffer.from("wav"));

    await expect(
      exportAudioFolderArchive({
        rootPath: root,
        audioPaths: [path.join(root, "empty.wav")],
        splitName: "test",
      }),
    ).rejects.toThrow("当前目录没有可导出的已标注音频");
  });
});
