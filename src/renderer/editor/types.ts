import type { WaveformLevel } from "svara-ui/audio";
import type {
  AnnotationSegment,
  LoadedAudioDocument,
  VadSegment,
} from "../../shared/contracts";

export type HeldTool = "mark" | "erase" | null;
export type EntryState = "dirty" | "saved" | "matched" | "new";
export type FileFilter = "all" | "pending" | "dirty" | "done";
export type PlaybackRate = 1 | 2 | 3 | 4;
export type SegmentHitPart = "body" | "start" | "end";
export type AudioViewMode = "original" | "denoised";

export interface HydratedAudioMedia {
  audioUrl: string;
  blobUrl: string;
  workerChannelData: Int8Array[];
  waveformLevels: WaveformLevel[][];
  waveformSampleRate: number;
  channelCount: number;
  durationSec: number;
}

export interface HydratedDocument extends LoadedAudioDocument {
  blobUrl: string;
  workerChannelData: Int8Array[];
  waveformLevels: WaveformLevel[][];
  waveformSampleRate: number;
  savedSegments: AnnotationSegment[];
  segmentHistory: AnnotationSegment[][];
  isDirty: boolean;
  denoisedAudioContentBase64?: string;
  activeAudioView: AudioViewMode;
  originalMedia: HydratedAudioMedia;
  denoisedMedia?: HydratedAudioMedia;
}

export interface TimeRange {
  startSec: number;
  endSec: number;
}

export interface FrequencyRange {
  minFreq: number;
  maxFreq: number;
}

export interface EntryOverlayState {
  hasAnnotation: boolean;
  csvPath: string | null;
  annotationPath?: string | null;
  textGridPath?: string | null;
}

export interface SegmentHit {
  index: number;
  part: SegmentHitPart;
  segment: VadSegment;
}

export interface SegmentOverlayStyle {
  fillStyle: string;
  outlineStyle: string;
  edgeStyle: string;
}

export interface SegmentOverlayGroups {
  saved: VadSegment[];
  unsaved: VadSegment[];
}
