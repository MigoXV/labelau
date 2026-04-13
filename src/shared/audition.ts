import type { VadSegment } from "./contracts";
import { normalizeSegments } from "./vad";

const AUDITION_COLUMNS = [
  "Name",
  "Start",
  "Duration",
  "Time Format",
  "Type",
  "Description",
] as const;

function parseTable(text: string): { header: string[]; rows: string[][] } {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return { header: [...AUDITION_COLUMNS], rows: [] };
  }

  const separator = lines[0].includes("\t") ? "\t" : ",";
  const header = lines[0].split(separator).map((cell) => cell.trim());
  const rows = lines.slice(1).map((line) => line.split(separator));
  return { header, rows };
}

function columnIndex(header: string[], name: string): number {
  const index = header.findIndex((column) => column === name);
  if (index === -1) {
    throw new Error(`Missing Audition column: ${name}`);
  }
  return index;
}

export function secondsToAuditionTime(secondsValue: number): string {
  const hours = Math.floor(secondsValue / 3600);
  const remainderAfterHours = secondsValue % 3600;
  const minutes = Math.floor(remainderAfterHours / 60);
  const remainderAfterMinutes = remainderAfterHours % 60;
  const seconds = Math.floor(remainderAfterMinutes);
  const milliseconds = Math.round((remainderAfterMinutes - seconds) * 1000);

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

export function auditionTimeToSeconds(value: string): number {
  const parts = value.split(":");
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  }

  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return Number(minutes) * 60 + Number(seconds);
  }

  throw new Error(`Invalid Audition time: ${value}`);
}

export function parseAuditionText(text: string): VadSegment[] {
  const { header, rows } = parseTable(text);
  const startIndex = columnIndex(header, "Start");
  const durationIndex = columnIndex(header, "Duration");

  return normalizeSegments(
    rows.map((row) => {
      const startSec = auditionTimeToSeconds(row[startIndex] ?? "0:00.000");
      const durationSec = auditionTimeToSeconds(
        row[durationIndex] ?? "0:00.000",
      );

      return {
        startSec,
        endSec: startSec + durationSec,
      };
    }),
  );
}

export function serializeAuditionText(segments: VadSegment[]): string {
  const lines = [AUDITION_COLUMNS.join("\t")];
  const normalized = normalizeSegments(segments);

  normalized.forEach((segment, index) => {
    const duration = segment.endSec - segment.startSec;
    lines.push(
      [
        String(index),
        secondsToAuditionTime(segment.startSec),
        secondsToAuditionTime(duration),
        "decimal",
        "Cue",
        "",
      ].join("\t"),
    );
  });

  return `${lines.join("\n")}\n`;
}
