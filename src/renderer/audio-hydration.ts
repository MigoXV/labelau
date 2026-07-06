import type { WaveformLevel } from "svara-ui/audio";

const WAVEFORM_MIN_SAMPLES_PER_BIN = 64;
const WAVEFORM_TARGET_MAX_BASE_BINS = 24_000;
const WAVEFORM_MAX_SAMPLES_PER_BIN_SCAN = 32;
const MAX_BINS_PER_YIELD = 2048;

const audioContexts = new Map<number, AudioContext>();

interface HydratedFrontendAudio {
  playbackUrl: string;
  waveform: {
    workerChannelData: Int8Array[];
    waveformLevels: WaveformLevel[][];
    sampleRate: number;
    durationSec: number;
  };
}

interface HydrateFrontendAudioOptions {
  includeSpectrogramData?: boolean;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError();
  }
}

function getAudioContext(sampleRate: number): AudioContext {
  let context = audioContexts.get(sampleRate);
  if (!context) {
    context = new AudioContext({ sampleRate });
    audioContexts.set(sampleRate, context);
  }

  return context;
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function downsampleLevel(level: WaveformLevel): WaveformLevel {
  const length = Math.ceil(level.min.length / 2);
  const min = new Float32Array(length);
  const max = new Float32Array(length);

  for (let index = 0; index < length; index += 1) {
    const sourceIndex = index * 2;
    const nextIndex = Math.min(sourceIndex + 1, level.min.length - 1);
    min[index] = Math.min(level.min[sourceIndex], level.min[nextIndex]);
    max[index] = Math.max(level.max[sourceIndex], level.max[nextIndex]);
  }

  return {
    min,
    max,
    samplesPerBin: level.samplesPerBin * 2,
  };
}

function getBaseSamplesPerBin(sampleCount: number): number {
  let samplesPerBin = WAVEFORM_MIN_SAMPLES_PER_BIN;
  while (
    Math.ceil(sampleCount / samplesPerBin) > WAVEFORM_TARGET_MAX_BASE_BINS
  ) {
    samplesPerBin *= 2;
  }

  return samplesPerBin;
}

function getSampleStep(start: number, end: number): number {
  return Math.max(
    1,
    Math.floor((end - start) / WAVEFORM_MAX_SAMPLES_PER_BIN_SCAN),
  );
}

async function buildChannelAnalysis(
  channelData: Float32Array,
  includeSpectrogramData: boolean,
  signal?: AbortSignal,
): Promise<{
  workerChannelData: Int8Array;
  waveformLevels: WaveformLevel[];
}> {
  const workerChannelData = includeSpectrogramData
    ? new Int8Array(channelData.length)
    : new Int8Array(0);
  const baseSamplesPerBin = getBaseSamplesPerBin(channelData.length);
  const binCount = Math.ceil(channelData.length / baseSamplesPerBin);
  const min = new Float32Array(binCount);
  const max = new Float32Array(binCount);

  for (let binIndex = 0; binIndex < binCount; binIndex += 1) {
    if (binIndex % MAX_BINS_PER_YIELD === 0) {
      assertNotAborted(signal);
      await yieldToMain();
    }

    const start = binIndex * baseSamplesPerBin;
    const end = Math.min(
      start + baseSamplesPerBin,
      channelData.length,
    );
    const sampleStep = includeSpectrogramData ? 1 : getSampleStep(start, end);
    let binMin = 1;
    let binMax = -1;

    for (let sampleIndex = start; sampleIndex < end; sampleIndex += sampleStep) {
      const sample = Math.max(-1, Math.min(1, channelData[sampleIndex]));
      if (sample < binMin) {
        binMin = sample;
      }
      if (sample > binMax) {
        binMax = sample;
      }
      if (includeSpectrogramData) {
        workerChannelData[sampleIndex] = Math.round(sample * 127);
      }
    }

    min[binIndex] = binMin;
    max[binIndex] = binMax;
  }

  const waveformLevels: WaveformLevel[] = [
    {
      min,
      max,
      samplesPerBin: baseSamplesPerBin,
    },
  ];

  while (waveformLevels[waveformLevels.length - 1].min.length > 2048) {
    assertNotAborted(signal);
    await yieldToMain();
    waveformLevels.push(
      downsampleLevel(waveformLevels[waveformLevels.length - 1]),
    );
  }

  return { workerChannelData, waveformLevels };
}

export async function hydrateFrontendAudio(
  url: string,
  sampleRate: number,
  options: HydrateFrontendAudioOptions = {},
  signal?: AbortSignal,
): Promise<HydratedFrontendAudio> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Failed to fetch audio: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  assertNotAborted(signal);

  const audioBuffer = await getAudioContext(sampleRate).decodeAudioData(
    arrayBuffer,
  );
  assertNotAborted(signal);

  const workerChannelData: Int8Array[] = [];
  const waveformLevels: WaveformLevel[][] = [];
  const includeSpectrogramData = Boolean(options.includeSpectrogramData);
  for (let channelIndex = 0; channelIndex < audioBuffer.numberOfChannels; channelIndex += 1) {
    const analysis = await buildChannelAnalysis(
      audioBuffer.getChannelData(channelIndex),
      includeSpectrogramData,
      signal,
    );
    if (includeSpectrogramData) {
      workerChannelData.push(analysis.workerChannelData);
    }
    waveformLevels.push(analysis.waveformLevels);
  }

  return {
    playbackUrl: url,
    waveform: {
      workerChannelData,
      waveformLevels,
      sampleRate: audioBuffer.sampleRate,
      durationSec: audioBuffer.duration,
    },
  };
}

export async function hydrateSpectrogramChannelData(
  url: string,
  sampleRate: number,
  signal?: AbortSignal,
): Promise<Int8Array[]> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Failed to fetch audio: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  assertNotAborted(signal);

  const audioBuffer = await getAudioContext(sampleRate).decodeAudioData(
    arrayBuffer,
  );
  assertNotAborted(signal);

  const channelData: Int8Array[] = [];
  for (let channelIndex = 0; channelIndex < audioBuffer.numberOfChannels; channelIndex += 1) {
    if (channelIndex > 0) {
      await yieldToMain();
    }

    const source = audioBuffer.getChannelData(channelIndex);
    const target = new Int8Array(source.length);
    for (let sampleIndex = 0; sampleIndex < source.length; sampleIndex += 1) {
      if (sampleIndex % (MAX_BINS_PER_YIELD * 8) === 0) {
        assertNotAborted(signal);
        await yieldToMain();
      }

      target[sampleIndex] = Math.round(
        Math.max(-1, Math.min(1, source[sampleIndex])) * 127,
      );
    }
    channelData.push(target);
  }

  return channelData;
}
