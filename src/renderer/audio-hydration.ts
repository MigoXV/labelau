import type { WaveformLevel } from "svara-ui/audio";

const WAVEFORM_BASE_SAMPLES_PER_BIN = 32;
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

async function buildChannelAnalysis(
  channelData: Float32Array,
  signal?: AbortSignal,
): Promise<{
  workerChannelData: Int8Array;
  waveformLevels: WaveformLevel[];
}> {
  const workerChannelData = new Int8Array(channelData.length);
  const binCount = Math.ceil(channelData.length / WAVEFORM_BASE_SAMPLES_PER_BIN);
  const min = new Float32Array(binCount);
  const max = new Float32Array(binCount);

  for (let binIndex = 0; binIndex < binCount; binIndex += 1) {
    if (binIndex % MAX_BINS_PER_YIELD === 0) {
      assertNotAborted(signal);
      await yieldToMain();
    }

    const start = binIndex * WAVEFORM_BASE_SAMPLES_PER_BIN;
    const end = Math.min(
      start + WAVEFORM_BASE_SAMPLES_PER_BIN,
      channelData.length,
    );
    let binMin = 1;
    let binMax = -1;

    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      const sample = Math.max(-1, Math.min(1, channelData[sampleIndex]));
      if (sample < binMin) {
        binMin = sample;
      }
      if (sample > binMax) {
        binMax = sample;
      }
      workerChannelData[sampleIndex] = Math.round(sample * 127);
    }

    min[binIndex] = binMin;
    max[binIndex] = binMax;
  }

  const waveformLevels: WaveformLevel[] = [
    {
      min,
      max,
      samplesPerBin: WAVEFORM_BASE_SAMPLES_PER_BIN,
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
  for (let channelIndex = 0; channelIndex < audioBuffer.numberOfChannels; channelIndex += 1) {
    const analysis = await buildChannelAnalysis(
      audioBuffer.getChannelData(channelIndex),
      signal,
    );
    workerChannelData.push(analysis.workerChannelData);
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
