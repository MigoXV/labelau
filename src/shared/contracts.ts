import type { WindowCloseAction } from "./window-close";

export type FrequencyScale = "linear" | "mel" | "log";

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

export interface AnnotationSegment extends VadSegment {
  id?: string;
  transcript?: string;
}

export interface CorpusEntry {
  audioPath: string;
  csvPath: string | null;
  annotationPath?: string | null;
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
  annotationPath?: string | null;
  stem: string;
  audioMeta: AudioMeta;
  sampleRate: number;
  channelCount: number;
  durationSec: number;
  segments: AnnotationSegment[];
  channelLabels?: string[];
  audioUrl: string;
}

export interface SaveAnnotationRequest {
  audioPath: string;
  csvPath?: string | null;
  annotationPath?: string | null;
  segments: AnnotationSegment[];
}

export interface SaveAnnotationResult {
  csvPath: string;
  annotationPath?: string;
}

export interface RunVadPreannotationRequest {
  audioPath: string;
  audioContentBase64?: string;
  vadGrpcUrl?: string;
}

export interface RunAsrPreannotationRequest {
  audioPath: string;
  audioContentBase64?: string;
  asrGrpcUrl?: string;
}

export interface DenoiseAudioRequest {
  audioPath: string;
  denoiseGrpcUrl?: string;
}

export interface DenoiseAudioResult {
  audioUrl: string;
  audioContentBase64: string;
  sampleRate: number;
  channelCount: number;
  durationSec: number;
}

export interface EngineConfig {
  vadGrpcUrl: string;
  asrGrpcUrl: string;
  denoiseGrpcUrl: string;
}

export type EngineKind = "vad" | "asr" | "denoise";

export interface TestEngineConnectionRequest {
  engine: EngineKind;
  grpcUrl?: string;
}

export interface TestEngineConnectionResult {
  ok: boolean;
  message: string;
}

export interface ImportAudioFilesResult {
  importedCount: number;
  skippedCount: number;
  rootPath: string;
  message: string;
}

export interface ExportAudioFolderRequest {
  rootPath: string;
  audioPaths?: string[];
  splitName: "test";
}

export interface ExportAudioFolderResult {
  exportedCount: number;
  fileName: string;
  downloadUrl?: string;
  savedPath?: string;
  canceled?: boolean;
}

export interface ServerDirectoryEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
}

export interface ServerDirectoryListing {
  currentPath: string;
  parentPath: string | null;
  entries: ServerDirectoryEntry[];
}

export interface HostBridge {
  mode: "browser" | "electron";
  pickDirectory(): Promise<string | null>;
  listServerDirectory(path?: string): Promise<ServerDirectoryListing>;
  scanDirectory(rootPath: string): Promise<ScanDirectoryResult>;
  loadDocument(audioPath: string): Promise<LoadedAudioDocument>;
  saveAnnotation(
    request: SaveAnnotationRequest,
  ): Promise<SaveAnnotationResult>;
  runVadPreannotation(
    request: RunVadPreannotationRequest,
  ): Promise<VadSegment[]>;
  runAsrPreannotation(
    request: RunAsrPreannotationRequest,
  ): Promise<AnnotationSegment[]>;
  denoiseAudio(request: DenoiseAudioRequest): Promise<DenoiseAudioResult>;
  getEngineConfigDefaults(): Promise<EngineConfig>;
  testEngineConnection(
    request: TestEngineConnectionRequest,
  ): Promise<TestEngineConnectionResult>;
  importAudioFiles(
    rootPath: string,
    files: File[],
    onProgress?: (progressPercent: number) => void,
  ): Promise<ImportAudioFilesResult>;
  exportAudioFolder(
    request: ExportAudioFolderRequest,
  ): Promise<ExportAudioFolderResult>;
  onWindowCloseRequested(listener: () => void): () => void;
  confirmWindowClose(dirtyCount: number): Promise<WindowCloseAction>;
  completeWindowClose(): Promise<void>;
}
