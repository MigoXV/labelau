import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { hydrateAudio } from "./audio";
import { getHostBridge } from "./bridge";
import {
  saveDirtyDocuments,
  type DirtyDocumentForSave,
} from "./close-flow";
import { HELP_SECTIONS } from "../shared/help-content";
import {
  buildUiThemeStyle,
  getCanvasTheme,
  getWaveformTheme,
  resolveUiThemeMode,
  type UiThemePreference,
  useSystemTheme,
} from "./theme";
import { useElementSize } from "./use-element-size";
import { SpectrogramWorkerClient } from "./worker-client";
import {
  MIN_FREQ_WINDOW_HZ,
  MIN_TIME_WINDOW_SEC,
  MAX_SPECTROGRAM_RENDER_HEIGHT,
  MAX_SPECTROGRAM_RENDER_WIDTH,
  SPECTROGRAM_RENDER_SCALE,
} from "../shared/constants";
import type { WaveformLevel } from "./audio";
import type {
  CorpusDirectory,
  CorpusEntry,
  CorpusEntryTree,
  FrequencyScale,
  HostBridge,
  LoadedAudioDocument,
  VadSegment,
} from "../shared/contracts";
import { clamp, lerp } from "../shared/math";
import { filterTree, flattenEntries } from "../shared/tree";
import {
  addSegment,
  eraseSegment,
  normalizeSegments,
  replaceSegment,
} from "../shared/vad";

type HeldTool = "mark" | "erase" | null;
type EntryState = "dirty" | "saved" | "matched" | "new";
type FileFilter = "all" | "pending" | "dirty" | "done";
type SegmentHitPart = "body" | "start" | "end";
type PlaybackRate = 1 | 2 | 3 | 4;

interface HydratedDocument extends LoadedAudioDocument {
  blobUrl: string;
  waveformLevels: WaveformLevel[][];
  waveformSampleRate: number;
  savedSegments: VadSegment[];
  segmentHistory: VadSegment[][];
  isDirty: boolean;
}

interface TimeRange {
  startSec: number;
  endSec: number;
}

interface FrequencyRange {
  minFreq: number;
  maxFreq: number;
}

interface EntryOverlayState {
  hasAnnotation: boolean;
  csvPath: string | null;
}

interface SegmentHit {
  index: number;
  part: SegmentHitPart;
  segment: VadSegment;
}

interface SegmentOverlayStyle {
  fillStyle: string;
  outlineStyle: string;
  edgeStyle: string;
}

interface SegmentOverlayGroups {
  saved: VadSegment[];
  unsaved: VadSegment[];
}

function getDefaultTimeRange(durationSec: number): TimeRange {
  return {
    startSec: 0,
    endSec: durationSec,
  };
}

function getDefaultFrequencyRange(sampleRate: number): FrequencyRange {
  return {
    minFreq: 0,
    maxFreq: sampleRate / 2,
  };
}

function getEntryState(
  entry: CorpusEntry,
  dirtyPaths: Set<string>,
  savedPaths: Set<string>,
  overrides: Record<string, EntryOverlayState>,
): EntryState {
  if (dirtyPaths.has(entry.audioPath)) {
    return "dirty";
  }

  if (savedPaths.has(entry.audioPath)) {
    return "saved";
  }

  const overlay = overrides[entry.audioPath];
  return overlay?.hasAnnotation ?? entry.hasAnnotation ? "matched" : "new";
}

function getEntryStateLabel(state: EntryState): string {
  switch (state) {
    case "dirty":
      return "未保存";
    case "saved":
      return "已保存";
    case "matched":
      return "已导入";
    case "new":
      return "未处理";
  }
}

function matchesFileFilter(state: EntryState, filter: FileFilter): boolean {
  switch (filter) {
    case "pending":
      return state === "new";
    case "dirty":
      return state === "dirty";
    case "done":
      return state === "matched" || state === "saved";
    case "all":
      return true;
  }
}

function filterTreeByState(
  tree: CorpusDirectory,
  predicate: (entry: CorpusEntry) => boolean,
): CorpusDirectory | null {
  const entries = tree.entries.filter(predicate);
  const directories = tree.directories
    .map((directory) => filterTreeByState(directory, predicate))
    .filter((directory): directory is CorpusDirectory => Boolean(directory));

  if (entries.length === 0 && directories.length === 0) {
    return null;
  }

  return {
    ...tree,
    entries,
    directories,
  };
}

function getDisplayCsvPath(
  entry: CorpusEntry,
  overrides: Record<string, EntryOverlayState>,
): string | null {
  return overrides[entry.audioPath]?.csvPath ?? entry.csvPath;
}

function centerElementInScrollContainer(
  container: HTMLElement,
  target: HTMLElement,
): void {
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const nextScrollTop =
    container.scrollTop +
    (targetRect.top - containerRect.top) -
    container.clientHeight / 2 +
    target.clientHeight / 2;
  container.scrollTo({
    top: Math.max(0, nextScrollTop),
    behavior: "smooth",
  });
}

function findDirectoryPathChain(
  node: CorpusDirectory,
  audioPath: string,
  trail: string[] = [],
): string[] | null {
  if (node.entries.some((entry) => entry.audioPath === audioPath)) {
    return trail;
  }

  for (const directory of node.directories) {
    const nextTrail = directory.relativePath
      ? [...trail, directory.relativePath]
      : trail;
    const match = findDirectoryPathChain(directory, audioPath, nextTrail);
    if (match) {
      return match;
    }
  }

  return null;
}

function setWithinDuration(
  startSec: number,
  endSec: number,
  durationSec: number,
): TimeRange {
  const span = clamp(endSec - startSec, MIN_TIME_WINDOW_SEC, durationSec);
  let nextStart = clamp(startSec, 0, Math.max(durationSec - span, 0));
  let nextEnd = nextStart + span;

  if (nextEnd > durationSec) {
    nextEnd = durationSec;
    nextStart = Math.max(0, nextEnd - span);
  }

  return {
    startSec: nextStart,
    endSec: nextEnd,
  };
}

function setWithinNyquist(
  minFreq: number,
  maxFreq: number,
  nyquist: number,
): FrequencyRange {
  const span = clamp(maxFreq - minFreq, MIN_FREQ_WINDOW_HZ, nyquist);
  let nextMin = clamp(minFreq, 0, Math.max(nyquist - span, 0));
  let nextMax = nextMin + span;

  if (nextMax > nyquist) {
    nextMax = nyquist;
    nextMin = Math.max(0, nextMax - span);
  }

  return {
    minFreq: nextMin,
    maxFreq: nextMax,
  };
}

function formatSeconds(value: number): string {
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return `${minutes}:${seconds.toFixed(2).padStart(5, "0")}`;
}

function formatFrequencyLabel(value: number): string {
  if (value >= 1000) {
    const kiloHertz = value / 1000;
    return `${Number.isInteger(kiloHertz) ? kiloHertz.toFixed(0) : kiloHertz.toFixed(1)} kHz`;
  }

  return `${Math.round(value)} Hz`;
}

function frequencyForCanvasRow(
  row: number,
  height: number,
  minFreq: number,
  maxFreq: number,
  scale: FrequencyScale,
): number {
  const alpha = 1 - row / Math.max(height - 1, 1);
  if (scale === "log") {
    const safeMin = Math.max(minFreq, 1);
    const minLog = Math.log10(safeMin);
    const maxLog = Math.log10(Math.max(maxFreq, safeMin + 1));
    return 10 ** lerp(minLog, maxLog, alpha);
  }

  return lerp(minFreq, maxFreq, alpha);
}

function getSecondsForClientX(
  clientX: number,
  rect: DOMRect,
  timeRange: TimeRange,
): number {
  const alpha = clamp((clientX - rect.left) / rect.width, 0, 1);
  return timeRange.startSec + alpha * (timeRange.endSec - timeRange.startSec);
}

function getNextTool(current: HeldTool): HeldTool {
  if (current === null) {
    return "mark";
  }

  if (current === "mark") {
    return "erase";
  }

  return null;
}

function getToolLabel(tool: HeldTool): string {
  if (tool === "mark") {
    return "M 标注";
  }

  if (tool === "erase") {
    return "E 擦除";
  }

  return "拖拽平移";
}

function getNextPlaybackRate(current: PlaybackRate): PlaybackRate {
  if (current === 1) {
    return 2;
  }

  if (current === 2) {
    return 3;
  }

  if (current === 3) {
    return 4;
  }

  return 1;
}

function getSegmentHit(
  secondsValue: number,
  width: number,
  timeRange: TimeRange,
  segments: VadSegment[],
): SegmentHit | null {
  const span = Math.max(timeRange.endSec - timeRange.startSec, MIN_TIME_WINDOW_SEC);
  const edgeThresholdSec = (10 / Math.max(width, 1)) * span;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (secondsValue < segment.startSec || secondsValue > segment.endSec) {
      continue;
    }

    const startDistance = Math.abs(secondsValue - segment.startSec);
    const endDistance = Math.abs(secondsValue - segment.endSec);
    const isNearStart = startDistance <= edgeThresholdSec;
    const isNearEnd = endDistance <= edgeThresholdSec;

    if (isNearStart || isNearEnd) {
      return {
        index,
        part: startDistance <= endDistance ? "start" : "end",
        segment,
      };
    }

    return { index, part: "body", segment };
  }

  return null;
}

function cloneSegments(segments: VadSegment[]): VadSegment[] {
  return segments.map((segment) => ({ ...segment }));
}

function segmentsEqual(left: VadSegment[], right: VadSegment[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (
      left[index].startSec !== right[index].startSec ||
      left[index].endSec !== right[index].endSec
    ) {
      return false;
    }
  }

  return true;
}

function getSegmentKey(segment: VadSegment): string {
  return `${segment.startSec}:${segment.endSec}`;
}

function getSegmentOverlayGroups(
  savedSegments: VadSegment[],
  currentSegments: VadSegment[],
): SegmentOverlayGroups {
  const savedKeys = new Set(savedSegments.map(getSegmentKey));
  const currentKeys = new Set(currentSegments.map(getSegmentKey));

  return {
    saved: savedSegments.filter((segment) =>
      currentKeys.has(getSegmentKey(segment)),
    ),
    unsaved: currentSegments.filter(
      (segment) => !savedKeys.has(getSegmentKey(segment)),
    ),
  };
}

export function App() {
  const bridge = useMemo<HostBridge>(() => getHostBridge(), []);
  const themeMode = useSystemTheme();
  const canvasTheme = useMemo(() => getCanvasTheme(themeMode), [themeMode]);
  const [uiThemePreference, setUiThemePreference] = useState<UiThemePreference>(() => {
    if (typeof window === "undefined") {
      return "system";
    }

    const savedValue = window.localStorage.getItem("labelau-ui-theme");
    return savedValue === "light" || savedValue === "dark" || savedValue === "system"
      ? savedValue
      : "system";
  });
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

  const [rootPath, setRootPath] = useState("");
  const [tree, setTree] = useState<CorpusEntryTree | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [fileFilter, setFileFilter] = useState<FileFilter>("all");
  const [selectedAudioPath, setSelectedAudioPath] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [waveformHeight, setWaveformHeight] = useState(256);
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
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("等待打开目录");
  const [heldTool, setHeldTool] = useState<HeldTool>(null);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(() => new Set());
  const [savedPaths, setSavedPaths] = useState<Set<string>>(() => new Set());
  const [entryOverrides, setEntryOverrides] = useState<
    Record<string, EntryOverlayState>
  >({});
  const loadRequestIdRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const closeFlowInFlightRef = useRef(false);

  useEffect(() => {
    window.localStorage.setItem("labelau-ui-theme", uiThemePreference);
  }, [uiThemePreference]);

  useEffect(() => {
    spectrogramWorkerRef.current = new SpectrogramWorkerClient();
    audioRef.current = new Audio();
    audioRef.current.preload = "auto";

    return () => {
      loadAbortRef.current?.abort();
      spectrogramWorkerRef.current?.dispose();
      audioRef.current?.pause();
      for (const document of cacheRef.current.values()) {
        URL.revokeObjectURL(document.blobUrl);
      }
    };
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

      while (lruRef.current.length > 3) {
        const evictedPath = lruRef.current.shift();
        if (!evictedPath || evictedPath === document.audioPath) {
          continue;
        }

        const evicted = cacheRef.current.get(evictedPath);
        if (!evicted || evicted.isDirty) {
          touchCache(evictedPath);
          break;
        }

        URL.revokeObjectURL(evicted.blobUrl);
        cacheRef.current.delete(evictedPath);
        spectrogramWorkerRef.current?.unloadDocument(evictedPath);
      }
    },
    [touchCache],
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
    const pickedPath = await bridge.pickDirectory();
    if (!pickedPath) {
      return;
    }

    await scanDirectory(pickedPath);
  }, [bridge, scanDirectory]);

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
          waveformLevels: hydratedAudio.waveform.waveformLevels,
          waveformSampleRate: hydratedAudio.waveform.sampleRate,
          savedSegments: cloneSegments(loaded.segments),
          segmentHistory: [],
          isDirty: false,
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
    [currentDocument?.isDirty, selectedAudioPath],
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
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isHelpOpen) {
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
          <button className="action-button" onClick={() => void openDirectory()}>
            打开目录
          </button>
        </div>

        <div className="path-card">
          <span className="label">目录</span>
          <div className="path-row">
            <code>{rootPath || "未选择目录"}</code>
            <button
              className="ghost-button"
              disabled={!rootPath || isScanning}
              onClick={() => void scanDirectory(rootPath)}
            >
              刷新
            </button>
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
              onClick={() =>
                setFileFilter((previous) =>
                  previous === "pending" ? "all" : "pending",
                )
              }
            >
              <span>未处理</span>
              <strong>{fileStats.pending}</strong>
            </button>
            <button
              type="button"
              className={
                fileFilter === "dirty"
                  ? "summary-tile summary-tile-active"
                  : "summary-tile"
              }
              onClick={() =>
                setFileFilter((previous) =>
                  previous === "dirty" ? "all" : "dirty",
                )
              }
            >
              <span>未保存</span>
              <strong>{fileStats.dirty}</strong>
            </button>
            <button
              type="button"
              className={
                fileFilter === "done"
                  ? "summary-tile summary-tile-active"
                  : "summary-tile"
              }
              onClick={() =>
                setFileFilter((previous) =>
                  previous === "done" ? "all" : "done",
                )
              }
            >
              <span>已处理</span>
              <strong>{fileStats.done}</strong>
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
                disabled={!currentDocument}
                onClick={() => void togglePlayback()}
              >
                {isPlaying ? "暂停" : "播放"}
              </button>
              <button
                className="ghost-button"
                disabled={!currentDocument?.isDirty || isSaving}
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
                  onWheelZoom={(centerFreq, factor) => {
                    setFrequencyRange((previous) => {
                      const span = previous.maxFreq - previous.minFreq;
                      const nextSpan = clamp(
                        span * factor,
                        MIN_FREQ_WINDOW_HZ,
                        currentNyquist,
                      );
                      return setWithinNyquist(
                        centerFreq - (centerFreq - previous.minFreq) * (nextSpan / span),
                        centerFreq + (previous.maxFreq - centerFreq) * (nextSpan / span),
                        currentNyquist,
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
        <div
          className="help-overlay"
          onClick={() => setIsHelpOpen(false)}
          role="presentation"
        >
          <section
            className="help-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="help-dialog-header">
              <div>
                <p className="eyebrow">客户帮助</p>
                <h2 id="help-dialog-title">使用说明</h2>
              </div>
              <button className="ghost-button" onClick={() => setIsHelpOpen(false)}>
                关闭
              </button>
            </div>

            <div className="help-dialog-body">
              {HELP_SECTIONS.map((section) => (
                <section key={section.title} className="help-section">
                  <h3>{section.title}</h3>
                  {section.paragraphs?.map((paragraph) => (
                    <p key={paragraph}>{paragraph}</p>
                  ))}
                  {section.bullets ? (
                    <ul>
                      {section.bullets.map((bullet) => (
                        <li key={bullet}>{bullet}</li>
                      ))}
                    </ul>
                  ) : null}
                </section>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ThemeControl({
  value,
  onChange,
}: {
  value: UiThemePreference;
  onChange: (value: UiThemePreference) => void;
}) {
  return (
    <div className="theme-control">
      <span>主题</span>
      <div className="theme-segmented">
        {(["system", "light", "dark"] as const).map((option) => (
          <button
            key={option}
            type="button"
            className={value === option ? "theme-option active" : "theme-option"}
            onClick={() => onChange(option)}
          >
            {option === "system" ? "跟随系统" : option === "light" ? "浅色" : "深色"}
          </button>
        ))}
      </div>
    </div>
  );
}

function DirectoryTreeView({
  tree,
  selectedAudioPath,
  dirtyPaths,
  savedPaths,
  entryOverrides,
  onSelect,
}: {
  tree: CorpusDirectory;
  selectedAudioPath: string | null;
  dirtyPaths: Set<string>;
  savedPaths: Set<string>;
  entryOverrides: Record<string, EntryOverlayState>;
  onSelect: (entry: CorpusEntry) => void;
}) {
  const [collapsedDirectories, setCollapsedDirectories] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    if (!selectedAudioPath) {
      return;
    }

    const expandedChain = findDirectoryPathChain(tree, selectedAudioPath);
    if (!expandedChain || expandedChain.length === 0) {
      return;
    }

    setCollapsedDirectories((previous) => {
      let changed = false;
      const next = new Set(previous);
      for (const path of expandedChain) {
        if (next.delete(path)) {
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [selectedAudioPath, tree]);

  const toggleDirectory = useCallback((relativePath: string) => {
    setCollapsedDirectories((previous) => {
      const next = new Set(previous);
      if (next.has(relativePath)) {
        next.delete(relativePath);
      } else {
        next.add(relativePath);
      }
      return next;
    });
  }, []);

  return (
    <div className="directory-tree">
      <div className="directory-heading">资源管理器</div>
      <DirectoryNode
        node={tree}
        depth={0}
        selectedAudioPath={selectedAudioPath}
        dirtyPaths={dirtyPaths}
        savedPaths={savedPaths}
        entryOverrides={entryOverrides}
        collapsedDirectories={collapsedDirectories}
        onToggleDirectory={toggleDirectory}
        onSelect={onSelect}
      />
    </div>
  );
}

function DirectoryNode({
  node,
  depth,
  selectedAudioPath,
  dirtyPaths,
  savedPaths,
  entryOverrides,
  collapsedDirectories,
  onToggleDirectory,
  onSelect,
}: {
  node: CorpusDirectory;
  depth: number;
  selectedAudioPath: string | null;
  dirtyPaths: Set<string>;
  savedPaths: Set<string>;
  entryOverrides: Record<string, EntryOverlayState>;
  collapsedDirectories: Set<string>;
  onToggleDirectory: (relativePath: string) => void;
  onSelect: (entry: CorpusEntry) => void;
}) {
  const isRoot = depth === 0;
  const relativePath = node.relativePath || node.name;
  const isCollapsed = !isRoot && collapsedDirectories.has(relativePath);

  return (
    <div className="directory-node">
      {!isRoot ? (
        <button
          type="button"
          className="directory-button"
          style={{ paddingLeft: `${depth * 14}px` }}
          onClick={() => onToggleDirectory(relativePath)}
        >
          <span className={isCollapsed ? "directory-caret" : "directory-caret expanded"}>
            ▸
          </span>
          <span className="directory-name">{node.name}</span>
        </button>
      ) : null}

      {!isCollapsed &&
        node.entries.map((entry) => {
        const badge = getEntryState(entry, dirtyPaths, savedPaths, entryOverrides);
        return (
          <button
            key={entry.audioPath}
            data-audio-path={entry.audioPath}
            className={
              entry.audioPath === selectedAudioPath
                ? "tree-entry active"
                : "tree-entry"
            }
            style={{ paddingLeft: `${depth * 14 + (isRoot ? 10 : 28)}px` }}
            onClick={() => onSelect(entry)}
          >
            <div className="tree-entry-main">
              <strong>{entry.stem}</strong>
            </div>
            <div className="entry-meta">
              <span className={`badge ${badge}`}>{getEntryStateLabel(badge)}</span>
            </div>
          </button>
        );
      })}

      {!isCollapsed &&
        node.directories.map((directory) => (
        <DirectoryNode
          key={directory.relativePath || directory.name}
          node={directory}
          depth={depth + 1}
          selectedAudioPath={selectedAudioPath}
          dirtyPaths={dirtyPaths}
          savedPaths={savedPaths}
          entryOverrides={entryOverrides}
          collapsedDirectories={collapsedDirectories}
          onToggleDirectory={onToggleDirectory}
          onSelect={onSelect}
        />
        ))}
    </div>
  );
}

function WaveformPanel({
  document,
  waveformTheme,
  timeRange,
  playheadSec,
  segments,
  overlayGroups,
  heldTool,
  onSeek,
  onSetTimeRange,
  onWheelZoom,
  onCommitSegment,
  onAdjustSegment,
  onSelectSegment,
}: {
  document: HydratedDocument;
  waveformTheme: ReturnType<typeof getWaveformTheme>;
  timeRange: TimeRange;
  playheadSec: number;
  segments: VadSegment[];
  overlayGroups: SegmentOverlayGroups;
  heldTool: HeldTool;
  onSeek: (secondsValue: number, shouldPlay?: boolean) => void;
  onSetTimeRange: (startSec: number, endSec: number) => void;
  onWheelZoom: (centerSec: number, factor: number) => void;
  onCommitSegment: (segment: VadSegment) => void;
  onAdjustSegment: (segmentIndex: number, segment: VadSegment) => void;
  onSelectSegment: (segment: VadSegment | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overviewRef = useRef<HTMLDivElement | null>(null);
  const overviewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{
    mode: "pan" | "edit" | "resize";
    startX: number;
    originRange: TimeRange;
    selectionStartSec: number;
    clickedSegmentStartSec?: number;
    resizeEdge?: "start" | "end";
    segmentIndex?: number;
    sourceSegment?: VadSegment;
  } | null>(null);
  const overviewDragRef = useRef<{
    pointerId: number;
    anchorOffsetSec: number;
  } | null>(null);
  const [ghostSegment, setGhostSegment] = useState<VadSegment | null>(null);
  const [cursor, setCursor] = useState<"default" | "ew-resize">("default");
  const size = useElementSize(containerRef.current);
  const overviewSize = useElementSize(overviewRef.current);
  const channelHeight = Math.max(size.height / Math.max(document.channelCount, 1), 1);
  const visibleSpan = timeRange.endSec - timeRange.startSec;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width === 0 || size.height === 0) {
      return;
    }

    const devicePixelRatio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(size.width * devicePixelRatio);
    canvas.height = Math.floor(size.height * devicePixelRatio);
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    context.clearRect(0, 0, size.width, size.height);
    context.fillStyle = waveformTheme.background;
    context.fillRect(0, 0, size.width, size.height);

    document.waveformLevels.forEach((channelLevels, index) => {
      const top = index * channelHeight;
      context.fillStyle = index % 2 === 0 ? waveformTheme.laneEven : waveformTheme.laneOdd;
      context.fillRect(0, top, size.width, channelHeight);
      drawWaveform(
        context,
        channelLevels,
        timeRange,
        document.waveformSampleRate,
        size.width,
        channelHeight,
        top,
        waveformTheme.waveform,
      );
    });

    drawSegmentOverlay(
      context,
      overlayGroups.saved,
      timeRange,
      size.width,
      size.height,
      {
        fillStyle: waveformTheme.overlayBase,
        outlineStyle: waveformTheme.overlayBaseEdge,
        edgeStyle: waveformTheme.overlayBaseEdge,
      },
    );
    if (overlayGroups.unsaved.length > 0) {
      drawSegmentOverlay(
        context,
        overlayGroups.unsaved,
        timeRange,
        size.width,
        size.height,
        {
          fillStyle: waveformTheme.overlayUnsaved,
          outlineStyle: waveformTheme.overlayUnsavedEdge,
          edgeStyle: waveformTheme.overlayUnsavedEdge,
        },
      );
    }
    if (ghostSegment) {
      drawSegmentOverlay(
        context,
        [ghostSegment],
        timeRange,
        size.width,
        size.height,
        heldTool === "erase"
          ? {
              fillStyle: waveformTheme.overlayErase,
              outlineStyle: waveformTheme.overlayEraseEdge,
              edgeStyle: waveformTheme.overlayEraseEdge,
            }
          : {
              fillStyle: waveformTheme.overlayMark,
              outlineStyle: waveformTheme.overlayMarkEdge,
              edgeStyle: waveformTheme.overlayMarkEdge,
            },
      );
    }

    document.waveformLevels.forEach((_, index) => {
      const top = index * channelHeight;
      context.fillStyle = waveformTheme.label;
      context.font = "12px 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif";
      context.fillText(
        document.channelLabels?.[index] ?? `声道 ${index + 1}`,
        14,
        top + 18,
      );
    });

    drawPlayhead(
      context,
      playheadSec,
      timeRange,
      size.width,
      size.height,
      waveformTheme.playhead,
    );
    drawTimeGrid(
      context,
      timeRange,
      size.width,
      size.height,
      waveformTheme.grid,
      waveformTheme.label,
    );
  }, [
    channelHeight,
    document,
    ghostSegment,
    heldTool,
    overlayGroups,
    playheadSec,
    segments,
    size.height,
    size.width,
    timeRange,
    waveformTheme,
  ]);

  useEffect(() => {
    const canvas = overviewCanvasRef.current;
    if (!canvas || overviewSize.width === 0 || overviewSize.height === 0) {
      return;
    }

    const devicePixelRatio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(overviewSize.width * devicePixelRatio);
    canvas.height = Math.floor(overviewSize.height * devicePixelRatio);
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    context.clearRect(0, 0, overviewSize.width, overviewSize.height);
    context.fillStyle = waveformTheme.laneOdd;
    context.fillRect(0, 0, overviewSize.width, overviewSize.height);

    const overviewRange = {
      startSec: 0,
      endSec: document.durationSec,
    };
    drawWaveform(
      context,
      document.waveformLevels[0] ?? [],
      overviewRange,
      document.waveformSampleRate,
      overviewSize.width,
      overviewSize.height,
      0,
      waveformTheme.waveform,
    );

    context.fillStyle = "rgba(8, 10, 14, 0.18)";
    context.fillRect(0, 0, overviewSize.width, overviewSize.height);

    const maskLeft =
      (timeRange.startSec / Math.max(document.durationSec, MIN_TIME_WINDOW_SEC)) *
      overviewSize.width;
    const maskWidth =
      ((timeRange.endSec - timeRange.startSec) /
        Math.max(document.durationSec, MIN_TIME_WINDOW_SEC)) *
      overviewSize.width;

    context.fillStyle = waveformTheme.overlayUnsaved;
    context.fillRect(maskLeft, 0, Math.max(maskWidth, 1), overviewSize.height);
    context.strokeStyle = waveformTheme.overlayUnsavedEdge;
    context.lineWidth = 1;
    context.strokeRect(
      maskLeft + 0.5,
      0.5,
      Math.max(maskWidth - 1, 0),
      Math.max(overviewSize.height - 1, 0),
    );

    context.strokeStyle = waveformTheme.playhead;
    context.lineWidth = 1;
    const playheadX =
      (playheadSec / Math.max(document.durationSec, MIN_TIME_WINDOW_SEC)) *
      overviewSize.width;
    context.beginPath();
    context.moveTo(playheadX + 0.5, 0);
    context.lineTo(playheadX + 0.5, overviewSize.height);
    context.stroke();
  }, [
    document.durationSec,
    document.waveformLevels,
    document.waveformSampleRate,
    overviewSize.height,
    overviewSize.width,
    playheadSec,
    timeRange.endSec,
    timeRange.startSec,
    waveformTheme,
  ]);

  return (
    <div className="waveform-shell">
      <div
        ref={overviewRef}
        className="waveform-nav"
        onPointerDown={(event) => {
          if (!overviewRef.current) {
            return;
          }

          const rect = overviewRef.current.getBoundingClientRect();
          const clickedSec =
            clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1) *
            document.durationSec;
          const maskStartX =
            (timeRange.startSec / Math.max(document.durationSec, MIN_TIME_WINDOW_SEC)) *
            rect.width;
          const maskWidth =
            ((timeRange.endSec - timeRange.startSec) /
              Math.max(document.durationSec, MIN_TIME_WINDOW_SEC)) *
            rect.width;
          const insideMask =
            event.clientX >= rect.left + maskStartX &&
            event.clientX <= rect.left + maskStartX + maskWidth;
          const anchorOffsetSec = insideMask
            ? clickedSec - timeRange.startSec
            : visibleSpan / 2;

          overviewDragRef.current = {
            pointerId: event.pointerId,
            anchorOffsetSec,
          };
          overviewRef.current.setPointerCapture(event.pointerId);
          const nextStart = clamp(
            clickedSec - anchorOffsetSec,
            0,
            Math.max(document.durationSec - visibleSpan, 0),
          );
          onSetTimeRange(nextStart, nextStart + visibleSpan);
        }}
        onPointerMove={(event) => {
          if (
            !overviewRef.current ||
            !overviewDragRef.current ||
            overviewDragRef.current.pointerId !== event.pointerId
          ) {
            return;
          }

          const rect = overviewRef.current.getBoundingClientRect();
          const currentSec =
            clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1) *
            document.durationSec;
          const nextStart = clamp(
            currentSec - overviewDragRef.current.anchorOffsetSec,
            0,
            Math.max(document.durationSec - visibleSpan, 0),
          );
          onSetTimeRange(nextStart, nextStart + visibleSpan);
        }}
        onPointerUp={(event) => {
          if (
            !overviewRef.current ||
            !overviewDragRef.current ||
            overviewDragRef.current.pointerId !== event.pointerId
          ) {
            return;
          }

          overviewDragRef.current = null;
          overviewRef.current.releasePointerCapture(event.pointerId);
        }}
      >
        <canvas ref={overviewCanvasRef} className="waveform-overview-canvas" />
      </div>

      <div
        ref={containerRef}
        className="waveform-panel"
        style={{ cursor }}
        onWheel={(event) => {
          event.preventDefault();
          const rect = containerRef.current?.getBoundingClientRect();
          if (!rect) {
            return;
          }

          const centerSec = getSecondsForClientX(event.clientX, rect, timeRange);
          onWheelZoom(centerSec, event.deltaY > 0 ? 1.14 : 0.88);
        }}
        onPointerDown={(event) => {
          if (!containerRef.current) {
            return;
          }

          const rect = containerRef.current.getBoundingClientRect();
          const selectionStartSec = getSecondsForClientX(
            event.clientX,
            rect,
            timeRange,
          );
          const hit = heldTool || event.ctrlKey
            ? null
            : getSegmentHit(selectionStartSec, rect.width, timeRange, segments);

          dragRef.current = {
            mode:
              hit?.part === "start" || hit?.part === "end"
                ? "resize"
                : heldTool || event.ctrlKey
                  ? "edit"
                  : "pan",
            startX: event.clientX,
            originRange: timeRange,
            selectionStartSec,
            clickedSegmentStartSec: hit?.segment.startSec,
            resizeEdge:
              hit?.part === "start" || hit?.part === "end" ? hit.part : undefined,
            segmentIndex: hit?.index,
            sourceSegment: hit?.segment,
          };
          containerRef.current.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!containerRef.current) {
            return;
          }

          if (!dragRef.current) {
            const rect = containerRef.current.getBoundingClientRect();
            const secondsValue = getSecondsForClientX(event.clientX, rect, timeRange);
            const hit = heldTool
              ? null
              : getSegmentHit(secondsValue, rect.width, timeRange, segments);
            setCursor(hit?.part === "start" || hit?.part === "end" ? "ew-resize" : "default");
            return;
          }

          const rect = containerRef.current.getBoundingClientRect();
          const drag = dragRef.current;
          if (drag.mode === "pan") {
            const deltaSec =
              ((event.clientX - drag.startX) / rect.width) *
              (drag.originRange.endSec - drag.originRange.startSec);
            onSetTimeRange(
              drag.originRange.startSec - deltaSec,
              drag.originRange.endSec - deltaSec,
            );
            return;
          }

          const currentSec = getSecondsForClientX(event.clientX, rect, timeRange);
          if (
            drag.mode === "resize" &&
            drag.sourceSegment &&
            typeof drag.segmentIndex === "number" &&
            drag.resizeEdge
          ) {
            setGhostSegment({
              startSec:
                drag.resizeEdge === "start"
                  ? currentSec
                  : drag.sourceSegment.startSec,
              endSec:
                drag.resizeEdge === "end" ? currentSec : drag.sourceSegment.endSec,
            });
            return;
          }

          setGhostSegment({
            startSec: drag.selectionStartSec,
            endSec: currentSec,
          });
        }}
        onPointerUp={(event) => {
          const drag = dragRef.current;
          dragRef.current = null;
          if (!drag || !containerRef.current) {
            return;
          }

          const rect = containerRef.current.getBoundingClientRect();
          const secondsValue = getSecondsForClientX(event.clientX, rect, timeRange);
          const clickHit = getSegmentHit(secondsValue, rect.width, timeRange, segments);

          if (drag.mode === "pan") {
            if (Math.abs(event.clientX - drag.startX) < 3) {
              onSelectSegment(clickHit?.segment ?? null);
              void onSeek(secondsValue, true);
            }
            return;
          }

          if (
            drag.mode === "resize" &&
            drag.sourceSegment &&
            typeof drag.segmentIndex === "number" &&
            drag.resizeEdge
          ) {
            setGhostSegment(null);
            const nextSegment = {
              startSec:
                drag.resizeEdge === "start"
                  ? secondsValue
                  : drag.sourceSegment.startSec,
              endSec:
                drag.resizeEdge === "end" ? secondsValue : drag.sourceSegment.endSec,
            };
            onAdjustSegment(drag.segmentIndex, nextSegment);
            onSelectSegment(nextSegment);
            setCursor("default");
            return;
          }

          if (Math.abs(event.clientX - drag.startX) < 3) {
            setGhostSegment(null);
            onSelectSegment(clickHit?.segment ?? null);
            void onSeek(secondsValue, true);
            return;
          }

          const segment = {
            startSec: drag.selectionStartSec,
            endSec: secondsValue,
          };
          setGhostSegment(null);
          if (Math.abs(segment.endSec - segment.startSec) >= 0.01) {
            onCommitSegment(segment);
            onSelectSegment(segment);
          }
        }}
        onPointerLeave={() => {
          if (!dragRef.current) {
            setCursor("default");
          } else if (dragRef.current.mode === "edit" || dragRef.current.mode === "resize") {
            setGhostSegment(null);
          }
        }}
      >
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}

function SpectrogramPanel({
  worker,
  document,
  selectedChannel,
  timeRange,
  frequencyRange,
  frequencyScale,
  playheadSec,
  segments,
  overlayGroups,
  heldTool,
  canvasTheme,
  onSeek,
  onSetTimeRange,
  onSetFrequencyRange,
  onWheelZoom,
  onCommitSegment,
  onAdjustSegment,
  onSelectSegment,
}: {
  worker: SpectrogramWorkerClient | null;
  document: HydratedDocument;
  selectedChannel: number;
  timeRange: TimeRange;
  frequencyRange: FrequencyRange;
  frequencyScale: FrequencyScale;
  playheadSec: number;
  segments: VadSegment[];
  overlayGroups: SegmentOverlayGroups;
  heldTool: HeldTool;
  canvasTheme: ReturnType<typeof getCanvasTheme>;
  onSeek: (secondsValue: number, shouldPlay?: boolean) => void;
  onSetTimeRange: (startSec: number, endSec: number) => void;
  onSetFrequencyRange: (minFreq: number, maxFreq: number) => void;
  onWheelZoom: (centerFreq: number, factor: number) => void;
  onCommitSegment: (segment: VadSegment) => void;
  onAdjustSegment: (segmentIndex: number, segment: VadSegment) => void;
  onSelectSegment: (segment: VadSegment | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{
    mode: "pan" | "edit" | "resize";
    startX: number;
    startY: number;
    originRange: TimeRange;
    originFrequencyRange: FrequencyRange;
    selectionStartSec: number;
    clickedSegmentStartSec?: number;
    resizeEdge?: "start" | "end";
    segmentIndex?: number;
    sourceSegment?: VadSegment;
  } | null>(null);
  const [ghostSegment, setGhostSegment] = useState<VadSegment | null>(null);
  const [imageData, setImageData] = useState<ImageData | null>(null);
  const [cursor, setCursor] = useState<"default" | "ew-resize">("default");
  const size = useElementSize(containerRef.current);

  useEffect(() => {
    if (!worker || size.width === 0 || size.height === 0) {
      return;
    }

    const renderWidth = getSpectrogramRenderDimension(
      size.width,
      SPECTROGRAM_RENDER_SCALE,
      MAX_SPECTROGRAM_RENDER_WIDTH,
    );
    const renderHeight = getSpectrogramRenderDimension(
      size.height,
      SPECTROGRAM_RENDER_SCALE,
      MAX_SPECTROGRAM_RENDER_HEIGHT,
    );
    let cancelled = false;
    void worker
      .render({
        documentId: document.audioPath,
        channelIndex: selectedChannel,
        width: renderWidth,
        height: renderHeight,
        startSec: timeRange.startSec,
        endSec: timeRange.endSec,
        minFreq: frequencyRange.minFreq,
        maxFreq: frequencyRange.maxFreq,
        frequencyScale,
        themeMode: canvasTheme.mode,
      })
      .then((nextImageData) => {
        if (!cancelled) {
          setImageData(nextImageData);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    document.audioPath,
    frequencyRange.maxFreq,
    frequencyRange.minFreq,
    frequencyScale,
    selectedChannel,
    size.height,
    size.width,
    timeRange.endSec,
    timeRange.startSec,
    worker,
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width === 0 || size.height === 0) {
      return;
    }

    const devicePixelRatio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(size.width * devicePixelRatio);
    canvas.height = Math.floor(size.height * devicePixelRatio);
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    context.clearRect(0, 0, size.width, size.height);
    context.fillStyle = canvasTheme.spectrogramBackground;
    context.fillRect(0, 0, size.width, size.height);

    if (imageData) {
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "medium";
      const bitmapCanvas = window.document.createElement("canvas");
      bitmapCanvas.width = imageData.width;
      bitmapCanvas.height = imageData.height;
      const bitmapContext = bitmapCanvas.getContext("2d");
      bitmapContext?.putImageData(imageData, 0, 0);
      context.drawImage(bitmapCanvas, 0, 0, size.width, size.height);
    }

    drawSegmentOverlay(
      context,
      overlayGroups.saved,
      timeRange,
      size.width,
      size.height,
      {
        fillStyle: canvasTheme.overlayBase,
        outlineStyle: canvasTheme.overlayBaseEdge,
        edgeStyle: canvasTheme.overlayBaseEdge,
      },
    );
    if (overlayGroups.unsaved.length > 0) {
      drawSegmentOverlay(
        context,
        overlayGroups.unsaved,
        timeRange,
        size.width,
        size.height,
        {
          fillStyle: canvasTheme.overlayUnsaved,
          outlineStyle: canvasTheme.overlayUnsavedEdge,
          edgeStyle: canvasTheme.overlayUnsavedEdge,
        },
      );
    }
    if (ghostSegment) {
      drawSegmentOverlay(
        context,
        [ghostSegment],
        timeRange,
        size.width,
        size.height,
        heldTool === "erase"
          ? {
              fillStyle: canvasTheme.overlayErase,
              outlineStyle: canvasTheme.overlayEraseEdge,
              edgeStyle: canvasTheme.overlayEraseEdge,
            }
          : {
              fillStyle: canvasTheme.overlayMark,
              outlineStyle: canvasTheme.overlayMarkEdge,
              edgeStyle: canvasTheme.overlayMarkEdge,
            },
      );
    }
    drawPlayhead(
      context,
      playheadSec,
      timeRange,
      size.width,
      size.height,
      canvasTheme.playhead,
    );
    drawFrequencyLabels(
      context,
      frequencyRange,
      frequencyScale,
      size.width,
      size.height,
      canvasTheme,
    );
  }, [
    canvasTheme,
    frequencyRange,
    frequencyScale,
    ghostSegment,
    heldTool,
    imageData,
    overlayGroups,
    playheadSec,
    segments,
    size.height,
    size.width,
    timeRange,
  ]);

  return (
    <div
      ref={containerRef}
      className="spectrogram-panel"
      style={{ cursor }}
      onWheel={(event) => {
        event.preventDefault();
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) {
          return;
        }

        if (event.ctrlKey) {
          const alpha = 1 - (event.clientY - rect.top) / rect.height;
          const centerFreq =
            frequencyRange.minFreq +
            alpha * (frequencyRange.maxFreq - frequencyRange.minFreq);
          onWheelZoom(centerFreq, event.deltaY > 0 ? 1.12 : 0.9);
          return;
        }

        const centerSec = getSecondsForClientX(event.clientX, rect, timeRange);
        const span = timeRange.endSec - timeRange.startSec;
        const nextSpan = clamp(
          span * (event.deltaY > 0 ? 1.14 : 0.88),
          MIN_TIME_WINDOW_SEC,
          document.durationSec,
        );
        const nextRange = setWithinDuration(
          centerSec - (centerSec - timeRange.startSec) * (nextSpan / span),
          centerSec + (timeRange.endSec - centerSec) * (nextSpan / span),
          document.durationSec,
        );
        onSetTimeRange(nextRange.startSec, nextRange.endSec);
      }}
      onPointerDown={(event) => {
        if (!containerRef.current) {
          return;
        }

        const rect = containerRef.current.getBoundingClientRect();
        const selectionStartSec = getSecondsForClientX(
          event.clientX,
          rect,
          timeRange,
        );
        const hit = heldTool || event.ctrlKey
          ? null
          : getSegmentHit(selectionStartSec, rect.width, timeRange, segments);

        dragRef.current = {
          mode:
            hit?.part === "start" || hit?.part === "end"
              ? "resize"
              : heldTool || event.ctrlKey
                ? "edit"
                : "pan",
          startX: event.clientX,
          startY: event.clientY,
          originRange: timeRange,
          originFrequencyRange: frequencyRange,
          selectionStartSec,
          clickedSegmentStartSec: hit?.segment.startSec,
          resizeEdge:
            hit?.part === "start" || hit?.part === "end" ? hit.part : undefined,
          segmentIndex: hit?.index,
          sourceSegment: hit?.segment,
        };
        containerRef.current.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!containerRef.current) {
          return;
        }

        if (!dragRef.current) {
          const rect = containerRef.current.getBoundingClientRect();
          const secondsValue = getSecondsForClientX(event.clientX, rect, timeRange);
          const hit = heldTool
            ? null
            : getSegmentHit(secondsValue, rect.width, timeRange, segments);
          setCursor(hit?.part === "start" || hit?.part === "end" ? "ew-resize" : "default");
          return;
        }

        const rect = containerRef.current.getBoundingClientRect();
        const drag = dragRef.current;
        if (drag.mode === "pan") {
          const deltaSec =
            ((event.clientX - drag.startX) / rect.width) *
            (drag.originRange.endSec - drag.originRange.startSec);
          const deltaFreq =
            ((event.clientY - drag.startY) / rect.height) *
            (drag.originFrequencyRange.maxFreq - drag.originFrequencyRange.minFreq);
          onSetTimeRange(
            drag.originRange.startSec - deltaSec,
            drag.originRange.endSec - deltaSec,
          );
          onSetFrequencyRange(
            drag.originFrequencyRange.minFreq + deltaFreq,
            drag.originFrequencyRange.maxFreq + deltaFreq,
          );
          return;
        }

        const currentSec = getSecondsForClientX(event.clientX, rect, timeRange);
        if (
          drag.mode === "resize" &&
          drag.sourceSegment &&
          typeof drag.segmentIndex === "number" &&
          drag.resizeEdge
        ) {
          setGhostSegment({
            startSec:
              drag.resizeEdge === "start"
                ? currentSec
                : drag.sourceSegment.startSec,
            endSec:
              drag.resizeEdge === "end" ? currentSec : drag.sourceSegment.endSec,
          });
          return;
        }

        setGhostSegment({
          startSec: drag.selectionStartSec,
          endSec: currentSec,
        });
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (!drag || !containerRef.current) {
          return;
        }

        const rect = containerRef.current.getBoundingClientRect();
        const secondsValue = getSecondsForClientX(event.clientX, rect, timeRange);
        const clickHit = getSegmentHit(secondsValue, rect.width, timeRange, segments);

        if (drag.mode === "pan") {
          if (
            Math.abs(event.clientX - drag.startX) < 3 &&
            Math.abs(event.clientY - drag.startY) < 3
          ) {
            onSelectSegment(clickHit?.segment ?? null);
            void onSeek(secondsValue, true);
          }
          return;
        }

        if (
          drag.mode === "resize" &&
          drag.sourceSegment &&
          typeof drag.segmentIndex === "number" &&
          drag.resizeEdge
        ) {
          setGhostSegment(null);
          const nextSegment = {
            startSec:
              drag.resizeEdge === "start"
                ? secondsValue
                : drag.sourceSegment.startSec,
            endSec:
              drag.resizeEdge === "end" ? secondsValue : drag.sourceSegment.endSec,
          };
          onAdjustSegment(drag.segmentIndex, nextSegment);
          onSelectSegment(nextSegment);
          setCursor("default");
          return;
        }

        if (
          Math.abs(event.clientX - drag.startX) < 3 &&
          Math.abs(event.clientY - drag.startY) < 3
        ) {
          setGhostSegment(null);
          onSelectSegment(clickHit?.segment ?? null);
          void onSeek(secondsValue, true);
          return;
        }

        const segment = {
          startSec: drag.selectionStartSec,
          endSec: secondsValue,
        };
        setGhostSegment(null);
        if (Math.abs(segment.endSec - segment.startSec) >= 0.01) {
          onCommitSegment(segment);
          onSelectSegment(segment);
        }
      }}
      onPointerLeave={() => {
        if (!dragRef.current) {
          setCursor("default");
        } else if (dragRef.current.mode === "edit" || dragRef.current.mode === "resize") {
          setGhostSegment(null);
        }
      }}
    >
      <canvas ref={canvasRef} />
    </div>
  );
}

function drawWaveform(
  context: CanvasRenderingContext2D,
  waveformLevels: WaveformLevel[],
  timeRange: TimeRange,
  sampleRate: number,
  width: number,
  height: number,
  top: number,
  strokeStyle = "#1d3c28",
) {
  const level = pickWaveformLevel(
    waveformLevels,
    Math.max(((timeRange.endSec - timeRange.startSec) * sampleRate) / width, 1),
  );
  const startSample = Math.max(Math.floor(timeRange.startSec * sampleRate), 0);
  const endSample = Math.min(
    Math.ceil(timeRange.endSec * sampleRate),
    level.min.length * level.samplesPerBin,
  );
  const samplesPerPixel = Math.max((endSample - startSample) / width, 1);
  const centerY = top + height / 2;

  context.strokeStyle = strokeStyle;
  context.lineWidth = 1;
  context.beginPath();

  for (let x = 0; x < width; x += 1) {
    const sliceStart = Math.floor(startSample + x * samplesPerPixel);
    const sliceEnd = Math.min(Math.floor(sliceStart + samplesPerPixel), endSample);
    const startBin = Math.floor(sliceStart / level.samplesPerBin);
    const endBin = Math.max(
      startBin + 1,
      Math.ceil(sliceEnd / level.samplesPerBin),
    );
    let min = 1;
    let max = -1;

    for (let index = startBin; index < endBin; index += 1) {
      if (level.min[index] < min) {
        min = level.min[index];
      }
      if (level.max[index] > max) {
        max = level.max[index];
      }
    }

    const y1 = centerY - max * (height * 0.35);
    const y2 = centerY - min * (height * 0.35);
    context.moveTo(x + 0.5, y1);
    context.lineTo(x + 0.5, y2);
  }

  context.stroke();
}

function pickWaveformLevel(
  waveformLevels: WaveformLevel[],
  samplesPerPixel: number,
): WaveformLevel {
  let selected = waveformLevels[0];

  for (const level of waveformLevels) {
    if (level.samplesPerBin > samplesPerPixel) {
      break;
    }

    selected = level;
  }

  return selected;
}

function getSpectrogramRenderDimension(
  size: number,
  scale: number,
  maxSize: number,
): number {
  return Math.max(1, Math.min(Math.floor(size * scale), maxSize));
}

function drawSegmentOverlay(
  context: CanvasRenderingContext2D,
  segments: VadSegment[],
  timeRange: TimeRange,
  width: number,
  height: number,
  style: SegmentOverlayStyle = {
    fillStyle: "rgba(61, 147, 92, 0.18)",
    outlineStyle: "rgba(227, 255, 236, 0.9)",
    edgeStyle: "rgba(227, 255, 236, 1)",
  },
) {
  const span = timeRange.endSec - timeRange.startSec;

  for (const segment of segments) {
    const visibleStart = Math.max(segment.startSec, timeRange.startSec);
    const visibleEnd = Math.min(segment.endSec, timeRange.endSec);
    if (visibleEnd <= visibleStart) {
      continue;
    }

    const x = ((visibleStart - timeRange.startSec) / span) * width;
    const segmentWidth = ((visibleEnd - visibleStart) / span) * width;
    const clampedWidth = Math.max(segmentWidth, 1);
    const left = Math.max(0, x);
    const right = Math.min(width, x + clampedWidth);

    context.fillStyle = style.fillStyle;
    context.fillRect(left, 0, Math.max(right - left, 1), height);

    context.strokeStyle = style.outlineStyle;
    context.lineWidth = 1;
    context.strokeRect(left + 0.5, 0.5, Math.max(right - left - 1, 0), Math.max(height - 1, 0));

    context.strokeStyle = style.edgeStyle;
    context.lineWidth = 1.125;
    context.beginPath();
    context.moveTo(left + 0.5, 0);
    context.lineTo(left + 0.5, height);
    context.moveTo(right - 0.5, 0);
    context.lineTo(right - 0.5, height);
    context.stroke();

    context.fillStyle = style.edgeStyle;
    context.fillRect(left, 0, Math.min(4, Math.max(right - left, 1)), height);
    context.fillRect(Math.max(left, right - 4), 0, Math.min(4, Math.max(right - left, 1)), height);
  }
}

function drawPlayhead(
  context: CanvasRenderingContext2D,
  playheadSec: number,
  timeRange: TimeRange,
  width: number,
  height: number,
  color = "#effaf0",
) {
  if (playheadSec < timeRange.startSec || playheadSec > timeRange.endSec) {
    return;
  }

  const alpha =
    (playheadSec - timeRange.startSec) / (timeRange.endSec - timeRange.startSec);
  const x = alpha * width;
  context.strokeStyle = color;
  context.lineWidth = 1.25;
  context.beginPath();
  context.moveTo(x, 0);
  context.lineTo(x, height);
  context.stroke();
}

function drawTimeGrid(
  context: CanvasRenderingContext2D,
  timeRange: TimeRange,
  width: number,
  height: number,
  gridStrokeStyle = "rgba(17, 23, 18, 0.08)",
  labelFillStyle = "#6f6a62",
) {
  const span = timeRange.endSec - timeRange.startSec;
  const targetTicks = 8;
  const rawStep = span / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const stepCandidates = [1, 2, 5, 10].map((value) => value * magnitude);
  const step = stepCandidates.find((candidate) => rawStep <= candidate) ?? rawStep;
  const firstTick = Math.ceil(timeRange.startSec / step) * step;

  context.strokeStyle = gridStrokeStyle;
  context.fillStyle = labelFillStyle;
  context.font = "12px 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif";

  for (let tick = firstTick; tick <= timeRange.endSec; tick += step) {
    const x = ((tick - timeRange.startSec) / span) * width;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
    context.fillText(formatSeconds(tick), x + 6, height - 10);
  }
}

function drawFrequencyLabels(
  context: CanvasRenderingContext2D,
  frequencyRange: FrequencyRange,
  frequencyScale: FrequencyScale,
  width: number,
  height: number,
  canvasTheme: ReturnType<typeof getCanvasTheme>,
) {
  const tickCount = 5;
  context.strokeStyle = canvasTheme.frequencyGuide;
  context.fillStyle = canvasTheme.frequencyLabel;
  context.font = "12px 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif";

  for (let index = 0; index < tickCount; index += 1) {
    const alpha = index / Math.max(tickCount - 1, 1);
    const y = 18 + alpha * Math.max(height - 36, 1);
    const row = Math.round(alpha * Math.max(height - 1, 1));
    const frequency = frequencyForCanvasRow(
      row,
      height,
      frequencyRange.minFreq,
      frequencyRange.maxFreq,
      frequencyScale,
    );

    context.beginPath();
    context.moveTo(0, y - 4);
    context.lineTo(width, y - 4);
    context.stroke();
    context.fillText(formatFrequencyLabel(frequency), 12, y);
  }

  context.fillText(frequencyScale === "linear" ? "线性" : "对数", width - 44, 18);
}
