import type { VadSegment } from "./contracts";

const EPSILON = 1e-9;

export function normalizeSegment(segment: VadSegment): VadSegment | null {
  const startSec = Math.min(segment.startSec, segment.endSec);
  const endSec = Math.max(segment.startSec, segment.endSec);
  if (endSec - startSec <= EPSILON) {
    return null;
  }

  return { startSec, endSec };
}

export function normalizeSegments(segments: VadSegment[]): VadSegment[] {
  const normalized = segments
    .map(normalizeSegment)
    .filter((segment): segment is VadSegment => Boolean(segment))
    .sort((left, right) => left.startSec - right.startSec);

  const result: VadSegment[] = [];

  for (const segment of normalized) {
    const previous = result.at(-1);
    if (!previous || segment.startSec > previous.endSec + EPSILON) {
      result.push({ ...segment });
      continue;
    }

    previous.endSec = Math.max(previous.endSec, segment.endSec);
  }

  return result;
}

export function addSegment(
  segments: VadSegment[],
  draftSegment: VadSegment,
): VadSegment[] {
  const normalized = normalizeSegment(draftSegment);
  if (!normalized) {
    return normalizeSegments(segments);
  }

  return normalizeSegments([...segments, normalized]);
}

export function eraseSegment(
  segments: VadSegment[],
  draftSegment: VadSegment,
): VadSegment[] {
  const normalized = normalizeSegment(draftSegment);
  if (!normalized) {
    return normalizeSegments(segments);
  }

  const result: VadSegment[] = [];

  for (const segment of normalizeSegments(segments)) {
    if (
      normalized.endSec <= segment.startSec + EPSILON ||
      normalized.startSec >= segment.endSec - EPSILON
    ) {
      result.push(segment);
      continue;
    }

    if (normalized.startSec > segment.startSec + EPSILON) {
      result.push({
        startSec: segment.startSec,
        endSec: normalized.startSec,
      });
    }

    if (normalized.endSec < segment.endSec - EPSILON) {
      result.push({
        startSec: normalized.endSec,
        endSec: segment.endSec,
      });
    }
  }

  return normalizeSegments(result);
}

export function replaceSegment(
  segments: VadSegment[],
  index: number,
  draftSegment: VadSegment,
): VadSegment[] {
  if (index < 0 || index >= segments.length) {
    return normalizeSegments(segments);
  }

  const normalized = normalizeSegment(draftSegment);
  const nextSegments = segments.filter((_, currentIndex) => currentIndex !== index);
  if (!normalized) {
    return normalizeSegments(nextSegments);
  }

  return normalizeSegments([...nextSegments, normalized]);
}
