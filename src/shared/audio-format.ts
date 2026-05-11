export const SUPPORTED_AUDIO_EXTENSIONS = [".wav", ".flac", ".mp3"] as const;

export type SupportedAudioExtension = (typeof SUPPORTED_AUDIO_EXTENSIONS)[number];

const AUDIO_MIME_BY_EXTENSION: Record<SupportedAudioExtension, string> = {
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".mp3": "audio/mpeg",
};

export function getAudioExtension(fileName: string): SupportedAudioExtension | null {
  const match = /\.[^./\\]+$/.exec(fileName);
  if (!match) {
    return null;
  }

  const extension = match[0].toLowerCase();
  return SUPPORTED_AUDIO_EXTENSIONS.includes(extension as SupportedAudioExtension)
    ? (extension as SupportedAudioExtension)
    : null;
}

export function isSupportedAudioFile(fileName: string): boolean {
  return getAudioExtension(fileName) !== null;
}

export function getAudioMimeType(fileName: string): string {
  const extension = getAudioExtension(fileName);
  return extension ? AUDIO_MIME_BY_EXTENSION[extension] : "application/octet-stream";
}

export function getSupportedAudioLabel(): string {
  return "WAV / FLAC / MP3";
}
