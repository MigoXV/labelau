export interface DecodedWaveform {
  channelData: Float32Array[];
  sampleRate: number;
  durationSec: number;
}

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext();
  }

  return audioContext;
}

export async function hydrateAudio(url: string): Promise<{
  arrayBuffer: ArrayBuffer;
  blobUrl: string;
  waveform: DecodedWaveform;
}> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch audio: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const audioBuffer = await getAudioContext().decodeAudioData(arrayBuffer.slice(0));
  const channelData = Array.from(
    { length: audioBuffer.numberOfChannels },
    (_, index) => new Float32Array(audioBuffer.getChannelData(index)),
  );
  const blob = new Blob([arrayBuffer], { type: "audio/wav" });

  return {
    arrayBuffer,
    blobUrl: URL.createObjectURL(blob),
    waveform: {
      channelData,
      sampleRate: audioBuffer.sampleRate,
      durationSec: audioBuffer.duration,
    },
  };
}
