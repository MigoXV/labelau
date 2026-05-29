import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from "react";
import { hydrateAudio } from "svara-ui/audio";
import { ServerDirectoryBrowserDialog } from "svara-ui";
import {
  buildUiThemeStyle,
  DirectoryTreeView,
  EngineSettingsDialog,
  getCanvasTheme,
  getWaveformTheme,
  HelpDialog,
  Metric,
  resolveUiThemeMode,
  centerElementInScrollContainer,
  cloneSegments,
  formatSeconds,
  getDefaultFrequencyRange,
  getDefaultTimeRange,
  getNextPlaybackRate,
  getNextTool,
  getSegmentKey,
  getSegmentOverlayGroups,
  getToolLabel,
  segmentsEqual,
  setWithinDuration,
  setWithinNyquist,
  SpectrogramPanel,
  ThemeControl,
  WaveformPanel,
  type EngineConfig,
  type UiThemePreference,
  useSystemTheme,
} from "svara-ui/labelau";

import { getHostBridge } from "./bridge";
import {
  saveDirtyDocuments,
  type DirtyDocumentForSave,
} from "./close-flow";
import { HELP_SECTIONS } from "../shared/help-content";
import { SpectrogramWorkerClient } from "./worker-client";
import { MIN_TIME_WINDOW_SEC } from "../shared/constants";
import type {
  CorpusEntry,
  CorpusEntryTree,
  FrequencyScale,
  HostBridge,
  VadSegment,
} from "../shared/contracts";
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

const EMPTY_ENGINE_CONFIG: EngineConfig = {
  vadGrpcUrl: "",
  denoiseGrpcUrl: "",
};
const DOCUMENT_CACHE_LIMIT = 8;
const STORAGE_KEYS = {
  engineConfig: "engine-config",
  rootPath: "root-path",
  sidebarWidth: "sidebar-width",
  uiTheme: "ui-theme",
  waveformHeight: "waveform-height",
} as const;
const SUMMARY_TILE_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: "4px",
  padding: "10px 8px",
};
const SUMMARY_TILE_LABEL_STYLE: CSSProperties = {
  width: "100%",
  textAlign: "center",
  whiteSpace: "nowrap",
  fontSize: "0.78rem",
};

function readStoredEngineConfig(): EngineConfig {
  const parsedValue = readStoredJson<Partial<EngineConfig>>(
    STORAGE_KEYS.engineConfig,
    EMPTY_ENGINE_CONFIG,
  );
  return {
    vadGrpcUrl:
      typeof parsedValue.vadGrpcUrl === "string" ? parsedValue.vadGrpcUrl : "",
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
  const importDirectoryInputRef = useRef<HTMLInputElement | null>(null);
  const spectrogramWorkerRef = useRef<SpectrogramWorkerClient | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const cacheRef = useRef(new Map<string, HydratedDocument>());
  const lruRef = useRef<string[]>([]);
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
  const [tree, setTree] = useState<CorpusEntryTree | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [fileFilter, setFileFilter] = useState<FileFilter>("all");
  const [selectedAudioPath, setSelectedAudioPath] = useState<string | null>(null);
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
  const [isDenoising, setIsDenoising] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("等待打开目录");
  const [heldTool, setHeldTool] = useState<HeldTool>(null);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isDirectoryBrowserOpen, setIsDirectoryBrowserOpen] = useState(false);
  const [isEngineSettingsOpen, setIsEngineSettingsOpen] = useState(false);
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

  const revokeDocumentUrls = useCallback((document: HydratedDocument) => {
    const blobUrls = new Set<string>([
      document.blobUrl,
      document.originalMedia.blobUrl,
    ]);
    if (document.denoisedMedia) {
      blobUrls.add(document.denoisedMedia.blobUrl);
    }
    for (const blobUrl of blobUrls) {
      URL.revokeObjectURL(blobUrl);
    }
  }, []);

  useEffect(() => {
    writeStoredString(STORAGE_KEYS.uiTheme, uiThemePreference);
  }, [uiThemePreference]);

  useEffect(() => {
    writeStoredJson(STORAGE_KEYS.engineConfig, engineConfig);
  }, [engineConfig]);

  useEffect(() => {
    writeStoredString(STORAGE_KEYS.rootPath, rootPath);
  }, [rootPath]);

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
    spectrogramWorkerRef.current = new SpectrogramWorkerClient();
    audioRef.current = new Audio();
    audioRef.current.preload = "auto";

    return () => {
      loadAbortRef.current?.abort();
      spectrogramWorkerRef.current?.dispose();
      audioRef.current?.pause();
      for (const document of cacheRef.current.values()) {
        revokeDocumentUrls(document);
      }
    };
  }, [revokeDocumentUrls]);

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
      spectrogramWorkerRef.current?.loadDocument(
        currentDocument.audioPath,
        media.workerChannelData,
        media.waveformSampleRate,
      );
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
    async (nextRootPath: string) => {
      setIsScanning(true);
      setErrorMessage(null);

      try {
        const { tree: nextTree, warnings } = await bridge.scanDirectory(nextRootPath);
        const flattened = flattenEntries(nextTree);

        setTree(nextTree);
        setRootPath(nextRootPath);
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
        setErrorMessage(error instanceof Error ? error.message : "扫描目录失败");
      } finally {
        setIsScanning(false);
      }
    },
    [bridge, selectedAudioPath],
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

  const importAudioFiles = useCallback(
    async (files: File[], onProgress?: (progressPercent: number) => void) => {
      if (!rootPath) {
        throw new Error("请先打开或输入一个服务器目录");
      }

      const result = await bridge.importAudioFiles(rootPath, files, onProgress);
      setStatusMessage(result.message);
      await scanDirectory(result.rootPath);
      return result;
    },
    [bridge, rootPath, scanDirectory],
  );

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
          spectrogramWorkerRef.current?.loadDocument(
            cached.audioPath,
            cached.workerChannelData,
            cached.waveformSampleRate,
          );
          if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.src = cached.blobUrl;
            audioRef.current.load();
            audioRef.current.currentTime = 0;
            audioRef.current.playbackRate = playbackRate;
          }
          return;
        }

        const loaded = await bridge.loadDocument(audioPath);
        const hydratedAudio = await hydrateAudio(
          loaded.audioUrl,
          loaded.sampleRate,
          abortController.signal,
        );
        if (abortController.signal.aborted || loadRequestIdRef.current !== requestId) {
          URL.revokeObjectURL(hydratedAudio.blobUrl);
          return;
        }
        const document: HydratedDocument = {
          ...loaded,
          channelCount: hydratedAudio.waveform.workerChannelData.length,
          durationSec: hydratedAudio.waveform.durationSec,
          blobUrl: hydratedAudio.blobUrl,
          workerChannelData: hydratedAudio.waveform.workerChannelData,
          waveformLevels: hydratedAudio.waveform.waveformLevels,
          waveformSampleRate: hydratedAudio.waveform.sampleRate,
          savedSegments: cloneSegments(loaded.segments),
          segmentHistory: [],
          isDirty: false,
          activeAudioView: "original",
          originalMedia: {
            audioUrl: loaded.audioUrl,
            blobUrl: hydratedAudio.blobUrl,
            workerChannelData: hydratedAudio.waveform.workerChannelData,
            waveformLevels: hydratedAudio.waveform.waveformLevels,
            waveformSampleRate: hydratedAudio.waveform.sampleRate,
            channelCount: hydratedAudio.waveform.workerChannelData.length,
            durationSec: hydratedAudio.waveform.durationSec,
          },
        };

        cacheDocument(document);
        spectrogramWorkerRef.current?.loadDocument(
          document.audioPath,
          hydratedAudio.waveform.workerChannelData,
          document.waveformSampleRate,
        );
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
    [bridge, cacheDocument, playbackRate, touchCache],
  );

  useEffect(() => {
    if (!selectedAudioPath) {
      setCurrentDocument(null);
      setSelectedSegmentKey(null);
      return;
    }

    void loadHydratedDocument(selectedAudioPath);
  }, [loadHydratedDocument, selectedAudioPath]);

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
    (audioPath: string, csvPath: string) => {
      const cachedDocument = cacheRef.current.get(audioPath);
      if (!cachedDocument) {
        return;
      }

      const nextDocument: HydratedDocument = {
        ...cachedDocument,
        csvPath,
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
        segments: document.segments,
      });

      commitSavedDocument(audioPath, result.csvPath);
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
        onSaved: ({ audioPath, csvPath }) => {
          commitSavedDocument(audioPath, csvPath);
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
    (updater: (segments: VadSegment[]) => VadSegment[]) => {
      if (!currentDocument) {
        return;
      }

      const nextSegments = normalizeSegments(updater(currentDocument.segments));
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
      updateSegments(() => segments);
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
      const hydratedAudio = await hydrateAudio(result.audioUrl, result.sampleRate);
      const denoisedMedia = {
        audioUrl: result.audioUrl,
        blobUrl: hydratedAudio.blobUrl,
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
      spectrogramWorkerRef.current?.loadDocument(
        nextDocument.audioPath,
        hydratedAudio.waveform.workerChannelData,
        nextDocument.waveformSampleRate,
      );
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
      updateSegments((segments) => replaceSegment(segments, segmentIndex, segment));
    },
    [updateSegments],
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

  const exportAudioFolder = useCallback(async () => {
    if (!rootPath || annotatedEntries.length === 0 || isExporting) {
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
  }, [annotatedEntries, bridge, dirtyPaths, isExporting, rootPath]);

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
        setFrequencyScale((previous) =>
          previous === "linear" ? "log" : "linear",
        );
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

  return (
    <div
      className="app-shell"
      style={
        {
          ...uiThemeStyle,
          "--sidebar-width": `${sidebarWidth}px`,
          "--waveform-height": `${waveformHeight}px`,
        } as CSSProperties
      }
    >
      <aside className="sidebar">
        <div className="sidebar-header">
          <div>
            <h1>LabelAU</h1>
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: "10px",
            alignItems: "stretch",
          }}
        >
          <button className="action-button" onClick={() => void openDirectory()}>
            打开
          </button>
          <button
            className="action-button"
            disabled={!rootPath || isScanning}
            onClick={handleImportDirectory}
          >
            导入
          </button>
          <button
            className="action-button"
            disabled={!rootPath || isScanning}
            onClick={() => void scanDirectory(rootPath)}
          >
            刷新
          </button>
        </div>
        <input
          ref={importDirectoryInputRef}
          type="file"
          hidden
          accept=".wav,.flac,.mp3"
          multiple
          {...({ webkitdirectory: "" } as Record<string, string>)}
          onChange={handleImportDirectoryChange}
        />

        <div className="path-card" style={{ paddingTop: "18px" }}>
          <div className="path-row">
            <code>{rootPath || "未选择目录"}</code>
          </div>
        </div>

        <label className="search-field">
          <span>搜索文件</span>
          <input
            placeholder="按文件名或目录筛选"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </label>

        <div className="filter-panel">
          <div className="filter-header">
            <div className="filter-header-copy">
              <span className="label">任务筛选</span>
              <span className="filter-count">{fileStats.all} 个文件</span>
            </div>
          </div>
          <div className="summary-grid">
            <button
              type="button"
              className={
                fileFilter === "pending"
                  ? "summary-tile summary-tile-active"
                  : "summary-tile"
              }
              style={SUMMARY_TILE_STYLE}
              onClick={() =>
                setFileFilter((previous) =>
                  previous === "pending" ? "all" : "pending",
                )
              }
            >
              <span style={SUMMARY_TILE_LABEL_STYLE}>未处理</span>
              <strong style={{ fontSize: "1.1rem", lineHeight: 1 }}>
                {fileStats.pending}
              </strong>
            </button>
            <button
              type="button"
              className={
                fileFilter === "dirty"
                  ? "summary-tile summary-tile-active"
                  : "summary-tile"
              }
              style={SUMMARY_TILE_STYLE}
              onClick={() =>
                setFileFilter((previous) =>
                  previous === "dirty" ? "all" : "dirty",
                )
              }
            >
              <span style={SUMMARY_TILE_LABEL_STYLE}>未保存</span>
              <strong style={{ fontSize: "1.1rem", lineHeight: 1 }}>
                {fileStats.dirty}
              </strong>
            </button>
            <button
              type="button"
              className={
                fileFilter === "done"
                  ? "summary-tile summary-tile-active"
                  : "summary-tile"
              }
              style={SUMMARY_TILE_STYLE}
              onClick={() =>
                setFileFilter((previous) =>
                  previous === "done" ? "all" : "done",
                )
              }
            >
              <span style={SUMMARY_TILE_LABEL_STYLE}>已处理</span>
              <strong style={{ fontSize: "1.1rem", lineHeight: 1 }}>
                {fileStats.done}
              </strong>
            </button>
          </div>
        </div>

        <div ref={treePanelRef} className="tree-panel">
          {filteredTree ? (
            <DirectoryTreeView
              tree={filteredTree}
              selectedAudioPath={selectedAudioPath}
              dirtyPaths={dirtyPaths}
              savedPaths={savedPaths}
              entryOverrides={entryOverrides}
              onSelect={handleTreeSelect}
            />
          ) : (
            <div className="empty-state">
              <h2>{rootPath ? "没有匹配结果" : "等待目录"}</h2>
              <p>
                {rootPath
                  ? "调整搜索词或任务筛选，查看当前目录下的可标注音频。"
                  : "打开目录后，系统会递归扫描 WAV、FLAC、MP3，并自动匹配同目录同 stem 的 Audition CSV。"}
              </p>
            </div>
          )}
        </div>
      </aside>
      <div
        className="sidebar-resizer"
        onPointerDown={(event) => {
          sidebarResizeRef.current = {
            startX: event.clientX,
            startWidth: sidebarWidth,
          };
          document.body.style.userSelect = "none";
          document.body.style.cursor = "ew-resize";
        }}
      />

      <main className="workspace">
        <header className="workspace-header">
          <div className="toolbar toolbar-primary">
            <div className="toolbar-title">
              <h2>
                {currentDocument?.stem ??
                  (rootPath ? "请从左侧选择音频" : "开始音频标注")}
              </h2>
              {!currentDocument ? (
                <p className="toolbar-subtitle">
                  {rootPath
                    ? "左侧文件列表会展示当前目录下可工作的音频文件。"
                    : "先打开一个包含 WAV、FLAC 或 MP3 文件的目录，系统会自动恢复已有标注。"}
                </p>
              ) : null}
            </div>

            <div className="toolbar-actions">
              <button
                className="ghost-button"
                onClick={() => setIsEngineSettingsOpen(true)}
              >
                引擎设置
              </button>
              <button className="ghost-button" onClick={() => setIsHelpOpen(true)}>
                帮助
              </button>
              <button
                className="ghost-button"
                disabled={!previousEntry}
                onClick={() => previousEntry && selectAudioPath(previousEntry.audioPath)}
              >
                上一条
              </button>
              <button
                className="ghost-button"
                disabled={!nextEntry}
                onClick={() => nextEntry && selectAudioPath(nextEntry.audioPath)}
              >
                下一条
              </button>
              <button
                className="action-button"
                disabled={!currentDocument || isRunningVad || isDenoising}
                onClick={() => void runVadForCurrentDocument()}
              >
                {isRunningVad ? "预标注中" : "VAD 预标注"}
              </button>
              <button
                className="ghost-button"
                disabled={!currentDocument || isDenoising || isRunningVad}
                onClick={() => void handleDenoiseAction()}
              >
                {getDenoiseActionLabel()}
              </button>
              <button
                className="action-button"
                disabled={!currentDocument || isRunningVad || isDenoising}
                onClick={() => void togglePlayback()}
              >
                {isPlaying ? "暂停" : "播放"}
              </button>
              <button
                className="ghost-button"
                disabled={!currentDocument?.isDirty || isSaving || isRunningVad || isDenoising}
                onClick={() => discardCurrentChanges()}
              >
                舍弃更改
              </button>
              <button
                className={
                  currentDocument?.isDirty
                    ? "action-button action-button-attention"
                    : "action-button secondary"
                }
                disabled={!currentDocument || isSaving}
                onClick={() => void saveCurrentDocument()}
              >
                保存 CSV
              </button>
              <button
                className="ghost-button"
                disabled={!rootPath || annotatedEntries.length === 0 || isExporting}
                onClick={() => void exportAudioFolder()}
              >
                {isExporting ? "导出中" : "导出 AudioFolder"}
              </button>
            </div>
          </div>

          <div className="toolbar toolbar-secondary">
            <div className="toolbar-controls">
              <button
                className="ghost-button toolbar-toggle"
                disabled={!currentDocument}
                onClick={() => setHeldTool((previous) => getNextTool(previous))}
              >
                工具：{getToolLabel(heldTool)}
              </button>
              <button
                className="ghost-button toolbar-toggle"
                disabled={!currentDocument}
                onClick={() =>
                  setFrequencyScale((previous) =>
                    previous === "linear" ? "log" : "linear",
                  )
                }
              >
                缩放：{frequencyScale === "linear" ? "线性" : "对数"}
              </button>
              <button
                className="ghost-button toolbar-toggle"
                disabled={!currentDocument}
                onClick={() =>
                  setPlaybackRate((previous) => getNextPlaybackRate(previous))
                }
              >
                倍速：{playbackRate}x
              </button>
            </div>

            <div className="toolbar-metrics">
              <Metric
                label="状态"
                value={currentState ? getEntryStateLabel(currentState) : "待开始"}
              />
              {selectedSegment ? (
                <>
                  <Metric label="起始" value={formatSeconds(selectedSegment.startSec)} />
                  <Metric
                    label="持续"
                    value={formatSeconds(selectedSegment.endSec - selectedSegment.startSec)}
                  />
                  <Metric label="结束" value={formatSeconds(selectedSegment.endSec)} />
                </>
              ) : null}
            </div>

            <ThemeControl
              value={uiThemePreference}
              onChange={setUiThemePreference}
            />
          </div>
        </header>

        <section ref={editorRef} className="editor">
          {currentDocument ? (
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
                <div className="spectrogram-header">
                  <div className="channel-picker">
                    {Array.from({ length: currentDocument.channelCount }, (_, index) => (
                      <button
                        key={index}
                        className={index === selectedChannel ? "channel-chip active" : "channel-chip"}
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
                  frequencyScale={frequencyScale}
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
          ) : (
            <div className="editor-empty">
              {!rootPath ? (
                <div className="empty-state-card">
                  <p className="eyebrow">开始工作</p>
                  <h2>开始音频标注</h2>
                  <p>
                    先打开一个包含 WAV、FLAC 或 MP3 文件的目录，系统将自动扫描同名 CSV 并恢复已有标注。
                  </p>
                  <button
                    className="action-button"
                    onClick={() => void openDirectory()}
                  >
                    打开目录
                  </button>
                </div>
              ) : (
                <div className="empty-state-card">
                  <p className="eyebrow">下一步</p>
                  <h2>请选择一个音频文件</h2>
                  <p>从左侧文件列表选择音频后，即可开始播放、标注和保存结果。</p>
                </div>
              )}
            </div>
          )}
        </section>

        <footer className="status-bar">
          <div className="status-group">
            <span className="status-chip">
              {currentDocument
                ? `${formatSeconds(playheadSec)} / ${formatSeconds(currentDocument.durationSec)}`
                : "0:00.00 / 0:00.00"}
            </span>
          </div>

          <div className="status-group">
            <span className="status-chip">
              标注段 {currentSegments.length}
            </span>
            {currentDocument?.isDirty ? (
              <span className="status-chip">有未保存修改</span>
            ) : null}
            {currentDocument?.denoisedMedia ? (
              <span className="status-chip">
                当前显示：
                {currentDocument.activeAudioView === "denoised"
                  ? "降噪音频"
                  : "原始音频"}
              </span>
            ) : null}
            {currentDocument ? (
              <span className="status-chip">
                采样率 {currentDocument.sampleRate} Hz · {currentDocument.channelCount} 通道
              </span>
            ) : null}
            <span className="status-chip">空格 播放 · S 保存 · M 标注 · E 擦除</span>
          </div>

          {errorMessage ? <span className="error-text">{errorMessage}</span> : <span>{statusMessage}</span>}
        </footer>
      </main>

      {isHelpOpen ? (
        <HelpDialog
          sections={HELP_SECTIONS}
          onClose={() => setIsHelpOpen(false)}
        />
      ) : null}

      {isDirectoryBrowserOpen ? (
        <ServerDirectoryBrowserDialog
          isOpen={isDirectoryBrowserOpen}
          initialPath={rootPath}
          listDirectory={(path) => bridge.listServerDirectory(path)}
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
            setEngineConfig(nextConfig);
            setIsEngineSettingsOpen(false);
            setStatusMessage("已保存引擎地址配置");
          }}
          onClose={() => setIsEngineSettingsOpen(false)}
        />
      ) : null}
    </div>
  );
}
