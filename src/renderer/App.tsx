import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from "react";
import {
  buildUiThemeStyle,
  EngineSettingsDialog,
  getCanvasTheme,
  getWaveformTheme,
  HelpDialog,
  resolveUiThemeMode,
  centerElementInScrollContainer,
  formatSeconds,
  getDefaultFrequencyRange,
  getDefaultTimeRange,
  getNextPlaybackRate,
  getNextTool,
  getSegmentKey,
  getSegmentOverlayGroups,
  getToolLabel,
  setWithinDuration,
  setWithinNyquist,
  SpectrogramPanel,
  WaveformPanel,
  type UiThemePreference,
  useSystemTheme,
} from "svara-ui/labelau";

import { hydrateFrontendAudio } from "./audio-hydration";
import { getHostBridge } from "./bridge";
import {
  saveDirtyDocuments,
  type DirtyDocumentForSave,
} from "./close-flow";
import { HELP_SECTIONS } from "../shared/help-content";
import { SpectrogramWorkerClient } from "./worker-client";
import {
  MAX_FRONTEND_SAMPLE_RATE,
  MIN_TIME_WINDOW_SEC,
} from "../shared/constants";
import type {
  AnnotationSegment,
  CorpusEntry,
  CorpusEntryTree,
  EngineConfig,
  FrequencyScale,
  HostBridge,
  VadSegment,
} from "../shared/contracts";
import {
  annotationSegmentsEqual,
  assertNonOverlappingSegments,
  cloneAnnotationSegments,
  createSegmentId,
  hydrateAnnotationSegments,
} from "../shared/annotations";
import { clamp } from "../shared/math";
import { filterTree, flattenEntries } from "../shared/tree";
import {
  addSegment,
  eraseSegment,
  normalizeSegments,
  replaceSegment,
} from "../shared/vad";
import {
  filterTreeByState,
  getEntryState,
  getEntryStateLabel,
  matchesFileFilter,
} from "./editor/file-state";
import {
  readStoredJson,
  readStoredNumber,
  readStoredString,
  removeStoredValue,
  writeStoredJson,
  writeStoredNumber,
  writeStoredString,
} from "./storage";
import type {
  EntryOverlayState,
  FileFilter,
  HeldTool,
  HydratedDocument,
  PlaybackRate,
  TimeRange,
  FrequencyRange,
} from "./editor/types";
import { BottomStatusBar } from "./workbench/BottomStatusBar";
import { MainWorkbench } from "./workbench/MainWorkbench";
import { MoreActionsMenu } from "./workbench/MoreActionsMenu";
import { RightInspector } from "./workbench/RightInspector";
import { ServerDirectoryPickerDialog } from "./workbench/ServerDirectoryPickerDialog";
import { TaskQueue } from "./workbench/TaskQueue";
import type {
  DatasetState,
  StatusBarViewModel,
  WorkbenchMode,
} from "./workbench/types";

const EMPTY_ENGINE_CONFIG: EngineConfig = {
  vadGrpcUrl: "",
  asrGrpcUrl: "",
  denoiseGrpcUrl: "",
};
const DOCUMENT_CACHE_LIMIT = 8;
const MAX_AUTO_PRELOAD_DURATION_SEC = 90;
const STORAGE_KEYS = {
  engineConfig: "engine-config",
  rootPath: "root-path",
  showSpectrogram: "show-spectrogram",
  sidebarCollapsed: "sidebar-collapsed",
  sidebarWidth: "sidebar-width",
  uiTheme: "ui-theme",
  waveformHeight: "waveform-height",
} as const;

function readStoredEngineConfig(): EngineConfig {
  const parsedValue = readStoredJson<Partial<EngineConfig>>(
    STORAGE_KEYS.engineConfig,
    EMPTY_ENGINE_CONFIG,
  );
  return {
    vadGrpcUrl:
      typeof parsedValue.vadGrpcUrl === "string" ? parsedValue.vadGrpcUrl : "",
    asrGrpcUrl:
      typeof parsedValue.asrGrpcUrl === "string" ? parsedValue.asrGrpcUrl : "",
    denoiseGrpcUrl:
      typeof parsedValue.denoiseGrpcUrl === "string"
        ? parsedValue.denoiseGrpcUrl
        : "",
  };
}

function readStoredThemePreference(): UiThemePreference {
  const savedValue = readStoredString(STORAGE_KEYS.uiTheme, "system");
  return savedValue === "light" || savedValue === "dark" || savedValue === "system"
    ? savedValue
    : "system";
}

function readStoredBoolean(key: string, fallbackValue: boolean): boolean {
  const savedValue = readStoredString(key, fallbackValue ? "true" : "false");
  return savedValue === "true" ? true : savedValue === "false" ? false : fallbackValue;
}

function getNextFrequencyScale(value: FrequencyScale): FrequencyScale {
  switch (value) {
    case "linear":
      return "mel";
    case "mel":
      return "log";
    case "log":
      return "linear";
  }
}

function cloneSegments(segments: AnnotationSegment[]): AnnotationSegment[] {
  return cloneAnnotationSegments(segments);
}

function segmentsEqual(
  leftSegments: AnnotationSegment[],
  rightSegments: AnnotationSegment[],
): boolean {
  return annotationSegmentsEqual(leftSegments, rightSegments);
}

function hydrateEditorSegments(
  segments: AnnotationSegment[],
): AnnotationSegment[] {
  return hydrateAnnotationSegments(segments);
}

function createEmptyAnnotationSegment(
  segment: VadSegment,
  index: number,
): AnnotationSegment {
  return {
    ...segment,
    id: createSegmentId(segment, index),
    transcript: "",
  };
}

export function App() {
  const bridge = useMemo<HostBridge>(() => getHostBridge(), []);
  const themeMode = useSystemTheme();
  const canvasTheme = useMemo(() => getCanvasTheme(themeMode), [themeMode]);
  const [uiThemePreference, setUiThemePreference] = useState<UiThemePreference>(
    readStoredThemePreference,
  );
  const effectiveUiThemeMode = useMemo(
    () => resolveUiThemeMode(uiThemePreference, themeMode),
    [themeMode, uiThemePreference],
  );
  const uiThemeStyle = useMemo(
    () => buildUiThemeStyle(effectiveUiThemeMode),
    [effectiveUiThemeMode],
  );
  const waveformTheme = useMemo(
    () => getWaveformTheme(effectiveUiThemeMode),
    [effectiveUiThemeMode],
  );
  const initialShowSpectrogram = useMemo(
    () => readStoredBoolean(STORAGE_KEYS.showSpectrogram, false),
    [],
  );
  const importDirectoryInputRef = useRef<HTMLInputElement | null>(null);
  const spectrogramWorkerRef = useRef<SpectrogramWorkerClient | null>(
    initialShowSpectrogram ? new SpectrogramWorkerClient() : null,
  );
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const cacheRef = useRef(new Map<string, HydratedDocument>());
  const lruRef = useRef<string[]>([]);
  const preloadAbortRef = useRef<AbortController | null>(null);
  const preloadingDocumentRef = useRef<{
    audioPath: string;
    promise: Promise<HydratedDocument | null>;
  } | null>(null);
  const treePanelRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<HTMLElement | null>(null);
  const sidebarResizeRef = useRef<{
    startX: number;
    startWidth: number;
  } | null>(null);
  const editorResizeRef = useRef<{
    startY: number;
    startHeight: number;
    containerHeight: number;
  } | null>(null);

  const [rootPath, setRootPath] = useState(() =>
    readStoredString(STORAGE_KEYS.rootPath),
  );
  const [datasetState, setDatasetState] = useState<DatasetState>(() =>
    readStoredString(STORAGE_KEYS.rootPath) ? "scanning" : "none",
  );
  const [datasetErrorMessage, setDatasetErrorMessage] = useState<string | null>(null);
  const [tree, setTree] = useState<CorpusEntryTree | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [fileFilter, setFileFilter] = useState<FileFilter>("all");
  const [selectedAudioPath, setSelectedAudioPath] = useState<string | null>(null);
  const [showSpectrogram, setShowSpectrogram] = useState(initialShowSpectrogram);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() =>
    readStoredBoolean(STORAGE_KEYS.sidebarCollapsed, false),
  );
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readStoredNumber(STORAGE_KEYS.sidebarWidth, 320, { min: 240, max: 520 }),
  );
  const [waveformHeight, setWaveformHeight] = useState(() =>
    readStoredNumber(STORAGE_KEYS.waveformHeight, 256, { min: 160, max: 640 }),
  );
  const [currentDocument, setCurrentDocument] = useState<HydratedDocument | null>(
    null,
  );
  const [timeRange, setTimeRange] = useState<TimeRange>({
    startSec: 0,
    endSec: 1,
  });
  const [frequencyRange, setFrequencyRange] = useState<FrequencyRange>({
    minFreq: 0,
    maxFreq: 8000,
  });
  const [frequencyScale, setFrequencyScale] =
    useState<FrequencyScale>("linear");
  const [selectedChannel, setSelectedChannel] = useState(0);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [playbackRate, setPlaybackRate] = useState<PlaybackRate>(1);
  const [selectedSegmentKey, setSelectedSegmentKey] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [isLoadingDocument, setIsLoadingDocument] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isRunningVad, setIsRunningVad] = useState(false);
  const [isRunningAsr, setIsRunningAsr] = useState(false);
  const [isDenoising, setIsDenoising] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("等待打开目录");
  const [heldTool, setHeldTool] = useState<HeldTool>(null);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isDirectoryBrowserOpen, setIsDirectoryBrowserOpen] = useState(false);
  const [isEngineSettingsOpen, setIsEngineSettingsOpen] = useState(false);
  const [isInspectorOpen, setIsInspectorOpen] = useState(false);
  const [engineConfig, setEngineConfig] = useState<EngineConfig>(
    readStoredEngineConfig,
  );
  const [engineConfigDefaults, setEngineConfigDefaults] =
    useState<EngineConfig>(EMPTY_ENGINE_CONFIG);
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(() => new Set());
  const [savedPaths, setSavedPaths] = useState<Set<string>>(() => new Set());
  const [entryOverrides, setEntryOverrides] = useState<
    Record<string, EntryOverlayState>
  >({});
  const loadRequestIdRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const closeFlowInFlightRef = useRef(false);
  const didValidateStoredRootRef = useRef(false);

  const revokeDocumentUrls = useCallback((document: HydratedDocument) => {
    const blobUrls = new Set<string>([
      document.blobUrl,
      document.originalMedia.blobUrl,
    ]);
    if (document.denoisedMedia) {
      blobUrls.add(document.denoisedMedia.blobUrl);
    }
    for (const blobUrl of blobUrls) {
      if (blobUrl.startsWith("blob:")) {
        URL.revokeObjectURL(blobUrl);
      }
    }
  }, []);

  const resetDatasetSelection = useCallback(() => {
    loadAbortRef.current?.abort();
    preloadAbortRef.current?.abort();
    preloadingDocumentRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
    }
    for (const document of cacheRef.current.values()) {
      revokeDocumentUrls(document);
      spectrogramWorkerRef.current?.unloadDocument(document.audioPath);
    }
    cacheRef.current.clear();
    lruRef.current = [];
    setRootPath("");
    setDatasetState("none");
    setDatasetErrorMessage(null);
    setTree(null);
    setCurrentDocument(null);
    setSelectedAudioPath(null);
    setSelectedSegmentKey(null);
    setDirtyPaths(new Set());
    setSavedPaths(new Set());
    setEntryOverrides({});
    setSearchQuery("");
    setFileFilter("all");
    setPlayheadSec(0);
    setIsPlaying(false);
    setStatusMessage("已清除记住的数据集路径");
    setErrorMessage(null);
    removeStoredValue(STORAGE_KEYS.rootPath);
  }, [revokeDocumentUrls]);

  useEffect(() => {
    writeStoredString(STORAGE_KEYS.uiTheme, uiThemePreference);
  }, [uiThemePreference]);

  useEffect(() => {
    writeStoredString(
      STORAGE_KEYS.showSpectrogram,
      showSpectrogram ? "true" : "false",
    );
  }, [showSpectrogram]);

  useEffect(() => {
    writeStoredJson(STORAGE_KEYS.engineConfig, engineConfig);
  }, [engineConfig]);

  useEffect(() => {
    writeStoredString(
      STORAGE_KEYS.sidebarCollapsed,
      isSidebarCollapsed ? "true" : "false",
    );
  }, [isSidebarCollapsed]);

  useEffect(() => {
    writeStoredNumber(STORAGE_KEYS.sidebarWidth, sidebarWidth);
  }, [sidebarWidth]);

  useEffect(() => {
    writeStoredNumber(STORAGE_KEYS.waveformHeight, waveformHeight);
  }, [waveformHeight]);

  useEffect(() => {
    let isMounted = true;
    void bridge.getEngineConfigDefaults().then((defaults) => {
      if (isMounted) {
        setEngineConfigDefaults(defaults);
      }
    });

    return () => {
      isMounted = false;
    };
  }, [bridge]);

  useEffect(() => {
    audioRef.current = new Audio();
    audioRef.current.preload = "auto";

    return () => {
      loadAbortRef.current?.abort();
      preloadAbortRef.current?.abort();
      spectrogramWorkerRef.current?.dispose();
      audioRef.current?.pause();
      for (const document of cacheRef.current.values()) {
        revokeDocumentUrls(document);
      }
    };
  }, [revokeDocumentUrls]);

  const getSpectrogramWorker = useCallback(() => {
    if (!spectrogramWorkerRef.current) {
      spectrogramWorkerRef.current = new SpectrogramWorkerClient();
    }

    return spectrogramWorkerRef.current;
  }, []);

  useEffect(() => {
    if (!audioRef.current) {
      return;
    }

    audioRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (sidebarResizeRef.current) {
        const { startX, startWidth } = sidebarResizeRef.current;
        setSidebarWidth(clamp(startWidth + event.clientX - startX, 240, 520));
      }

      if (editorResizeRef.current) {
        const { startY, startHeight, containerHeight } = editorResizeRef.current;
        setWaveformHeight(
          clamp(
            startHeight + event.clientY - startY,
            160,
            Math.max(containerHeight - 180, 160),
          ),
        );
      }
    };

    const clearDragState = () => {
      if (!sidebarResizeRef.current && !editorResizeRef.current) {
        return;
      }

      sidebarResizeRef.current = null;
      editorResizeRef.current = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", clearDragState);
    window.addEventListener("pointercancel", clearDragState);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", clearDragState);
      window.removeEventListener("pointercancel", clearDragState);
    };
  }, []);

  const touchCache = useCallback((audioPath: string) => {
    lruRef.current = lruRef.current.filter((path) => path !== audioPath);
    lruRef.current.push(audioPath);
  }, []);

  const cacheDocument = useCallback(
    (document: HydratedDocument) => {
      cacheRef.current.set(document.audioPath, document);
      touchCache(document.audioPath);

      while (lruRef.current.length > DOCUMENT_CACHE_LIMIT) {
        const evictedPath = lruRef.current.shift();
        if (!evictedPath || evictedPath === document.audioPath) {
          continue;
        }

        const evicted = cacheRef.current.get(evictedPath);
        if (!evicted || evicted.isDirty) {
          touchCache(evictedPath);
          break;
        }

        revokeDocumentUrls(evicted);
        cacheRef.current.delete(evictedPath);
        spectrogramWorkerRef.current?.unloadDocument(evictedPath);
      }
    },
    [revokeDocumentUrls, touchCache],
  );

  const updateCurrentDocument = useCallback(
    (updater: (document: HydratedDocument) => HydratedDocument) => {
      setCurrentDocument((previous) => {
        if (!previous) {
          return previous;
        }

        const next = updater(previous);
        cacheDocument(next);
        return next;
      });
    },
    [cacheDocument],
  );

  const switchAudioView = useCallback(
    (viewMode: "original" | "denoised") => {
      if (!currentDocument) {
        return;
      }

      const media =
        viewMode === "denoised"
          ? currentDocument.denoisedMedia
          : currentDocument.originalMedia;
      if (!media || currentDocument.activeAudioView === viewMode) {
        return;
      }

      updateCurrentDocument((document) => ({
        ...document,
        audioUrl: media.audioUrl,
        channelCount: media.channelCount,
        durationSec: media.durationSec,
        blobUrl: media.blobUrl,
        workerChannelData: media.workerChannelData,
        waveformLevels: media.waveformLevels,
        waveformSampleRate: media.waveformSampleRate,
        activeAudioView: viewMode,
      }));
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = media.blobUrl;
        audioRef.current.load();
        audioRef.current.currentTime = 0;
        audioRef.current.playbackRate = playbackRate;
      }
      setPlayheadSec(0);
      setIsPlaying(false);
      setTimeRange(getDefaultTimeRange(media.durationSec));
      setFrequencyRange(getDefaultFrequencyRange(media.waveformSampleRate));
      setSelectedChannel((previous) =>
        Math.min(previous, Math.max(media.channelCount - 1, 0)),
      );
      setStatusMessage(
        viewMode === "original"
          ? `正在显示 ${currentDocument.stem} 的原始音频`
          : `正在显示 ${currentDocument.stem} 的降噪音频`,
      );
    },
    [currentDocument, playbackRate, updateCurrentDocument],
  );

  const showOriginalAudio = useCallback(() => {
    switchAudioView("original");
  }, [switchAudioView]);

  const showDenoisedAudio = useCallback(() => {
    if (!currentDocument?.denoisedMedia) {
      return;
    }
    switchAudioView("denoised");
  }, [currentDocument?.denoisedMedia, switchAudioView]);

  const scanDirectory = useCallback(
    async (
      nextRootPath: string,
      options?: { fallbackToDefaultOnFailure?: boolean },
    ) => {
      setIsScanning(true);
      setDatasetState("scanning");
      setRootPath(nextRootPath);
      setErrorMessage(null);
      setDatasetErrorMessage(null);

      try {
        const { tree: nextTree, warnings } = await bridge.scanDirectory(nextRootPath);
        const flattened = flattenEntries(nextTree);

        setTree(nextTree);
        setRootPath(nextRootPath);
        setDatasetState(flattened.length > 0 ? "ready" : "empty");
        writeStoredString(STORAGE_KEYS.rootPath, nextRootPath);
        setStatusMessage(
          flattened.length > 0
            ? `已载入 ${flattened.length} 个可用音频`
            : "目录中未找到可导入的音频",
        );
        setErrorMessage(
          warnings.length > 0
            ? flattened.length > 0
              ? `已载入 ${flattened.length} 个可用音频，跳过 ${warnings.length} 个不支持文件`
              : `未发现可导入的音频，已跳过 ${warnings.length} 个不支持文件`
            : null,
        );

        if (
          selectedAudioPath &&
          flattened.some((entry) => entry.audioPath === selectedAudioPath)
        ) {
          return;
        }

        setSelectedAudioPath(flattened[0]?.audioPath ?? null);
      } catch (error) {
        const message = error instanceof Error ? error.message : "扫描目录失败";
        loadAbortRef.current?.abort();
        preloadAbortRef.current?.abort();
        preloadingDocumentRef.current = null;
        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current.removeAttribute("src");
          audioRef.current.load();
        }
        for (const document of cacheRef.current.values()) {
          revokeDocumentUrls(document);
          spectrogramWorkerRef.current?.unloadDocument(document.audioPath);
        }
        cacheRef.current.clear();
        lruRef.current = [];
        setTree(null);
        setCurrentDocument(null);
        setSelectedAudioPath(null);
        setSelectedSegmentKey(null);
        setDirtyPaths(new Set());
        setSavedPaths(new Set());
        setEntryOverrides({});

        if (options?.fallbackToDefaultOnFailure) {
          removeStoredValue(STORAGE_KEYS.rootPath);

          try {
            const defaultListing = await bridge.listServerDirectory();
            const defaultRootPath = defaultListing.currentPath;
            const { tree: defaultTree, warnings } =
              await bridge.scanDirectory(defaultRootPath);
            const flattened = flattenEntries(defaultTree);

            setTree(defaultTree);
            setRootPath(defaultRootPath);
            setDatasetState(flattened.length > 0 ? "ready" : "empty");
            writeStoredString(STORAGE_KEYS.rootPath, defaultRootPath);
            setStatusMessage(
              flattened.length > 0
                ? `已切换到默认目录，载入 ${flattened.length} 个可用音频`
                : "已切换到默认目录，未找到可导入的音频",
            );
            setErrorMessage(
              warnings.length > 0
                ? flattened.length > 0
                  ? `已载入 ${flattened.length} 个可用音频，跳过 ${warnings.length} 个不支持文件`
                  : `未发现可导入的音频，已跳过 ${warnings.length} 个不支持文件`
                : null,
            );
            setDatasetErrorMessage(null);
            setSelectedAudioPath(flattened[0]?.audioPath ?? null);
            return;
          } catch {
            setRootPath("");
            setDatasetState("none");
            setDatasetErrorMessage(null);
            setStatusMessage("请打开音频目录开始标注");
            setErrorMessage(null);
            return;
          }
        }

        setDatasetState("invalid");
        setDatasetErrorMessage(`当前数据集目录不可用：${message}`);
        setStatusMessage("当前数据集目录不可用，请重新选择目录");
        setErrorMessage(`当前数据集目录不可用：${message}`);
      } finally {
        setIsScanning(false);
      }
    },
    [bridge, revokeDocumentUrls, selectedAudioPath],
  );

  const openDirectory = useCallback(async () => {
    if (bridge.mode === "browser") {
      setIsDirectoryBrowserOpen(true);
      return;
    }

    const pickedPath = await bridge.pickDirectory();
    if (!pickedPath) {
      return;
    }

    await scanDirectory(pickedPath);
  }, [bridge, scanDirectory]);

  useEffect(() => {
    if (didValidateStoredRootRef.current) {
      return;
    }
    didValidateStoredRootRef.current = true;
    const rememberedRootPath = readStoredString(STORAGE_KEYS.rootPath);
    if (!rememberedRootPath) {
      setDatasetState("none");
      return;
    }
    void scanDirectory(rememberedRootPath, { fallbackToDefaultOnFailure: true });
  }, [scanDirectory]);

  const importAudioFiles = useCallback(
    async (files: File[], onProgress?: (progressPercent: number) => void) => {
      if (!rootPath || (datasetState !== "ready" && datasetState !== "empty")) {
        throw new Error("请先打开或输入一个服务器目录");
      }

      const result = await bridge.importAudioFiles(rootPath, files, onProgress);
      setStatusMessage(result.message);
      await scanDirectory(result.rootPath);
      return result;
    },
    [bridge, datasetState, rootPath, scanDirectory],
  );

  const clearRememberedDirectory = useCallback(() => {
    if (dirtyPaths.size > 0) {
      const shouldClear = window.confirm(
        "当前存在未保存修改。清除已记住路径会关闭当前数据集并丢弃这些未保存状态，是否继续？",
      );
      if (!shouldClear) {
        return;
      }
    }
    resetDatasetSelection();
  }, [dirtyPaths.size, resetDatasetSelection]);

  const handleImportDirectory = useCallback(() => {
    importDirectoryInputRef.current?.click();
  }, []);

  const handleImportDirectoryChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      if (files.length === 0) {
        return;
      }

      void importAudioFiles(files);
    },
    [importAudioFiles],
  );

  const hydrateDocumentForCache = useCallback(
    async (audioPath: string, signal: AbortSignal): Promise<HydratedDocument | null> => {
      const loaded = await bridge.loadDocument(audioPath);
      if (signal.aborted) {
        return null;
      }

      const hydratedAudio = await hydrateFrontendAudio(
        loaded.audioUrl,
        Math.min(loaded.sampleRate, MAX_FRONTEND_SAMPLE_RATE),
        signal,
      );
      if (signal.aborted) {
        return null;
      }

      const segments = hydrateEditorSegments(loaded.segments);

      return {
        ...loaded,
        segments,
        channelCount: hydratedAudio.waveform.workerChannelData.length,
        durationSec: hydratedAudio.waveform.durationSec,
        blobUrl: hydratedAudio.playbackUrl,
        workerChannelData: hydratedAudio.waveform.workerChannelData,
        waveformLevels: hydratedAudio.waveform.waveformLevels,
        waveformSampleRate: hydratedAudio.waveform.sampleRate,
        savedSegments: cloneSegments(segments),
        segmentHistory: [],
        isDirty: false,
        activeAudioView: "original",
        originalMedia: {
          audioUrl: loaded.audioUrl,
          blobUrl: hydratedAudio.playbackUrl,
          workerChannelData: hydratedAudio.waveform.workerChannelData,
          waveformLevels: hydratedAudio.waveform.waveformLevels,
          waveformSampleRate: hydratedAudio.waveform.sampleRate,
          channelCount: hydratedAudio.waveform.workerChannelData.length,
          durationSec: hydratedAudio.waveform.durationSec,
        },
      };
    },
    [bridge],
  );

  const loadHydratedDocument = useCallback(
    async (audioPath: string) => {
      const requestId = loadRequestIdRef.current + 1;
      loadRequestIdRef.current = requestId;
      loadAbortRef.current?.abort();
      const abortController = new AbortController();
      loadAbortRef.current = abortController;
      setIsLoadingDocument(true);
      setErrorMessage(null);

      try {
        const cached = cacheRef.current.get(audioPath);
        if (cached) {
          touchCache(audioPath);
          setCurrentDocument(cached);
          setTimeRange(getDefaultTimeRange(cached.durationSec));
          setFrequencyRange(getDefaultFrequencyRange(cached.waveformSampleRate));
          setSelectedChannel(0);
          setPlayheadSec(0);
          setIsPlaying(false);
          if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.src = cached.blobUrl;
            audioRef.current.load();
            audioRef.current.currentTime = 0;
            audioRef.current.playbackRate = playbackRate;
          }
          return;
        }

        const preloadingDocument = preloadingDocumentRef.current;
        const isUsingPreloadedDocument = preloadingDocument?.audioPath === audioPath;
        const document = isUsingPreloadedDocument
          ? await preloadingDocument.promise
          : await hydrateDocumentForCache(audioPath, abortController.signal);
        if (
          !document ||
          abortController.signal.aborted ||
          loadRequestIdRef.current !== requestId
        ) {
          if (document && !isUsingPreloadedDocument) {
            revokeDocumentUrls(document);
          }
          return;
        }

        cacheDocument(document);
        setCurrentDocument(document);
        setTimeRange(getDefaultTimeRange(document.durationSec));
        setFrequencyRange(getDefaultFrequencyRange(document.waveformSampleRate));
        setSelectedChannel(0);
        setPlayheadSec(0);
        setIsPlaying(false);
        setStatusMessage(`已载入 ${document.stem} 的波形与频谱`);
        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current.src = document.blobUrl;
          audioRef.current.load();
          audioRef.current.currentTime = 0;
          audioRef.current.playbackRate = playbackRate;
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setErrorMessage(error instanceof Error ? error.message : "载入音频失败");
      } finally {
        if (loadRequestIdRef.current === requestId) {
          setIsLoadingDocument(false);
          loadAbortRef.current = null;
        }
      }
    },
    [
      cacheDocument,
      hydrateDocumentForCache,
      playbackRate,
      revokeDocumentUrls,
      touchCache,
    ],
  );

  useEffect(() => {
    if (!selectedAudioPath) {
      setCurrentDocument(null);
      setSelectedSegmentKey(null);
      return;
    }

    void loadHydratedDocument(selectedAudioPath);
  }, [loadHydratedDocument, selectedAudioPath]);

  useEffect(() => {
    if (!currentDocument) {
      return;
    }

    if (!showSpectrogram) {
      spectrogramWorkerRef.current?.unloadDocument(currentDocument.audioPath);
      return;
    }

    getSpectrogramWorker().loadDocument(
      currentDocument.audioPath,
      currentDocument.workerChannelData,
      currentDocument.waveformSampleRate,
    );
  }, [
    currentDocument?.audioPath,
    currentDocument?.waveformSampleRate,
    currentDocument?.workerChannelData,
    getSpectrogramWorker,
    showSpectrogram,
  ]);

  const selectAudioPath = useCallback(
    (nextAudioPath: string) => {
      if (nextAudioPath === selectedAudioPath) {
        return;
      }

      if (currentDocument?.isDirty) {
        const shouldContinue = window.confirm(
          "当前文件有未保存修改，切换文件将保留未保存状态但不会自动保存。是否继续切换？",
        );
        if (!shouldContinue) {
          return;
        }
      }
      setSelectedAudioPath(nextAudioPath);
    },
    [
      currentDocument?.audioPath,
      currentDocument?.isDirty,
      selectedAudioPath,
    ],
  );

  const centerTreeEntry = useCallback((audioPath: string) => {
    const container = treePanelRef.current;
    if (!container) {
      return;
    }

    const target = Array.from(
      container.querySelectorAll<HTMLElement>("[data-audio-path]"),
    ).find((element) => element.dataset.audioPath === audioPath);
    if (!target) {
      return;
    }

    centerElementInScrollContainer(container, target);
  }, []);

  const handleTreeSelect = useCallback(
    (entry: CorpusEntry) => {
      if (entry.audioPath === selectedAudioPath) {
        centerTreeEntry(entry.audioPath);
        return;
      }

      selectAudioPath(entry.audioPath);
    },
    [centerTreeEntry, selectAudioPath, selectedAudioPath],
  );

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    const handleEnded = () => {
      setIsPlaying(false);
      if (currentDocument) {
        setPlayheadSec(currentDocument.durationSec);
      }
    };

    audio.addEventListener("ended", handleEnded);
    return () => {
      audio.removeEventListener("ended", handleEnded);
    };
  }, [currentDocument]);

  useEffect(() => {
    if (!isPlaying || !audioRef.current || !currentDocument) {
      return;
    }

    let frame = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (!audio) {
        return;
      }

      const nextPlayhead = clamp(audio.currentTime, 0, currentDocument.durationSec);
      setPlayheadSec(nextPlayhead);
      setTimeRange((previous) => {
        const span = previous.endSec - previous.startSec;
        const followBoundary = previous.endSec - span * 0.18;
        if (nextPlayhead <= followBoundary) {
          return previous;
        }

        return setWithinDuration(
          nextPlayhead - span * 0.18,
          nextPlayhead + span * 0.82,
          currentDocument.durationSec,
        );
      });
      frame = window.requestAnimationFrame(tick);
    };

    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [currentDocument, isPlaying]);

  const togglePlayback = useCallback(async () => {
    if (!currentDocument || !audioRef.current) {
      return;
    }

    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
      return;
    }

    audioRef.current.currentTime = clamp(
      playheadSec,
      0,
      currentDocument.durationSec,
    );
    await audioRef.current.play();
    setIsPlaying(true);
  }, [currentDocument, isPlaying, playheadSec]);

  const seekTo = useCallback(
    async (secondsValue: number, shouldPlay = false) => {
      if (!currentDocument || !audioRef.current) {
        return;
      }

      const nextPlayhead = clamp(secondsValue, 0, currentDocument.durationSec);
      setPlayheadSec(nextPlayhead);
      audioRef.current.currentTime = nextPlayhead;
      if (shouldPlay) {
        try {
          await audioRef.current.play();
          setIsPlaying(true);
        } catch {
          setIsPlaying(false);
        }
      }
    },
    [currentDocument],
  );

  const commitSavedDocument = useCallback(
    (
      audioPath: string,
      csvPath: string,
      annotationPath?: string | null,
      textGridPath?: string | null,
    ) => {
      const cachedDocument = cacheRef.current.get(audioPath);
      if (!cachedDocument) {
        return;
      }

      const nextDocument: HydratedDocument = {
        ...cachedDocument,
        csvPath,
        annotationPath: annotationPath ?? cachedDocument.annotationPath,
        textGridPath: textGridPath ?? cachedDocument.textGridPath,
        savedSegments: cloneSegments(cachedDocument.segments),
        segmentHistory: [],
        isDirty: false,
      };

      cacheDocument(nextDocument);
      if (currentDocument?.audioPath === audioPath) {
        setCurrentDocument(nextDocument);
      }
      setDirtyPaths((previous) => {
        const next = new Set(previous);
        next.delete(audioPath);
        return next;
      });
      setSavedPaths((previous) => {
        const next = new Set(previous);
        next.add(audioPath);
        return next;
      });
      setEntryOverrides((previous) => ({
        ...previous,
        [audioPath]: {
          hasAnnotation: true,
          csvPath,
          annotationPath: annotationPath ?? cachedDocument.annotationPath,
          textGridPath: textGridPath ?? cachedDocument.textGridPath,
        },
      }));
    },
    [cacheDocument, currentDocument?.audioPath],
  );

  const saveDocumentByPath = useCallback(
    async (audioPath: string) => {
      const document = cacheRef.current.get(audioPath);
      if (!document) {
        throw new Error(`缓存中找不到待保存文件：${audioPath}`);
      }

      const result = await bridge.saveAnnotation({
        audioPath: document.audioPath,
        csvPath: document.csvPath,
        annotationPath: document.annotationPath,
        textGridPath: document.textGridPath,
        segments: document.segments,
      });

      commitSavedDocument(
        audioPath,
        result.csvPath,
        result.annotationPath,
        result.textGridPath,
      );
      return {
        audioPath,
        csvPath: result.csvPath,
        stem: document.stem,
      };
    },
    [bridge, commitSavedDocument],
  );

  const saveAllDirtyDocuments = useCallback(async () => {
    const documentsByPath = new Map<string, DirtyDocumentForSave>();
    for (const audioPath of dirtyPaths) {
      const document = cacheRef.current.get(audioPath);
      if (!document) {
        continue;
      }

      documentsByPath.set(audioPath, {
        audioPath: document.audioPath,
        csvPath: document.csvPath,
        annotationPath: document.annotationPath,
        textGridPath: document.textGridPath,
        segments: document.segments,
        stem: document.stem,
      });
    }

    setIsSaving(true);
    setErrorMessage(null);

    try {
      const savedDocuments = await saveDirtyDocuments({
        dirtyPaths,
        documentsByPath,
        saveAnnotation: bridge.saveAnnotation,
        onSaved: ({ audioPath, csvPath, annotationPath, textGridPath }) => {
          commitSavedDocument(audioPath, csvPath, annotationPath, textGridPath);
        },
      });

      if (savedDocuments.length > 0) {
        setStatusMessage(
          savedDocuments.length === 1
            ? `已保存 ${savedDocuments[0]?.stem}.csv`
            : `已保存 ${savedDocuments.length} 个未保存文件`,
        );
      }

      return savedDocuments;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "保存失败");
      throw error;
    } finally {
      setIsSaving(false);
    }
  }, [bridge.saveAnnotation, commitSavedDocument, dirtyPaths]);

  const saveCurrentDocument = useCallback(async () => {
    if (!currentDocument) {
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);

    try {
      const savedDocument = await saveDocumentByPath(currentDocument.audioPath);
      setStatusMessage(`已保存 ${savedDocument.stem}.csv`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "保存失败");
    } finally {
      setIsSaving(false);
    }
  }, [currentDocument, saveDocumentByPath]);

  useEffect(() => {
    if (bridge.mode !== "electron") {
      return;
    }

    return bridge.onWindowCloseRequested(() => {
      if (closeFlowInFlightRef.current) {
        return;
      }

      closeFlowInFlightRef.current = true;
      void (async () => {
        try {
          if (dirtyPaths.size === 0) {
            await bridge.completeWindowClose();
            return;
          }

          const action = await bridge.confirmWindowClose(dirtyPaths.size);
          if (action === "cancel") {
            return;
          }

          if (action === "save-and-exit") {
            await saveAllDirtyDocuments();
          }

          await bridge.completeWindowClose();
        } catch (error) {
          setErrorMessage(error instanceof Error ? error.message : "关闭应用失败");
        } finally {
          closeFlowInFlightRef.current = false;
        }
      })();
    });
  }, [bridge, dirtyPaths, saveAllDirtyDocuments]);

  const updateSegments = useCallback(
    (updater: (segments: AnnotationSegment[]) => AnnotationSegment[]) => {
      if (!currentDocument) {
        return;
      }

      const nextSegments = hydrateEditorSegments(
        normalizeSegments(updater(currentDocument.segments)),
      );
      if (segmentsEqual(currentDocument.segments, nextSegments)) {
        return;
      }

      updateCurrentDocument((document) => ({
        ...document,
        segments: nextSegments,
        segmentHistory: [
          ...document.segmentHistory.slice(-49),
          cloneSegments(document.segments),
        ],
        isDirty: true,
      }));
      setDirtyPaths((previous) => {
        const next = new Set(previous);
        next.add(currentDocument.audioPath);
        return next;
      });
      setSavedPaths((previous) => {
        const next = new Set(previous);
        next.delete(currentDocument.audioPath);
        return next;
      });
    },
    [currentDocument, updateCurrentDocument],
  );

  const replaceSegmentsFromVad = useCallback(
    (segments: VadSegment[]) => {
      updateSegments(() =>
        segments.map((segment, index) =>
          createEmptyAnnotationSegment(segment, index),
        ),
      );
      setSelectedSegmentKey(null);
    },
    [updateSegments],
  );

  const replaceSegmentsFromAsr = useCallback(
    (segments: AnnotationSegment[]) => {
      assertNonOverlappingSegments(segments, "ASR 返回片段");
      updateSegments(() => hydrateEditorSegments(segments));
      setSelectedSegmentKey(null);
    },
    [updateSegments],
  );

  const runVadForCurrentDocument = useCallback(async () => {
    if (!currentDocument || isRunningVad) {
      return;
    }

    if (currentDocument.segments.length > 0) {
      const shouldOverwrite = window.confirm(
        "当前文件已有标注。VAD 预标注默认跳过已有结果，是否强制覆盖当前标注？",
      );
      if (!shouldOverwrite) {
        setStatusMessage(`已跳过 ${currentDocument.stem} 的 VAD 预标注`);
        return;
      }
    }

    setIsRunningVad(true);
    setErrorMessage(null);

    try {
      const segments = await bridge.runVadPreannotation({
        audioPath: currentDocument.audioPath,
        audioContentBase64:
          currentDocument.activeAudioView === "denoised"
            ? currentDocument.denoisedAudioContentBase64
            : undefined,
        vadGrpcUrl: engineConfig.vadGrpcUrl,
      });
      replaceSegmentsFromVad(segments);
      setStatusMessage(
        segments.length > 0
          ? `VAD 已生成 ${segments.length} 个预标注区间`
          : "VAD 未检测到语音区间",
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "VAD 预标注失败");
    } finally {
      setIsRunningVad(false);
    }
  }, [bridge, currentDocument, engineConfig.vadGrpcUrl, isRunningVad, replaceSegmentsFromVad]);

  const runAsrForCurrentDocument = useCallback(async () => {
    if (!currentDocument || isRunningAsr) {
      return;
    }

    if (currentDocument.segments.length > 0) {
      const shouldOverwrite = window.confirm(
        "当前文件已有标注。ASR 预标注会覆盖当前片段和转写内容，是否继续？",
      );
      if (!shouldOverwrite) {
        setStatusMessage(`已跳过 ${currentDocument.stem} 的 ASR 预标注`);
        return;
      }
    }

    let asrGrpcUrl = engineConfig.asrGrpcUrl;
    if (!asrGrpcUrl.trim() && !engineConfigDefaults.asrGrpcUrl.trim()) {
      const enteredUrl = window.prompt("请输入 ASR gRPC 地址，例如 127.0.0.1:50053");
      if (!enteredUrl?.trim()) {
        return;
      }
      asrGrpcUrl = enteredUrl.trim();
      setEngineConfig((previous) => ({ ...previous, asrGrpcUrl }));
    }

    setIsRunningAsr(true);
    setErrorMessage(null);

    try {
      const segments = await bridge.runAsrPreannotation({
        audioPath: currentDocument.audioPath,
        audioContentBase64:
          currentDocument.activeAudioView === "denoised"
            ? currentDocument.denoisedAudioContentBase64
            : undefined,
        asrGrpcUrl,
      });
      replaceSegmentsFromAsr(segments);
      const transcribedCount = segments.filter((segment) =>
        Boolean(segment.transcript?.trim()),
      ).length;
      setStatusMessage(
        segments.length > 0
          ? `ASR 已生成 ${segments.length} 个片段，${transcribedCount} 段包含转写`
          : "ASR 未返回可用转写片段",
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "ASR 预标注失败");
    } finally {
      setIsRunningAsr(false);
    }
  }, [
    bridge,
    currentDocument,
    engineConfig.asrGrpcUrl,
    engineConfigDefaults.asrGrpcUrl,
    isRunningAsr,
    replaceSegmentsFromAsr,
  ]);

  const denoiseCurrentDocument = useCallback(async () => {
    if (!currentDocument || isDenoising) {
      return;
    }

    if (currentDocument.denoisedMedia) {
      setStatusMessage(`${currentDocument.stem} 已有降噪结果，可直接切换查看`);
      showDenoisedAudio();
      return;
    }

    setIsDenoising(true);
    setErrorMessage(null);

    try {
      const result = await bridge.denoiseAudio({
        audioPath: currentDocument.audioPath,
        denoiseGrpcUrl: engineConfig.denoiseGrpcUrl,
      });
      const hydratedAudio = await hydrateFrontendAudio(
        result.audioUrl,
        Math.min(result.sampleRate, MAX_FRONTEND_SAMPLE_RATE),
      );
      const denoisedMedia = {
        audioUrl: result.audioUrl,
        blobUrl: hydratedAudio.playbackUrl,
        workerChannelData: hydratedAudio.waveform.workerChannelData,
        waveformLevels: hydratedAudio.waveform.waveformLevels,
        waveformSampleRate: hydratedAudio.waveform.sampleRate,
        channelCount: hydratedAudio.waveform.workerChannelData.length,
        durationSec: hydratedAudio.waveform.durationSec,
      };

      const nextDocument: HydratedDocument = {
        ...currentDocument,
        audioUrl: denoisedMedia.audioUrl,
        channelCount: denoisedMedia.channelCount,
        durationSec: denoisedMedia.durationSec,
        blobUrl: denoisedMedia.blobUrl,
        workerChannelData: denoisedMedia.workerChannelData,
        waveformLevels: denoisedMedia.waveformLevels,
        waveformSampleRate: denoisedMedia.waveformSampleRate,
        denoisedAudioContentBase64: result.audioContentBase64,
        activeAudioView: "denoised",
        denoisedMedia,
      };

      cacheDocument(nextDocument);
      setCurrentDocument(nextDocument);
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = nextDocument.blobUrl;
        audioRef.current.load();
        audioRef.current.currentTime = 0;
        audioRef.current.playbackRate = playbackRate;
      }
      setPlayheadSec(0);
      setIsPlaying(false);
      setTimeRange(getDefaultTimeRange(nextDocument.durationSec));
      setFrequencyRange(getDefaultFrequencyRange(nextDocument.waveformSampleRate));
      setSelectedChannel(0);
      setStatusMessage(`已切换到 ${currentDocument.stem} 的临时降噪音频`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "降噪失败");
    } finally {
      setIsDenoising(false);
    }
  }, [
    bridge,
    cacheDocument,
    currentDocument,
    engineConfig.denoiseGrpcUrl,
    isDenoising,
    playbackRate,
    showDenoisedAudio,
  ]);

  const getDenoiseActionLabel = useCallback(() => {
    if (isDenoising) {
      return "降噪中";
    }
    if (!currentDocument?.denoisedMedia) {
      return "降噪";
    }
    return currentDocument.activeAudioView === "denoised"
      ? "显示原始音频"
      : "显示降噪音频";
  }, [currentDocument, isDenoising]);

  const handleDenoiseAction = useCallback(async () => {
    if (!currentDocument || isDenoising) {
      return;
    }
    if (!currentDocument.denoisedMedia) {
      await denoiseCurrentDocument();
      return;
    }
    if (currentDocument.activeAudioView === "denoised") {
      showOriginalAudio();
      return;
    }
    showDenoisedAudio();
  }, [
    currentDocument,
    denoiseCurrentDocument,
    isDenoising,
    showDenoisedAudio,
    showOriginalAudio,
  ]);

  const undoLastChange = useCallback(() => {
    if (!currentDocument || currentDocument.segmentHistory.length === 0) {
      return;
    }

    const previousSegments =
      currentDocument.segmentHistory[currentDocument.segmentHistory.length - 1];
    updateCurrentDocument((document) => ({
      ...document,
      segments: cloneSegments(previousSegments),
      segmentHistory: document.segmentHistory.slice(0, -1),
      isDirty: !segmentsEqual(previousSegments, document.savedSegments),
    }));
    setDirtyPaths((previous) => {
      const next = new Set(previous);
      if (segmentsEqual(previousSegments, currentDocument.savedSegments)) {
        next.delete(currentDocument.audioPath);
      } else {
        next.add(currentDocument.audioPath);
      }
      return next;
    });
    setSavedPaths((previous) => {
      const next = new Set(previous);
      next.delete(currentDocument.audioPath);
      return next;
    });
  }, [currentDocument, updateCurrentDocument]);

  const discardCurrentChanges = useCallback(() => {
    if (!currentDocument || !currentDocument.isDirty) {
      return;
    }

    updateCurrentDocument((document) => ({
      ...document,
      segments: cloneSegments(document.savedSegments),
      segmentHistory: [],
      isDirty: false,
    }));
    setDirtyPaths((previous) => {
      const next = new Set(previous);
      next.delete(currentDocument.audioPath);
      return next;
    });
    setSavedPaths((previous) => {
      const next = new Set(previous);
      next.delete(currentDocument.audioPath);
      return next;
    });
    setStatusMessage(`已舍弃 ${currentDocument.stem} 的未保存更改`);
  }, [currentDocument, updateCurrentDocument]);

  const adjustSegment = useCallback(
    (segmentIndex: number, segment: VadSegment) => {
      updateSegments((segments) => {
        const previous = segments[segmentIndex];
        return replaceSegment(
          segments,
          segmentIndex,
          previous ? { ...previous, ...segment } : segment,
        );
      });
    },
    [updateSegments],
  );

  const updateSegmentTranscript = useCallback(
    (segmentIndex: number, transcript: string) => {
      updateSegments((segments) =>
        segments.map((segment, index) =>
          index === segmentIndex ? { ...segment, transcript } : segment,
        ),
      );
    },
    [updateSegments],
  );

  const deleteSegmentAtIndex = useCallback(
    (segmentIndex: number) => {
      updateSegments((segments) =>
        segments.filter((_, index) => index !== segmentIndex),
      );
      setSelectedSegmentKey(null);
    },
    [updateSegments],
  );

  const mergeSegmentWithPrevious = useCallback(
    (segmentIndex: number) => {
      if (segmentIndex <= 0) {
        return;
      }

      updateSegments((segments) => {
        const previous = segments[segmentIndex - 1];
        const current = segments[segmentIndex];
        if (!previous || !current) {
          return segments;
        }

        const mergedTranscript = [
          previous.transcript?.trim(),
          current.transcript?.trim(),
        ]
          .filter(Boolean)
          .join(" ");

        const mergedSegment: AnnotationSegment = {
          ...previous,
          endSec: Math.max(previous.endSec, current.endSec),
          transcript: mergedTranscript,
        };

        return [
          ...segments.slice(0, segmentIndex - 1),
          mergedSegment,
          ...segments.slice(segmentIndex + 1),
        ];
      });
      setSelectedSegmentKey(null);
    },
    [updateSegments],
  );

  const listServerDirectoryForDialog = useCallback(
    (path?: string) => bridge.listServerDirectory(path),
    [bridge],
  );

  const allEntries = useMemo(() => (tree ? flattenEntries(tree) : []), [tree]);

  const filteredTree = useMemo(() => {
    if (!tree) {
      return null;
    }

    const queryFilteredTree = filterTree(tree, searchQuery);
    if (!queryFilteredTree) {
      return null;
    }

    return filterTreeByState(queryFilteredTree, (entry) =>
      matchesFileFilter(
        getEntryState(entry, dirtyPaths, savedPaths, entryOverrides),
        fileFilter,
      ),
    );
  }, [dirtyPaths, entryOverrides, fileFilter, savedPaths, searchQuery, tree]);

  const visibleEntries = useMemo(
    () => (filteredTree ? flattenEntries(filteredTree) : []),
    [filteredTree],
  );
  const annotatedEntries = useMemo(
    () =>
      allEntries.filter(
        (entry) => entryOverrides[entry.audioPath]?.hasAnnotation ?? entry.hasAnnotation,
      ),
    [allEntries, entryOverrides],
  );
  const datasetIsUsable = datasetState === "ready" || datasetState === "empty";

  const exportAudioFolder = useCallback(async () => {
    if (!datasetIsUsable || !rootPath || annotatedEntries.length === 0 || isExporting) {
      return;
    }

    const dirtyAnnotatedCount = annotatedEntries.filter((entry) =>
      dirtyPaths.has(entry.audioPath),
    ).length;
    if (dirtyAnnotatedCount > 0) {
      const shouldContinue = window.confirm(
        `当前有 ${dirtyAnnotatedCount} 个已标注文件存在未保存修改，导出不会包含这些更改。是否继续导出磁盘上已有的 CSV？`,
      );
      if (!shouldContinue) {
        return;
      }
    }

    setIsExporting(true);
    setErrorMessage(null);

    try {
      const result = await bridge.exportAudioFolder({
        rootPath,
        audioPaths: annotatedEntries.map((entry) => entry.audioPath),
        splitName: "test",
      });
      if (result.canceled) {
        setStatusMessage("已取消导出 AudioFolder");
        return;
      }

      setStatusMessage(
        bridge.mode === "electron" && result.savedPath
          ? `已导出 ${result.exportedCount} 个已标注音频到 ${result.savedPath}`
          : `已导出 ${result.exportedCount} 个已标注音频到 AudioFolder zip`,
      );
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "导出 AudioFolder 失败",
      );
    } finally {
      setIsExporting(false);
    }
  }, [annotatedEntries, bridge, datasetIsUsable, dirtyPaths, isExporting, rootPath]);

  const fileStats = useMemo(() => {
    return allEntries.reduce(
      (summary, entry) => {
        const state = getEntryState(entry, dirtyPaths, savedPaths, entryOverrides);
        summary.all += 1;
        if (state === "new") {
          summary.pending += 1;
        } else if (state === "dirty") {
          summary.dirty += 1;
        } else {
          summary.done += 1;
        }
        return summary;
      },
      { all: 0, pending: 0, dirty: 0, done: 0 },
    );
  }, [allEntries, dirtyPaths, entryOverrides, savedPaths]);

  const selectedEntryIndex = useMemo(
    () =>
      selectedAudioPath
        ? visibleEntries.findIndex((entry) => entry.audioPath === selectedAudioPath)
        : -1,
    [selectedAudioPath, visibleEntries],
  );

  const selectedEntry = useMemo(
    () =>
      selectedAudioPath
        ? allEntries.find((entry) => entry.audioPath === selectedAudioPath) ?? null
        : null,
    [allEntries, selectedAudioPath],
  );

  useEffect(() => {
    if (!selectedAudioPath) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      centerTreeEntry(selectedAudioPath);
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [centerTreeEntry, selectedAudioPath, visibleEntries]);

  const previousEntry =
    selectedEntryIndex > 0 ? visibleEntries[selectedEntryIndex - 1] : null;
  const nextEntry =
    selectedEntryIndex >= 0 && selectedEntryIndex < visibleEntries.length - 1
      ? visibleEntries[selectedEntryIndex + 1]
      : null;

  useEffect(() => {
    const nextAudioPath = nextEntry?.audioPath;
    if (!nextAudioPath || cacheRef.current.has(nextAudioPath)) {
      return;
    }

    const nextDurationSec = nextEntry.audioMeta.durationSec;
    if (
      !Number.isFinite(nextDurationSec) ||
      nextDurationSec > MAX_AUTO_PRELOAD_DURATION_SEC
    ) {
      return;
    }

    const abortController = new AbortController();
    preloadAbortRef.current = abortController;
    let didStartPreload = false;
    const timer = window.setTimeout(() => {
      if (abortController.signal.aborted || cacheRef.current.has(nextAudioPath)) {
        return;
      }

      didStartPreload = true;
      const promise = hydrateDocumentForCache(
        nextAudioPath,
        abortController.signal,
      );
      preloadingDocumentRef.current = {
        audioPath: nextAudioPath,
        promise,
      };

      void promise
        .then((document) => {
          if (
            !document ||
            abortController.signal.aborted ||
            cacheRef.current.has(nextAudioPath)
          ) {
            if (document && !cacheRef.current.has(nextAudioPath)) {
              revokeDocumentUrls(document);
            }
            return;
          }

          cacheDocument(document);
        })
        .catch(() => {
          // Preload failures should not interrupt the active labeling flow.
        })
        .finally(() => {
          if (preloadingDocumentRef.current?.audioPath === nextAudioPath) {
            preloadingDocumentRef.current = null;
          }
          if (preloadAbortRef.current === abortController) {
            preloadAbortRef.current = null;
          }
        });
    }, 450);

    return () => {
      window.clearTimeout(timer);
      if (!didStartPreload) {
        abortController.abort();
        if (preloadAbortRef.current === abortController) {
          preloadAbortRef.current = null;
        }
      }
    };
  }, [
    cacheDocument,
    hydrateDocumentForCache,
    nextEntry?.audioMeta.durationSec,
    nextEntry?.audioPath,
    revokeDocumentUrls,
  ]);

  useEffect(() => {
    if (!isHelpOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setIsHelpOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isHelpOpen]);

  useEffect(() => {
    if (!isEngineSettingsOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setIsEngineSettingsOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isEngineSettingsOpen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isHelpOpen || isDirectoryBrowserOpen || isEngineSettingsOpen) {
        return;
      }

      const target = event.target as HTMLElement | null;
      const isTypingTarget =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveCurrentDocument();
        return;
      }

      if (isTypingTarget) {
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undoLastChange();
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        void togglePlayback();
        return;
      }

      if (!event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveCurrentDocument();
        return;
      }

      if (event.key === "ArrowLeft" && currentDocument) {
        event.preventDefault();
        const span = timeRange.endSec - timeRange.startSec;
        const delta = Math.max(span * 0.12, MIN_TIME_WINDOW_SEC * 0.5);
        setTimeRange((previous) =>
          setWithinDuration(
            previous.startSec - delta,
            previous.endSec - delta,
            currentDocument.durationSec,
          ),
        );
        return;
      }

      if (event.key === "ArrowRight" && currentDocument) {
        event.preventDefault();
        const span = timeRange.endSec - timeRange.startSec;
        const delta = Math.max(span * 0.12, MIN_TIME_WINDOW_SEC * 0.5);
        setTimeRange((previous) =>
          setWithinDuration(
            previous.startSec + delta,
            previous.endSec + delta,
            currentDocument.durationSec,
          ),
        );
        return;
      }

      if (event.key === "ArrowUp") {
        const candidate =
          selectedEntryIndex > 0 ? visibleEntries[selectedEntryIndex - 1] : null;
        if (candidate) {
          event.preventDefault();
          selectAudioPath(candidate.audioPath);
        }
        return;
      }

      if (event.key === "ArrowDown") {
        const candidate =
          selectedEntryIndex >= 0 && selectedEntryIndex < visibleEntries.length - 1
            ? visibleEntries[selectedEntryIndex + 1]
            : null;
        if (candidate) {
          event.preventDefault();
          selectAudioPath(candidate.audioPath);
        }
        return;
      }

      if (event.key.toLowerCase() === "m") {
        setHeldTool("mark");
        return;
      }

      if (event.key.toLowerCase() === "e") {
        setHeldTool("erase");
        return;
      }

      if (event.key.toLowerCase() === "v") {
        setHeldTool(null);
        return;
      }

      if (event.key.toLowerCase() === "x") {
        setFrequencyScale(getNextFrequencyScale);
        return;
      }

      if (event.key.toLowerCase() === "r") {
        setPlaybackRate((previous) => getNextPlaybackRate(previous));
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    isHelpOpen,
    isDirectoryBrowserOpen,
    isEngineSettingsOpen,
    undoLastChange,
    currentDocument,
    saveCurrentDocument,
    selectedEntryIndex,
    selectAudioPath,
    timeRange.endSec,
    timeRange.startSec,
    togglePlayback,
    visibleEntries,
  ]);

  const currentNyquist = currentDocument ? currentDocument.waveformSampleRate / 2 : 8000;
  const currentSegments = currentDocument?.segments ?? [];
  const savedSegments = currentDocument?.savedSegments ?? [];
  const transcribedSegmentCount = currentSegments.filter((segment) =>
    Boolean(segment.transcript?.trim()),
  ).length;
  const segmentOverlayGroups = useMemo(
    () => getSegmentOverlayGroups(savedSegments, currentSegments),
    [currentSegments, savedSegments],
  );
  const currentState = selectedEntry
    ? getEntryState(selectedEntry, dirtyPaths, savedPaths, entryOverrides)
    : null;
  const selectedSegment = useMemo(
    () =>
      selectedSegmentKey
        ? currentSegments.find((segment) => getSegmentKey(segment) === selectedSegmentKey) ?? null
        : null,
    [currentSegments, selectedSegmentKey],
  );

  useEffect(() => {
    if (!selectedSegmentKey) {
      return;
    }

    if (!currentSegments.some((segment) => getSegmentKey(segment) === selectedSegmentKey)) {
      setSelectedSegmentKey(null);
    }
  }, [currentSegments, selectedSegmentKey]);

  useEffect(() => {
    if (selectedSegment) {
      setIsInspectorOpen(true);
    }
  }, [selectedSegment]);

  const selectedAllEntryIndex = selectedAudioPath
    ? allEntries.findIndex((entry) => entry.audioPath === selectedAudioPath)
    : -1;
  const currentStateLabel = currentState ? getEntryStateLabel(currentState) : "未选择";
  const selectedSegmentIndex = selectedSegment
    ? currentSegments.findIndex(
        (segment) => getSegmentKey(segment) === getSegmentKey(selectedSegment),
      )
    : null;
  const selectedFileContext =
    currentDocument && selectedAllEntryIndex >= 0
      ? {
          index: selectedAllEntryIndex,
          total: allEntries.length,
          stateLabel: currentStateLabel,
        }
      : null;
  const workbenchMode: WorkbenchMode =
    datasetState === "invalid"
      ? "invalid-directory"
      : datasetState === "none" || datasetState === "scanning" || !rootPath || !tree
        ? "no-directory"
        : datasetState === "empty" || fileStats.all === 0
          ? "empty-directory"
          : currentDocument
            ? "ready"
            : "no-selection";
  const taskQueueTree = fileStats.all === 0 ? null : filteredTree;
  const statusBarViewModel: StatusBarViewModel = {
    timeLabel: currentDocument
      ? `${formatSeconds(playheadSec)} / ${formatSeconds(currentDocument.durationSec)}`
      : "0:00.00 / 0:00.00",
    chips: currentDocument
      ? [
          `标注段 ${currentSegments.length}`,
          `已转写 ${transcribedSegmentCount}`,
          isSaving ? "保存中" : currentDocument.isDirty ? "未保存" : "已保存",
          currentStateLabel,
          currentDocument.denoisedMedia
            ? currentDocument.activeAudioView === "denoised"
              ? "降噪音频"
              : "原始音频"
            : null,
          showSpectrogram ? "语谱图开启" : "语谱图关闭",
          `采样率 ${currentDocument.sampleRate} Hz · ${currentDocument.channelCount} 通道`,
          "快捷键",
        ].filter((chip): chip is string => Boolean(chip))
      : [
          workbenchMode === "invalid-directory"
            ? "数据集目录不可用"
            : workbenchMode === "no-directory"
              ? datasetState === "scanning"
                ? "正在扫描目录"
                : "尚未打开工作目录"
              : workbenchMode === "empty-directory"
                ? "当前目录无可标注音频"
                : "请选择左侧音频",
          "快捷键",
        ],
    message:
      errorMessage ??
      (workbenchMode === "invalid-directory"
        ? datasetErrorMessage ?? "当前数据集目录不可用"
        : workbenchMode === "no-directory"
          ? datasetState === "scanning"
            ? "正在扫描目录"
            : "尚未打开工作目录"
          : workbenchMode === "empty-directory"
            ? "当前目录无可标注音频"
            : workbenchMode === "no-selection"
              ? "请选择左侧音频"
              : statusMessage),
    isError: Boolean(errorMessage),
  };

  const editorContent = currentDocument ? (
    <>
      <WaveformPanel
        document={currentDocument}
        waveformTheme={waveformTheme}
        timeRange={timeRange}
        playheadSec={playheadSec}
        segments={currentSegments}
        overlayGroups={segmentOverlayGroups}
        heldTool={heldTool}
        onSeek={seekTo}
        onSetTimeRange={(startSec, endSec) =>
          setTimeRange(
            setWithinDuration(
              startSec,
              endSec,
              currentDocument.durationSec,
            ),
          )
        }
        onWheelZoom={(centerSec, factor) => {
          setTimeRange((previous) => {
            const span = previous.endSec - previous.startSec;
            const nextSpan = clamp(
              span * factor,
              MIN_TIME_WINDOW_SEC,
              currentDocument.durationSec,
            );
            return setWithinDuration(
              centerSec - (centerSec - previous.startSec) * (nextSpan / span),
              centerSec + (previous.endSec - centerSec) * (nextSpan / span),
              currentDocument.durationSec,
            );
          });
        }}
        onCommitSegment={(segment) =>
          updateSegments((segments) =>
            heldTool === "erase"
              ? eraseSegment(segments, segment)
              : addSegment(segments, segment),
          )
        }
        onAdjustSegment={adjustSegment}
        onSelectSegment={(segment) =>
          setSelectedSegmentKey(segment ? getSegmentKey(segment) : null)
        }
      />
      {showSpectrogram ? (
        <>
          <div
            className="editor-resizer"
            onPointerDown={(event) => {
              const rect = editorRef.current?.getBoundingClientRect();
              if (!rect) {
                return;
              }

              editorResizeRef.current = {
                startY: event.clientY,
                startHeight: waveformHeight,
                containerHeight: rect.height,
              };
              document.body.style.userSelect = "none";
              document.body.style.cursor = "ns-resize";
            }}
          />

          <div className="spectrogram-shell">
            <div className="spectrogram-header paper-spectrogram-header">
              <div className="channel-picker">
                {Array.from({ length: currentDocument.channelCount }, (_, index) => (
                  <button
                    key={index}
                    className={
                      index === selectedChannel
                        ? "channel-chip active"
                        : "channel-chip"
                    }
                    onClick={() => setSelectedChannel(index)}
                  >
                    {currentDocument.channelLabels?.[index] ?? `声道 ${index + 1}`}
                  </button>
                ))}
              </div>
            </div>

            <SpectrogramPanel
              worker={spectrogramWorkerRef.current}
              document={currentDocument}
              selectedChannel={selectedChannel}
              timeRange={timeRange}
              frequencyRange={frequencyRange}
              frequencyScale={frequencyScale as never}
              playheadSec={playheadSec}
              segments={currentSegments}
              overlayGroups={segmentOverlayGroups}
              heldTool={heldTool}
              canvasTheme={canvasTheme}
              onSeek={seekTo}
              onSetTimeRange={(startSec, endSec) =>
                setTimeRange(
                  setWithinDuration(
                    startSec,
                    endSec,
                    currentDocument.durationSec,
                  ),
                )
              }
              onSetFrequencyRange={(minFreq, maxFreq) =>
                setFrequencyRange(
                  setWithinNyquist(minFreq, maxFreq, currentNyquist),
                )
              }
              onCommitSegment={(segment) =>
                updateSegments((segments) =>
                  heldTool === "erase"
                    ? eraseSegment(segments, segment)
                    : addSegment(segments, segment),
                )
              }
              onAdjustSegment={adjustSegment}
              onSelectSegment={(segment) =>
                setSelectedSegmentKey(segment ? getSegmentKey(segment) : null)
              }
            />
          </div>
        </>
      ) : null}
    </>
  ) : null;

  return (
    <div
      className={
        isSidebarCollapsed
          ? "app-shell paper-shell sidebar-collapsed"
          : "app-shell paper-shell"
      }
      style={
        {
          ...uiThemeStyle,
          "--app-bg": "var(--paper-bg)",
          "--body-top": "var(--paper-bg)",
          "--body-radial": "rgba(255, 255, 255, 0)",
          "--panel-bg": "var(--paper-surface)",
          "--panel-bg-strong": "var(--paper-surface)",
          "--panel-border": "var(--paper-line)",
          "--canvas-border": "var(--paper-line)",
          "--text-primary": "var(--paper-text)",
          "--text-secondary": "var(--paper-muted)",
          "--text-tertiary": "var(--paper-faint)",
          "--accent": "var(--paper-accent)",
          "--accent-soft": "var(--paper-accent-soft)",
          "--danger": "var(--paper-danger)",
          "--shadow": "none",
          "--sidebar-width": `${sidebarWidth}px`,
          "--waveform-height": `${waveformHeight}px`,
        } as CSSProperties
      }
    >
      <TaskQueue
        rootPath={rootPath}
        datasetState={datasetState}
        datasetErrorMessage={datasetErrorMessage}
        tree={taskQueueTree}
        stats={fileStats}
        isSidebarCollapsed={isSidebarCollapsed}
        searchQuery={searchQuery}
        fileFilter={fileFilter}
        selectedAudioPath={selectedAudioPath}
        dirtyPaths={dirtyPaths}
        savedPaths={savedPaths}
        entryOverrides={entryOverrides}
        isScanning={isScanning}
        treePanelRef={treePanelRef}
        importDirectoryInputRef={importDirectoryInputRef}
        onOpenDirectory={() => void openDirectory()}
        onImportDirectory={handleImportDirectory}
        onImportDirectoryChange={handleImportDirectoryChange}
        onRefreshDirectory={() => {
          if (rootPath) {
            void scanDirectory(rootPath);
          }
        }}
        onClearRememberedDirectory={clearRememberedDirectory}
        onToggleSidebar={() => setIsSidebarCollapsed((previous) => !previous)}
        onSearchQueryChange={setSearchQuery}
        onFileFilterChange={setFileFilter}
        onClearFilters={() => {
          setSearchQuery("");
          setFileFilter("all");
        }}
        onSelectEntry={handleTreeSelect}
      />
      <div
        className="sidebar-resizer"
        onPointerDown={(event) => {
          if (isSidebarCollapsed) {
            return;
          }
          sidebarResizeRef.current = {
            startX: event.clientX,
            startWidth: sidebarWidth,
          };
          document.body.style.userSelect = "none";
          document.body.style.cursor = "ew-resize";
        }}
      />
      <MainWorkbench
        mode={workbenchMode}
        rootPath={rootPath}
        datasetErrorMessage={datasetErrorMessage}
        currentDocument={currentDocument}
        selectedFileContext={selectedFileContext}
        selectedSegment={selectedSegment}
        selectedSegmentIndex={
          selectedSegmentIndex === null || selectedSegmentIndex < 0
            ? null
            : selectedSegmentIndex
        }
        previousEntry={previousEntry}
        nextEntry={nextEntry}
        isLoadingDocument={isLoadingDocument}
        isSaving={isSaving}
        isRunningVad={isRunningVad}
        isRunningAsr={isRunningAsr}
        isDenoising={isDenoising}
        isPlaying={isPlaying}
        heldTool={heldTool}
        frequencyScale={frequencyScale}
        playbackRate={playbackRate}
        denoiseActionLabel={getDenoiseActionLabel()}
        isInspectorOpen={Boolean(currentDocument && isInspectorOpen)}
        showSpectrogram={showSpectrogram}
        editorRef={editorRef}
        onOpenDirectory={() => void openDirectory()}
        onImportDirectory={handleImportDirectory}
        onClearRememberedDirectory={clearRememberedDirectory}
        onSelectPrevious={() =>
          previousEntry ? selectAudioPath(previousEntry.audioPath) : undefined
        }
        onSelectNext={() =>
          nextEntry ? selectAudioPath(nextEntry.audioPath) : undefined
        }
        onSaveCurrent={() => void saveCurrentDocument()}
        onRunVad={() => void runVadForCurrentDocument()}
        onRunAsr={() => void runAsrForCurrentDocument()}
        onDenoise={() => void handleDenoiseAction()}
        onTogglePlayback={() => void togglePlayback()}
        onCycleTool={() => setHeldTool((previous) => getNextTool(previous))}
        onToggleFrequencyScale={() =>
          setFrequencyScale(getNextFrequencyScale)
        }
        onCyclePlaybackRate={() =>
          setPlaybackRate((previous) => getNextPlaybackRate(previous))
        }
        moreActions={
          <MoreActionsMenu
            canDiscardChanges={Boolean(
              currentDocument?.isDirty &&
                !isSaving &&
                !isRunningVad &&
                !isRunningAsr &&
                !isDenoising,
            )}
            canExportDataset={Boolean(
              datasetIsUsable && rootPath && annotatedEntries.length > 0 && !isExporting,
            )}
            canUndo={Boolean(currentDocument?.segmentHistory.length && !isRunningAsr)}
            isExporting={isExporting}
            showSpectrogram={showSpectrogram}
            uiThemePreference={uiThemePreference}
            onDiscardChanges={discardCurrentChanges}
            onExportDataset={() => void exportAudioFolder()}
            onOpenEngineSettings={() => setIsEngineSettingsOpen(true)}
            onOpenHelp={() => setIsHelpOpen(true)}
            onUndo={undoLastChange}
            onToggleSpectrogram={() => {
              setShowSpectrogram((previous) => {
                if (previous) {
                  return false;
                }

                getSpectrogramWorker();
                return true;
              });
            }}
            onThemeChange={setUiThemePreference}
          />
        }
        inspector={
          <RightInspector
            isOpen={Boolean(currentDocument && isInspectorOpen)}
            currentDocument={currentDocument}
            selectedSegment={selectedSegment}
            selectedSegmentIndex={
              selectedSegmentIndex === null || selectedSegmentIndex < 0
                ? null
                : selectedSegmentIndex
            }
            currentStateLabel={currentStateLabel}
            onTranscriptChange={updateSegmentTranscript}
            onDeleteSegment={deleteSegmentAtIndex}
            onMergeSegmentWithPrevious={mergeSegmentWithPrevious}
            onToggle={() => setIsInspectorOpen((previous) => !previous)}
          />
        }
        statusBar={<BottomStatusBar viewModel={statusBarViewModel} />}
      >
        {editorContent}
      </MainWorkbench>

      {isHelpOpen ? (
        <HelpDialog
          sections={HELP_SECTIONS}
          onClose={() => setIsHelpOpen(false)}
        />
      ) : null}

      {isDirectoryBrowserOpen ? (
        <ServerDirectoryPickerDialog
          initialPath={datasetState === "invalid" ? "" : rootPath}
          listDirectory={listServerDirectoryForDialog}
          onSelect={(path) => {
            setIsDirectoryBrowserOpen(false);
            void scanDirectory(path);
          }}
          onClose={() => setIsDirectoryBrowserOpen(false)}
        />
      ) : null}

      {isEngineSettingsOpen ? (
        <EngineSettingsDialog
          value={engineConfig}
          defaults={engineConfigDefaults}
          onTest={(engine, grpcUrl) =>
            bridge.testEngineConnection({ engine, grpcUrl })
          }
          onSave={(nextConfig) => {
            setEngineConfig((previous) => ({ ...previous, ...nextConfig }));
            setIsEngineSettingsOpen(false);
            setStatusMessage("已保存引擎地址配置");
          }}
          onClose={() => setIsEngineSettingsOpen(false)}
        />
      ) : null}
    </div>
  );
}
