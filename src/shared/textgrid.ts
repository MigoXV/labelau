import { hydrateAnnotationSegments } from "./annotations";
import type { AnnotationSegment } from "./contracts";

const DEFAULT_TIER_NAME = "transcript";
const EPSILON = 1e-9;

interface TextGridInterval {
  startSec: number;
  endSec: number;
  text: string;
}

interface ParsedTier {
  name: string;
  intervals: TextGridInterval[];
}

function formatPraatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }

  return String(Number(value.toFixed(6)));
}

function escapePraatText(value: string): string {
  return value.replaceAll('"', '""');
}

function formatPraatText(value: string): string {
  return `"${escapePraatText(value)}"`;
}

function parsePraatQuotedValue(line: string): string | null {
  const start = line.indexOf('"');
  if (start < 0) {
    return null;
  }

  let text = "";
  for (let index = start + 1; index < line.length; index += 1) {
    const char = line[index];
    if (char !== '"') {
      text += char;
      continue;
    }

    if (line[index + 1] === '"') {
      text += '"';
      index += 1;
      continue;
    }

    return text;
  }

  return null;
}

function readPraatQuotedLine(lines: string[], startIndex: number): {
  value: string;
  nextIndex: number;
} | null {
  const firstLine = lines[startIndex];
  if (firstLine === undefined) {
    return null;
  }

  let buffer = firstLine;
  let index = startIndex;
  while (parsePraatQuotedValue(buffer) === null && index + 1 < lines.length) {
    index += 1;
    buffer += `\n${lines[index] ?? ""}`;
  }

  const value = parsePraatQuotedValue(buffer);
  if (value === null) {
    return null;
  }

  return { value, nextIndex: index + 1 };
}

function parseNumberLine(line: string): number | null {
  const match = line.match(/=\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/i);
  if (!match) {
    return null;
  }

  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function buildIntervals(
  segments: AnnotationSegment[],
  maxTime: number,
): TextGridInterval[] {
  const intervals: TextGridInterval[] = [];
  let cursor = 0;

  hydrateAnnotationSegments(segments).forEach((segment) => {
    const startSec = Math.max(0, segment.startSec);
    const endSec = Math.max(startSec, segment.endSec);
    if (endSec <= startSec + EPSILON) {
      return;
    }

    if (startSec > cursor + EPSILON) {
      intervals.push({
        startSec: cursor,
        endSec: startSec,
        text: "",
      });
    }

    intervals.push({
      startSec,
      endSec,
      text: segment.transcript ?? "",
    });
    cursor = Math.max(cursor, endSec);
  });

  if (maxTime > cursor + EPSILON) {
    intervals.push({
      startSec: cursor,
      endSec: maxTime,
      text: "",
    });
  }

  return intervals;
}

export function serializeTextGrid(
  segments: AnnotationSegment[],
  durationSec: number,
  tierName = DEFAULT_TIER_NAME,
): string {
  const normalized = hydrateAnnotationSegments(segments);
  const maxSegmentEnd = normalized.reduce(
    (maxValue, segment) => Math.max(maxValue, segment.endSec),
    0,
  );
  const maxTime = Math.max(0, durationSec, maxSegmentEnd);
  const intervals = buildIntervals(normalized, maxTime);
  const lines = [
    'File type = "ooTextFile"',
    'Object class = "TextGrid"',
    "",
    "xmin = 0",
    `xmax = ${formatPraatNumber(maxTime)}`,
    "tiers? <exists>",
    "size = 1",
    "item []:",
    "\titem [1]:",
    '\t\tclass = "IntervalTier"',
    `\t\tname = ${formatPraatText(tierName)}`,
    "\t\txmin = 0",
    `\t\txmax = ${formatPraatNumber(maxTime)}`,
    `\t\tintervals: size = ${intervals.length}`,
  ];

  intervals.forEach((interval, index) => {
    lines.push(
      `\t\t\tintervals [${index + 1}]:`,
      `\t\t\t\txmin = ${formatPraatNumber(interval.startSec)}`,
      `\t\t\t\txmax = ${formatPraatNumber(interval.endSec)}`,
      `\t\t\t\ttext = ${formatPraatText(interval.text)}`,
    );
  });

  return `${lines.join("\n")}\n`;
}

function parseLongTextGrid(text: string): ParsedTier[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const tiers: ParsedTier[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!/class\s*=\s*"IntervalTier"/.test(line)) {
      index += 1;
      continue;
    }

    let tierName = "";
    const intervals: TextGridInterval[] = [];
    index += 1;

    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (/^\s*item\s*\[\d+\]\s*:/.test(current)) {
        break;
      }

      if (/name\s*=/.test(current)) {
        tierName = parsePraatQuotedValue(current) ?? "";
        index += 1;
        continue;
      }

      if (!/intervals\s*\[\d+\]\s*:/.test(current)) {
        index += 1;
        continue;
      }

      const xmin = parseNumberLine(lines[index + 1] ?? "");
      const xmax = parseNumberLine(lines[index + 2] ?? "");
      const textLine = readPraatQuotedLine(lines, index + 3);
      if (xmin !== null && xmax !== null && textLine) {
        intervals.push({
          startSec: xmin,
          endSec: xmax,
          text: textLine.value,
        });
        index = textLine.nextIndex;
        continue;
      }

      index += 1;
    }

    tiers.push({ name: tierName, intervals });
  }

  return tiers;
}

export function parseTextGridAnnotationText(
  text: string,
  tierName = DEFAULT_TIER_NAME,
): AnnotationSegment[] {
  const tiers = parseLongTextGrid(text);
  const tier =
    tiers.find((candidate) => candidate.name === tierName) ?? tiers[0] ?? null;
  if (!tier) {
    return [];
  }

  return hydrateAnnotationSegments(
    tier.intervals
      .filter(
        (interval) =>
          interval.endSec > interval.startSec + EPSILON &&
          interval.text.trim().length > 0,
      )
      .map((interval, index) => ({
        id: `textgrid_${index}`,
        startSec: interval.startSec,
        endSec: interval.endSec,
        transcript: interval.text,
      })),
  );
}
