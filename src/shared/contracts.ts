import type { WindowCloseAction } from "./window-close";

export type FrequencyScale = "linear" | "log";

export interface AudioMeta {
  sampleRate: number;
  channelCount: number;
  durationSec: number;
  bitsPerSample: number;
}

export interface VadSegment {
  startSec: number;
  endSec: number;
}

export interface CorpusEntry {
  audioPath: string;
  csvPath: string | null;
  relativeDir: string;
  stem: string;
  hasAnnotation: boolean;
  isDirty: boolean;
  audioMeta: AudioMeta;
}

export interface CorpusDirectory {
  name: string;
  relativePath: string;
  directories: CorpusDirectory[];
  entries: CorpusEntry[];
}

export type CorpusEntryTree = CorpusDirectory;

export interface ScanWarning {
  audioPath: string;
  stem: string;
  reason: string;
}

export interface ScanDirectoryResult {
  tree: CorpusEntryTree;
  warnings: ScanWarning[];
}

export interface LoadedAudioDocument {
  audioPath: string;
  csvPath: string | null;
  stem: string;
  audioMeta: AudioMeta;
  sampleRate: number;
  channelCount: number;
  durationSec: number;
  segments: VadSegment[];
  channelLabels?: string[];
  audioUrl: string;
}

export interface SaveAnnotationRequest {
  audioPath: string;
  csvPath?: string | null;
  segments: VadSegment[];
}

export interface SaveAnnotationResult {
  csvPath: string;
}

export interface HostBridge {
  mode: "browser" | "electron";
  pickDirectory(): Promise<string | null>;
  scanDirectory(rootPath: string): Promise<ScanDirectoryResult>;
  loadDocument(audioPath: string): Promise<LoadedAudioDocument>;
  saveAnnotation(
    request: SaveAnnotationRequest,
  ): Promise<SaveAnnotationResult>;
  onWindowCloseRequested(listener: () => void): () => void;
  confirmWindowClose(dirtyCount: number): Promise<WindowCloseAction>;
  completeWindowClose(): Promise<void>;
}
