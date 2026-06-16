import type { ReactNode } from "react";
import type { UiThemePreference } from "svara-ui/labelau";

import type {
  CorpusEntry,
  CorpusEntryTree,
  VadSegment,
} from "../../shared/contracts";
import type {
  EntryOverlayState,
  FileFilter,
  FrequencyScale,
  HeldTool,
  HydratedDocument,
  PlaybackRate,
} from "../editor/types";

export type WorkbenchMode =
  | "no-directory"
  | "empty-directory"
  | "no-selection"
  | "ready";

export interface TaskQueueStats {
  all: number;
  pending: number;
  dirty: number;
  done: number;
}

export interface SelectedFileContext {
  index: number | null;
  total: number;
  stateLabel: string;
}

export interface StatusBarViewModel {
  timeLabel: string;
  chips: string[];
  message: string;
  isError: boolean;
}

export interface TaskQueueProps {
  rootPath: string;
  tree: CorpusEntryTree | null;
  stats: TaskQueueStats;
  isSidebarCollapsed: boolean;
  searchQuery: string;
  fileFilter: FileFilter;
  selectedAudioPath: string | null;
  dirtyPaths: Set<string>;
  savedPaths: Set<string>;
  entryOverrides: Record<string, EntryOverlayState>;
  isScanning: boolean;
  treePanelRef: React.RefObject<HTMLDivElement | null>;
  importDirectoryInputRef: React.RefObject<HTMLInputElement | null>;
  onOpenDirectory: () => void;
  onImportDirectory: () => void;
  onImportDirectoryChange: React.ChangeEventHandler<HTMLInputElement>;
  onRefreshDirectory: () => void;
  onToggleSidebar: () => void;
  onSearchQueryChange: (value: string) => void;
  onFileFilterChange: (filter: FileFilter) => void;
  onClearFilters: () => void;
  onSelectEntry: (entry: CorpusEntry) => void;
}

export interface MoreActionsMenuProps {
  canDiscardChanges: boolean;
  canExportDataset: boolean;
  canUndo: boolean;
  isExporting: boolean;
  uiThemePreference: UiThemePreference;
  onDiscardChanges: () => void;
  onExportDataset: () => void;
  onOpenEngineSettings: () => void;
  onOpenHelp: () => void;
  onUndo: () => void;
  onThemeChange: (value: UiThemePreference) => void;
}

export interface MainWorkbenchProps {
  mode: WorkbenchMode;
  rootPath: string;
  currentDocument: HydratedDocument | null;
  selectedFileContext: SelectedFileContext | null;
  selectedSegment: VadSegment | null;
  selectedSegmentIndex: number | null;
  previousEntry: CorpusEntry | null;
  nextEntry: CorpusEntry | null;
  isLoadingDocument: boolean;
  isSaving: boolean;
  isRunningVad: boolean;
  isDenoising: boolean;
  isPlaying: boolean;
  heldTool: HeldTool;
  frequencyScale: FrequencyScale;
  playbackRate: PlaybackRate;
  denoiseActionLabel: string;
  isInspectorOpen: boolean;
  inspector: ReactNode;
  statusBar: ReactNode;
  children: ReactNode;
  onOpenDirectory: () => void;
  onImportDirectory: () => void;
  onSelectPrevious: () => void;
  onSelectNext: () => void;
  onSaveCurrent: () => void;
  onRunVad: () => void;
  onDenoise: () => void;
  onTogglePlayback: () => void;
  onCycleTool: () => void;
  onToggleFrequencyScale: () => void;
  onCyclePlaybackRate: () => void;
  moreActions: ReactNode;
  editorRef: React.RefObject<HTMLElement | null>;
}

export interface RightInspectorProps {
  isOpen: boolean;
  currentDocument: HydratedDocument | null;
  selectedSegment: VadSegment | null;
  selectedSegmentIndex: number | null;
  currentStateLabel: string;
  onToggle: () => void;
}
