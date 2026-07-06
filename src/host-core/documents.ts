import path from "node:path";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

import {
  parseAuditionAnnotationText,
  serializeAuditionText,
} from "../shared/audition";
import {
  hydrateAnnotationSegments,
  parseAnnotationDocument,
  type LabelauAnnotationDocument,
} from "../shared/annotations";
import {
  parseTextGridAnnotationText,
  serializeTextGrid,
} from "../shared/textgrid";
import type {
  AnnotationSegment,
  LoadedAudioDocument,
  SaveAnnotationRequest,
  SaveAnnotationResult,
} from "../shared/contracts";

import { readAudioMetadata } from "./audio";

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

export function deriveAnnotationPath(audioPath: string): string {
  const extension = path.extname(audioPath);
  return audioPath.slice(0, audioPath.length - extension.length) + ".labelau.json";
}

export function deriveTextGridPath(audioPath: string): string {
  const extension = path.extname(audioPath);
  return audioPath.slice(0, audioPath.length - extension.length) + ".TextGrid";
}

async function readAnnotationSegments(
  annotationPath: string,
  csvPath: string,
  textGridPath: string,
): Promise<{
  segments: AnnotationSegment[];
  annotationPath: string | null;
  csvPath: string | null;
  textGridPath: string | null;
}> {
  if (await fileExists(annotationPath)) {
    const parsed = parseAnnotationDocument(
      JSON.parse(await readFile(annotationPath, "utf8")) as unknown,
    );
    return {
      segments: parsed.segments,
      annotationPath,
      csvPath: (await fileExists(csvPath)) ? csvPath : null,
      textGridPath: (await fileExists(textGridPath)) ? textGridPath : null,
    };
  }

  if (await fileExists(textGridPath)) {
    return {
      segments: parseTextGridAnnotationText(await readFile(textGridPath, "utf8")),
      annotationPath: null,
      csvPath: (await fileExists(csvPath)) ? csvPath : null,
      textGridPath,
    };
  }

  if (await fileExists(csvPath)) {
    return {
      segments: parseAuditionAnnotationText(await readFile(csvPath, "utf8")),
      annotationPath: null,
      csvPath,
      textGridPath: null,
    };
  }

  return {
    segments: [],
    annotationPath: null,
    csvPath: null,
    textGridPath: null,
  };
}

export async function loadDocument(
  audioPath: string,
  resolveAudioUrl: (audioPath: string) => string,
): Promise<LoadedAudioDocument> {
  const audioMeta = await readAudioMetadata(audioPath);
  const csvPath = deriveCsvPath(audioPath);
  const annotationPath = deriveAnnotationPath(audioPath);
  const textGridPath = deriveTextGridPath(audioPath);
  const annotation = await readAnnotationSegments(
    annotationPath,
    csvPath,
    textGridPath,
  );

  return {
    audioPath,
    csvPath: annotation.csvPath,
    annotationPath: annotation.annotationPath,
    textGridPath: annotation.textGridPath,
    stem: path.basename(audioPath, path.extname(audioPath)),
    audioMeta,
    sampleRate: audioMeta.sampleRate,
    channelCount: audioMeta.channelCount,
    durationSec: audioMeta.durationSec,
    channelLabels: Array.from(
      { length: audioMeta.channelCount },
      (_, index) => `Ch ${index + 1}`,
    ),
    segments: annotation.segments,
    audioUrl: resolveAudioUrl(audioPath),
  };
}

export async function saveAnnotation(
  request: SaveAnnotationRequest,
): Promise<SaveAnnotationResult> {
  const csvPath = request.csvPath ?? deriveCsvPath(request.audioPath);
  const annotationPath =
    request.annotationPath ?? deriveAnnotationPath(request.audioPath);
  const textGridPath = request.textGridPath ?? deriveTextGridPath(request.audioPath);
  const segments = hydrateAnnotationSegments(request.segments);
  const annotationDocument: LabelauAnnotationDocument = {
    version: 1,
    segments,
  };
  const audioMeta = await readAudioMetadata(request.audioPath);

  await mkdir(path.dirname(csvPath), { recursive: true });
  await mkdir(path.dirname(annotationPath), { recursive: true });
  await mkdir(path.dirname(textGridPath), { recursive: true });
  const text = serializeAuditionText(segments);
  await writeFile(csvPath, text, "utf8");
  await writeFile(
    annotationPath,
    `${JSON.stringify(annotationDocument, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    textGridPath,
    serializeTextGrid(segments, audioMeta.durationSec),
    "utf8",
  );
  return { csvPath, annotationPath, textGridPath };
}
