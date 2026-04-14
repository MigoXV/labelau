/// <reference lib="webworker" />

import FFT from "fft.js";

import {
  MAX_SPECTROGRAM_CACHE_ENTRIES,
  SPECTROGRAM_FFT_SIZE,
  SPECTROGRAM_WINDOW_SIZE,
} from "../shared/constants";
import type { FrequencyScale } from "../shared/contracts";
import { clamp, lerp } from "../shared/math";
import type { SystemThemeMode } from "../renderer/theme";

interface WorkerDocument {
  channelData: Int8Array[];
  sampleRate: number;
}

type IncomingMessage =
  | {
      kind: "load-document";
      documentId: string;
      channelData: Int8Array[];
      sampleRate: number;
    }
  | {
      kind: "unload-document";
      documentId: string;
    }
  | {
      kind: "render";
      requestId: number;
      documentId: string;
      channelIndex: number;
      width: number;
      height: number;
      startSec: number;
      endSec: number;
      minFreq: number;
      maxFreq: number;
      frequencyScale: FrequencyScale;
      themeMode: SystemThemeMode;
    };

const documents = new Map<string, WorkerDocument>();
const cache = new Map<string, Uint8ClampedArray>();
const fft = new FFT(SPECTROGRAM_FFT_SIZE);
const hannWindow = new Float32Array(SPECTROGRAM_WINDOW_SIZE).map((_, index) => {
  return 0.5 * (1 - Math.cos((2 * Math.PI * index) / (SPECTROGRAM_WINDOW_SIZE - 1)));
});

const DARK_SPECTROGRAM_STOPS = [
  { at: 0, color: [8, 4, 14] as const },
  { at: 0.12, color: [28, 10, 48] as const },
  { at: 0.28, color: [76, 18, 104] as const },
  { at: 0.46, color: [148, 24, 118] as const },
  { at: 0.64, color: [214, 25, 76] as const },
  { at: 0.82, color: [255, 94, 12] as const },
  { at: 0.94, color: [255, 176, 42] as const },
  { at: 1, color: [255, 246, 214] as const },
];

const LIGHT_SPECTROGRAM_STOPS = [
  { at: 0, color: [12, 8, 18] as const },
  { at: 0.12, color: [34, 12, 56] as const },
  { at: 0.28, color: [86, 22, 116] as const },
  { at: 0.46, color: [158, 28, 124] as const },
  { at: 0.64, color: [222, 31, 80] as const },
  { at: 0.82, color: [255, 104, 18] as const },
  { at: 0.94, color: [255, 184, 56] as const },
  { at: 1, color: [255, 248, 226] as const },
];

function cacheResult(key: string, value: Uint8ClampedArray): Uint8ClampedArray {
  if (cache.has(key)) {
    cache.delete(key);
  }

  cache.set(key, value);
  while (cache.size > MAX_SPECTROGRAM_CACHE_ENTRIES) {
    const firstKey = cache.keys().next().value as string | undefined;
    if (!firstKey) {
      break;
    }

    cache.delete(firstKey);
  }

  return value;
}

function frequencyForRow(
  row: number,
  height: number,
  minFreq: number,
  maxFreq: number,
  scale: FrequencyScale,
): number {
  const alpha = 1 - row / Math.max(height - 1, 1);
  if (scale === "log") {
    const safeMin = Math.max(minFreq, 1);
    const minLog = Math.log10(safeMin);
    const maxLog = Math.log10(Math.max(maxFreq, safeMin + 1));
    return 10 ** lerp(minLog, maxLog, alpha);
  }

  return lerp(minFreq, maxFreq, alpha);
}

function createFrame(
  channelData: Int8Array,
  centerSample: number,
): Float32Array {
  const frame = new Float32Array(SPECTROGRAM_WINDOW_SIZE);
  const half = Math.floor(SPECTROGRAM_WINDOW_SIZE / 2);

  for (let index = 0; index < SPECTROGRAM_WINDOW_SIZE; index += 1) {
    const sampleIndex = centerSample - half + index;
    const sample =
      sampleIndex >= 0 && sampleIndex < channelData.length
        ? channelData[sampleIndex] / 127
        : 0;
    frame[index] = sample * hannWindow[index];
  }

  return frame;
}

function magnitudesForFrame(frame: Float32Array): Float32Array {
  const complex = fft.createComplexArray();
  const magnitudes = new Float32Array(SPECTROGRAM_FFT_SIZE / 2);

  fft.realTransform(complex, frame);
  fft.completeSpectrum(complex);

  for (let index = 0; index < magnitudes.length; index += 1) {
    const real = complex[index * 2];
    const imaginary = complex[index * 2 + 1];
    const magnitude = Math.sqrt(real * real + imaginary * imaginary);
    magnitudes[index] = 20 * Math.log10(magnitude + 1e-6);
  }

  return magnitudes;
}

function colorize(
  value: number,
  themeMode: SystemThemeMode,
): [number, number, number, number] {
  const normalized = clamp((value + 96) / 78, 0, 1);
  const boosted = normalized ** 0.88;
  const palette =
    themeMode === "dark" ? DARK_SPECTROGRAM_STOPS : LIGHT_SPECTROGRAM_STOPS;

  for (let index = 1; index < palette.length; index += 1) {
    const previous = palette[index - 1];
    const next = palette[index];
    if (boosted > next.at) {
      continue;
    }

    const alpha = clamp(
      (boosted - previous.at) / Math.max(next.at - previous.at, 1e-6),
      0,
      1,
    );
    const red = Math.round(lerp(previous.color[0], next.color[0], alpha));
    const green = Math.round(lerp(previous.color[1], next.color[1], alpha));
    const blue = Math.round(lerp(previous.color[2], next.color[2], alpha));
    return [red, green, blue, 255];
  }

  const brightest = palette[palette.length - 1].color;
  return [brightest[0], brightest[1], brightest[2], 255];
}

function renderSpectrogram(
  document: WorkerDocument,
  request: Extract<IncomingMessage, { kind: "render" }>,
): Uint8ClampedArray {
  const channel = document.channelData[request.channelIndex];
  const pixels = new Uint8ClampedArray(request.width * request.height * 4);
  const sampleRate = document.sampleRate;
  const nyquist = sampleRate / 2;
  const width = Math.max(request.width, 1);
  const height = Math.max(request.height, 1);
  const timeSpan = Math.max(request.endSec - request.startSec, 1e-3);

  const columns = Array.from({ length: width }, (_, x) => {
    const time = request.startSec + (x / Math.max(width - 1, 1)) * timeSpan;
    const centerSample = Math.round(time * sampleRate);
    return magnitudesForFrame(createFrame(channel, centerSample));
  });

  for (let row = 0; row < height; row += 1) {
    const frequency = frequencyForRow(
      row,
      height,
      request.minFreq,
      request.maxFreq,
      request.frequencyScale,
    );
    const normalizedFrequency = clamp(frequency / nyquist, 0, 1);
    const binIndex = clamp(
      Math.round(normalizedFrequency * (SPECTROGRAM_FFT_SIZE / 2 - 1)),
      0,
      SPECTROGRAM_FFT_SIZE / 2 - 1,
    );

    for (let x = 0; x < width; x += 1) {
      const [red, green, blue, alpha] = colorize(
        columns[x][binIndex],
        request.themeMode,
      );
      const offset = (row * width + x) * 4;
      pixels[offset] = red;
      pixels[offset + 1] = green;
      pixels[offset + 2] = blue;
      pixels[offset + 3] = alpha;
    }
  }

  return pixels;
}

self.onmessage = (event: MessageEvent<IncomingMessage>) => {
  const payload = event.data;
  if (payload.kind === "load-document") {
    cache.clear();
    documents.set(payload.documentId, {
      channelData: payload.channelData,
      sampleRate: payload.sampleRate,
    });
    return;
  }

  if (payload.kind === "unload-document") {
    cache.clear();
    documents.delete(payload.documentId);
    return;
  }

  const document = documents.get(payload.documentId);
  if (!document) {
    return;
  }

  const key = JSON.stringify(payload);
  const pixels = cache.get(key) ?? cacheResult(key, renderSpectrogram(document, payload));

  self.postMessage({
    kind: "rendered",
    requestId: payload.requestId,
    width: payload.width,
    height: payload.height,
    pixels,
  });
};
