import type { AnnotationSegment, VadSegment } from "./contracts";
import { normalizeSegments } from "./vad";

const EPSILON = 1e-9;

export interface LabelauAnnotationDocument {
  version: 1;
  segments: AnnotationSegment[];
}

export function createSegmentId(segment: VadSegment, index = 0): string {
  const start = Math.round(segment.startSec * 1000);
  const end = Math.round(segment.endSec * 1000);
  return `seg_${start}_${end}_${index}`;
}

export function hydrateAnnotationSegments(
  segments: AnnotationSegment[],
): AnnotationSegment[] {
  return normalizeSegments(segments).map((segment, index) => ({
    ...segment,
    id: segment.id?.trim() || createSegmentId(segment, index),
    transcript: segment.transcript ?? "",
  }));
}

export function cloneAnnotationSegments(
  segments: AnnotationSegment[],
): AnnotationSegment[] {
  return segments.map((segment) => ({ ...segment }));
}

export function annotationSegmentsEqual(
  leftSegments: AnnotationSegment[],
  rightSegments: AnnotationSegment[],
): boolean {
  if (leftSegments.length !== rightSegments.length) {
    return false;
  }

  return leftSegments.every((left, index) => {
    const right = rightSegments[index];
    return (
      Boolean(right) &&
      Math.abs(left.startSec - right.startSec) <= EPSILON &&
      Math.abs(left.endSec - right.endSec) <= EPSILON &&
      (left.transcript ?? "") === (right.transcript ?? "") &&
      (left.id ?? "") === (right.id ?? "")
    );
  });
}

export function assertNonOverlappingSegments(
  segments: AnnotationSegment[],
  label = "标注片段",
): void {
  const sorted = [...segments].sort((left, right) => left.startSec - right.startSec);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous && current && current.startSec < previous.endSec - EPSILON) {
      throw new Error(`${label}存在重叠，请检查第 ${index} 段附近的时间范围`);
    }
  }
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseAnnotationDocument(
  value: unknown,
): LabelauAnnotationDocument {
  if (!value || typeof value !== "object") {
    return { version: 1, segments: [] };
  }

  const rawSegments = Array.isArray((value as { segments?: unknown }).segments)
    ? (value as { segments: unknown[] }).segments
    : [];
  const segments: AnnotationSegment[] = [];

  rawSegments.forEach((rawSegment, index) => {
    if (!rawSegment || typeof rawSegment !== "object") {
      return;
    }
    const record = rawSegment as Record<string, unknown>;
    const startSec = readNumber(record.startSec);
    const endSec = readNumber(record.endSec);
    if (startSec === null || endSec === null) {
      return;
    }
    segments.push({
      id: typeof record.id === "string" ? record.id : createSegmentId({ startSec, endSec }, index),
      startSec,
      endSec,
      transcript: typeof record.transcript === "string" ? record.transcript : "",
    });
  });

  return {
    version: 1,
    segments: hydrateAnnotationSegments(segments),
  };
}

