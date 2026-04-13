import path from "node:path";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

import { parseAuditionText, serializeAuditionText } from "../shared/audition";
import type {
  LoadedAudioDocument,
  SaveAnnotationRequest,
  SaveAnnotationResult,
} from "../shared/contracts";
import { normalizeSegments } from "../shared/vad";

import { readWavMetadata } from "./wav";

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function deriveCsvPath(audioPath: string): string {
  const extension = path.extname(audioPath);
  return audioPath.slice(0, audioPath.length - extension.length) + ".csv";
}

export async function loadDocument(
  audioPath: string,
  resolveAudioUrl: (audioPath: string) => string,
): Promise<LoadedAudioDocument> {
  const audioMeta = await readWavMetadata(audioPath);
  const csvPath = deriveCsvPath(audioPath);
  const hasCsv = await fileExists(csvPath);
  const segments = hasCsv
    ? parseAuditionText(await readFile(csvPath, "utf8"))
    : [];

  return {
    audioPath,
    csvPath: hasCsv ? csvPath : null,
    stem: path.basename(audioPath, path.extname(audioPath)),
    audioMeta,
    sampleRate: audioMeta.sampleRate,
    channelCount: audioMeta.channelCount,
    durationSec: audioMeta.durationSec,
    channelLabels: Array.from(
      { length: audioMeta.channelCount },
      (_, index) => `Ch ${index + 1}`,
    ),
    segments,
    audioUrl: resolveAudioUrl(audioPath),
  };
}

export async function saveAnnotation(
  request: SaveAnnotationRequest,
): Promise<SaveAnnotationResult> {
  const csvPath = request.csvPath ?? deriveCsvPath(request.audioPath);
  await mkdir(path.dirname(csvPath), { recursive: true });
  const text = serializeAuditionText(normalizeSegments(request.segments));
  await writeFile(csvPath, text, "utf8");
  return { csvPath };
}
