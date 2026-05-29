import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import JSZip from "jszip";

import { parseAuditionText } from "../shared/audition";
import type { ExportAudioFolderRequest, VadSegment } from "../shared/contracts";

import { deriveCsvPath, fileExists } from "./documents";

export interface ExportedAudioFolderArchive {
  exportedCount: number;
  fileName: string;
  zipPath: string;
}

interface ExportableAudioSample {
  audioPath: string;
  extension: string;
  fileName: string;
  id: string;
  segments: VadSegment[];
}

function assertWithinRoot(rootPath: string, targetPath: string): void {
  const relativePath = path.relative(rootPath, targetPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`导出文件超出根目录范围：${targetPath}`);
  }
}

function formatTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function sanitizeFilePart(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeSegmentsForMetadata(segments: VadSegment[]) {
  return {
    starts: segments.map((segment) => segment.startSec),
    durations: segments.map((segment) => segment.endSec - segment.startSec),
  };
}

function resolveAudioFileName(
  rootPath: string,
  audioPath: string,
  duplicateStems: ReadonlySet<string>,
): string {
  const extension = path.extname(audioPath);
  const stem = path.basename(audioPath, extension);
  if (!duplicateStems.has(stem)) {
    return `${stem}${extension}`;
  }

  const relativePath = path.relative(rootPath, audioPath);
  const relativeWithoutExtension = relativePath.slice(
    0,
    relativePath.length - extension.length,
  );
  const normalized = sanitizeFilePart(relativeWithoutExtension.replaceAll(path.sep, "__"));
  return `${normalized || stem}${extension}`;
}

async function collectExportableSamples(
  rootPath: string,
  audioPaths: string[],
): Promise<ExportableAudioSample[]> {
  const stemCounts = new Map<string, number>();
  for (const audioPath of audioPaths) {
    const stem = path.basename(audioPath, path.extname(audioPath));
    stemCounts.set(stem, (stemCounts.get(stem) ?? 0) + 1);
  }
  const duplicateStems = new Set(
    Array.from(stemCounts.entries())
      .filter(([, count]) => count > 1)
      .map(([stem]) => stem),
  );

  const samples: ExportableAudioSample[] = [];
  for (const audioPath of audioPaths) {
    const resolvedAudioPath = path.resolve(audioPath);
    assertWithinRoot(rootPath, resolvedAudioPath);

    const csvPath = deriveCsvPath(resolvedAudioPath);
    if (!(await fileExists(csvPath))) {
      continue;
    }

    const segments = parseAuditionText(await readFile(csvPath, "utf8"));
    if (segments.length === 0) {
      continue;
    }

    const extension = path.extname(resolvedAudioPath);
    const stem = path.basename(resolvedAudioPath, extension);
    samples.push({
      audioPath: resolvedAudioPath,
      extension,
      fileName: resolveAudioFileName(rootPath, resolvedAudioPath, duplicateStems),
      id: stem,
      segments,
    });
  }

  return samples;
}

export function buildAudioFolderArchiveName(rootPath: string, splitName: string): string {
  const rootName = sanitizeFilePart(path.basename(rootPath)) || "labelau";
  return `${rootName}-audiofolder-${splitName}-${formatTimestamp(new Date())}.zip`;
}

export async function exportAudioFolderArchive(
  request: ExportAudioFolderRequest,
): Promise<ExportedAudioFolderArchive> {
  const rootPath = path.resolve(request.rootPath);
  const splitName = request.splitName;
  const candidateAudioPaths = (request.audioPaths ?? []).map((audioPath) =>
    path.resolve(audioPath),
  );
  const samples = await collectExportableSamples(rootPath, candidateAudioPaths);

  if (samples.length === 0) {
    throw new Error("当前目录没有可导出的已标注音频");
  }

  const zip = new JSZip();
  const metadataLines: string[] = [];

  for (const sample of samples) {
    const audioBuffer = await readFile(sample.audioPath);
    zip.file(`${splitName}/${sample.fileName}`, audioBuffer);
    metadataLines.push(
      JSON.stringify({
        file_name: sample.fileName,
        id: sample.id,
        seconds: normalizeSegmentsForMetadata(sample.segments),
      }),
    );
  }

  zip.file(`${splitName}/metadata.jsonl`, `${metadataLines.join("\n")}\n`);

  const tempRoot = await mkdtemp(path.join(tmpdir(), "labelau-audiofolder-"));
  const fileName = buildAudioFolderArchiveName(rootPath, splitName);
  const zipPath = path.join(tempRoot, fileName);
  const zipBuffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  await writeFile(zipPath, zipBuffer);

  return {
    exportedCount: samples.length,
    fileName,
    zipPath,
  };
}

export async function cleanupExportedArchive(zipPath: string): Promise<void> {
  await rm(path.dirname(zipPath), { recursive: true, force: true });
}
