import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { hydrateAudio } from "./audio";
import { getHostBridge } from "./bridge";
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
  MAX_FRONTEND_SAMPLE_RATE,
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

interface HydratedDocument extends LoadedAudioDocument {
  blobUrl: string;
  waveformLevels: WaveformLevel[][];
  waveformSampleRate: number;
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

function getDefaultTimeRange(durationSec: number): TimeRange {
  return {
    startSec: 0,
    endSec: Math.min(12, durationSec),
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

function formatDurationLabel(value: number): string {
  const totalSeconds = Math.max(0, Math.round(value));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
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

  const [rootPath, setRootPath] = useState("");
  const [tree, setTree] = useState<CorpusEntryTree | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [fileFilter, setFileFilter] = useState<FileFilter>("all");
  const [selectedAudioPath, setSelectedAudioPath] = useState<string | null>(null);
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
  const [isPlaying, setIsPlaying] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [isLoadingDocument, setIsLoadingDocument] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("等待打开目录");
  const [heldTool, setHeldTool] = useState<HeldTool>(null);
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(() => new Set());
  const [savedPaths, setSavedPaths] = useState<Set<string>>(() => new Set());
  const [entryOverrides, setEntryOverrides] = useState<
    Record<string, EntryOverlayState>
  >({});
  const loadRequestIdRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);

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
        const nextTree = await bridge.scanDirectory(nextRootPath);
        const flattened = flattenEntries(nextTree);

        setTree(nextTree);
        setRootPath(nextRootPath);
        setStatusMessage(
          flattened.length > 0
            ? `已载入 ${flattened.length} 个可用音频`
            : "目录中未找到可导入的 WAV",
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
    [bridge, cacheDocument, touchCache],
  );

  useEffect(() => {
    if (!selectedAudioPath) {
      setCurrentDocument(null);
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

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirtyPaths.size === 0) {
        return;
      }

      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirtyPaths]);

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
    (secondsValue: number) => {
      if (!currentDocument || !audioRef.current) {
        return;
      }

      const nextPlayhead = clamp(secondsValue, 0, currentDocument.durationSec);
      setPlayheadSec(nextPlayhead);
      audioRef.current.currentTime = nextPlayhead;
    },
    [currentDocument],
  );

  const saveCurrentDocument = useCallback(async () => {
    if (!currentDocument) {
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);

    try {
      const result = await bridge.saveAnnotation({
        audioPath: currentDocument.audioPath,
        csvPath: currentDocument.csvPath,
        segments: currentDocument.segments,
      });

      updateCurrentDocument((document) => ({
        ...document,
        csvPath: result.csvPath,
        isDirty: false,
      }));
      setDirtyPaths((previous) => {
        const next = new Set(previous);
        next.delete(currentDocument.audioPath);
        return next;
      });
      setSavedPaths((previous) => {
        const next = new Set(previous);
        next.add(currentDocument.audioPath);
        return next;
      });
      setEntryOverrides((previous) => ({
        ...previous,
        [currentDocument.audioPath]: {
          hasAnnotation: true,
          csvPath: result.csvPath,
        },
      }));
      setStatusMessage(`已保存 ${currentDocument.stem}.csv`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "保存失败");
    } finally {
      setIsSaving(false);
    }
  }, [bridge, currentDocument, updateCurrentDocument]);

  const updateSegments = useCallback(
    (updater: (segments: VadSegment[]) => VadSegment[]) => {
      if (!currentDocument) {
        return;
      }

      updateCurrentDocument((document) => ({
        ...document,
        segments: normalizeSegments(updater(document.segments)),
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

  const previousEntry =
    selectedEntryIndex > 0 ? visibleEntries[selectedEntryIndex - 1] : null;
  const nextEntry =
    selectedEntryIndex >= 0 && selectedEntryIndex < visibleEntries.length - 1
      ? visibleEntries[selectedEntryIndex + 1]
      : null;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
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

      if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        const candidate =
          selectedEntryIndex > 0 ? visibleEntries[selectedEntryIndex - 1] : null;
        if (candidate) {
          event.preventDefault();
          selectAudioPath(candidate.audioPath);
        }
        return;
      }

      if (event.key === "ArrowDown" || event.key === "ArrowRight") {
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
      }

      if (event.key.toLowerCase() === "e") {
        setHeldTool("erase");
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "m" && heldTool === "mark") {
        setHeldTool(null);
      }

      if (event.key.toLowerCase() === "e" && heldTool === "erase") {
        setHeldTool(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [
    heldTool,
    saveCurrentDocument,
    selectedEntryIndex,
    selectAudioPath,
    togglePlayback,
    visibleEntries,
  ]);

  const currentNyquist = currentDocument ? currentDocument.waveformSampleRate / 2 : 8000;
  const currentSegments = currentDocument?.segments ?? [];
  const currentState = selectedEntry
    ? getEntryState(selectedEntry, dirtyPaths, savedPaths, entryOverrides)
    : null;

  return (
    <div className="app-shell" style={uiThemeStyle}>
      <aside className="sidebar">
        <div className="sidebar-header">
          <div>
            <p className="eyebrow">任务导航</p>
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
            <span className="label">任务筛选</span>
            <span className="filter-count">{fileStats.all} 个文件</span>
          </div>
          <div className="filter-row">
            {([
              ["all", "全部"],
              ["pending", "未处理"],
              ["dirty", "未保存"],
              ["done", "已处理"],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={
                  fileFilter === value ? "filter-chip active" : "filter-chip"
                }
                onClick={() => setFileFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="summary-grid">
            <div className="summary-tile">
              <span>未处理</span>
              <strong>{fileStats.pending}</strong>
            </div>
            <div className="summary-tile">
              <span>未保存</span>
              <strong>{fileStats.dirty}</strong>
            </div>
            <div className="summary-tile">
              <span>已处理</span>
              <strong>{fileStats.done}</strong>
            </div>
          </div>
        </div>

        <div className="tree-panel">
          {filteredTree ? (
            <DirectoryTreeView
              tree={filteredTree}
              selectedAudioPath={selectedAudioPath}
              dirtyPaths={dirtyPaths}
              savedPaths={savedPaths}
              entryOverrides={entryOverrides}
              onSelect={(entry) => selectAudioPath(entry.audioPath)}
            />
          ) : (
            <div className="empty-state">
              <h2>{rootPath ? "没有匹配结果" : "等待目录"}</h2>
              <p>
                {rootPath
                  ? "调整搜索词或任务筛选，查看当前目录下的可标注音频。"
                  : "打开目录后，系统会递归扫描 WAV，并自动匹配同目录同 stem 的 Audition CSV。"}
              </p>
            </div>
          )}
        </div>
      </aside>

      <main className="workspace">
        <header className="workspace-header">
          <div className="toolbar toolbar-primary">
            <div className="toolbar-title">
              <p className="eyebrow">当前文件</p>
              <h2>
                {currentDocument?.stem ??
                  (rootPath ? "请从左侧选择音频" : "开始音频标注")}
              </h2>
              <p className="toolbar-subtitle">
                {currentDocument
                  ? `${formatDurationLabel(currentDocument.durationSec)} · ${currentDocument.channelCount} 通道 · ${currentDocument.csvPath ? "已关联 CSV" : "将新建 CSV"}`
                  : rootPath
                    ? "左侧文件列表会展示当前目录下可工作的音频文件。"
                    : "先打开一个包含 WAV 文件的目录，系统会自动恢复已有标注。"}
              </p>
            </div>

            <div className="toolbar-actions">
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
            <div className="toolbar-metrics">
              <Metric
                label="工具"
                value={
                  heldTool === "mark"
                    ? "M 标注"
                    : heldTool === "erase"
                      ? "E 擦除"
                      : "拖拽平移"
                }
              />
              <Metric label="缩放" value={frequencyScale === "linear" ? "线性" : "对数"} />
              <Metric
                label="视图"
                value={`${formatSeconds(timeRange.startSec)} - ${formatSeconds(timeRange.endSec)}`}
              />
              <Metric
                label="状态"
                value={currentState ? getEntryStateLabel(currentState) : "待开始"}
              />
            </div>

            <ThemeControl
              value={uiThemePreference}
              onChange={setUiThemePreference}
            />
          </div>
        </header>

        <section className="editor">
          {currentDocument ? (
            <>
              <WaveformPanel
                document={currentDocument}
                waveformTheme={waveformTheme}
                timeRange={timeRange}
                playheadSec={playheadSec}
                segments={currentSegments}
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
              />

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

                <button
                  className="ghost-button"
                  onClick={() =>
                    setFrequencyScale((previous) =>
                      previous === "linear" ? "log" : "linear",
                    )
                  }
                >
                  {frequencyScale === "linear" ? "切换到对数" : "切换到线性"}
                </button>
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
              />
            </>
          ) : (
            <div className="editor-empty">
              {!rootPath ? (
                <div className="empty-state-card">
                  <p className="eyebrow">开始工作</p>
                  <h2>开始音频标注</h2>
                  <p>
                    先打开一个包含 WAV 文件的目录，系统将自动扫描同名 CSV 并恢复已有标注。
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
              {currentDocument?.stem ?? (rootPath ? "未选择文件" : "未打开目录")}
            </span>
            <span className="status-chip">
              {isScanning
                ? "正在扫描目录"
                : isLoadingDocument
                  ? "正在载入音频"
                  : isSaving
                    ? "正在保存"
                    : "就绪"}
            </span>
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
            <span className="status-chip">
              {currentDocument?.isDirty ? "有未保存修改" : "已保存"}
            </span>
            {currentDocument ? (
              <span className="status-chip">
                原始 {currentDocument.sampleRate} Hz · 前端{" "}
                {Math.min(currentDocument.sampleRate, MAX_FRONTEND_SAMPLE_RATE)} Hz ·{" "}
                {currentDocument.channelCount} 通道
              </span>
            ) : null}
            <span className="status-chip">空格 播放 · S 保存 · M 标注 · E 擦除</span>
          </div>

          {errorMessage ? <span className="error-text">{errorMessage}</span> : <span>{statusMessage}</span>}
        </footer>
      </main>
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
  return (
    <div className="directory-tree">
      <DirectoryNode
        node={tree}
        depth={0}
        selectedAudioPath={selectedAudioPath}
        dirtyPaths={dirtyPaths}
        savedPaths={savedPaths}
        entryOverrides={entryOverrides}
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
  onSelect,
}: {
  node: CorpusDirectory;
  depth: number;
  selectedAudioPath: string | null;
  dirtyPaths: Set<string>;
  savedPaths: Set<string>;
  entryOverrides: Record<string, EntryOverlayState>;
  onSelect: (entry: CorpusEntry) => void;
}) {
  return (
    <div className="directory-node">
      <div className="directory-title" style={{ paddingLeft: `${depth * 14}px` }}>
        {depth === 0 ? "文件列表" : node.name}
      </div>

      {node.entries.map((entry) => {
        const badge = getEntryState(entry, dirtyPaths, savedPaths, entryOverrides);
        const csvPath = getDisplayCsvPath(entry, entryOverrides);
        return (
          <button
            key={entry.audioPath}
            className={
              entry.audioPath === selectedAudioPath
                ? "tree-entry active"
                : "tree-entry"
            }
            style={{ paddingLeft: `${depth * 14 + 14}px` }}
            onClick={() => onSelect(entry)}
          >
            <div>
              <strong>{entry.stem}</strong>
              <span>{entry.relativeDir || "当前目录"}</span>
            </div>
            <div className="entry-meta">
              <span className={`badge ${badge}`}>{getEntryStateLabel(badge)}</span>
              <span>
                {formatDurationLabel(entry.audioMeta.durationSec)} ·
                {csvPath ? " 已有 CSV" : " 新建 CSV"}
              </span>
            </div>
          </button>
        );
      })}

      {node.directories.map((directory) => (
        <DirectoryNode
          key={directory.relativePath || directory.name}
          node={directory}
          depth={depth + 1}
          selectedAudioPath={selectedAudioPath}
          dirtyPaths={dirtyPaths}
          savedPaths={savedPaths}
          entryOverrides={entryOverrides}
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
  heldTool,
  onSeek,
  onSetTimeRange,
  onWheelZoom,
  onCommitSegment,
  onAdjustSegment,
}: {
  document: HydratedDocument;
  waveformTheme: ReturnType<typeof getWaveformTheme>;
  timeRange: TimeRange;
  playheadSec: number;
  segments: VadSegment[];
  heldTool: HeldTool;
  onSeek: (secondsValue: number) => void;
  onSetTimeRange: (startSec: number, endSec: number) => void;
  onWheelZoom: (centerSec: number, factor: number) => void;
  onCommitSegment: (segment: VadSegment) => void;
  onAdjustSegment: (segmentIndex: number, segment: VadSegment) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
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
  const [ghostSegment, setGhostSegment] = useState<VadSegment | null>(null);
  const [cursor, setCursor] = useState<"default" | "ew-resize">("default");
  const size = useElementSize(containerRef.current);
  const channelHeight = Math.max(size.height / Math.max(document.channelCount, 1), 1);

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
      segments,
      timeRange,
      size.width,
      size.height,
      {
        fillStyle: waveformTheme.overlayBase,
        outlineStyle: waveformTheme.overlayBaseEdge,
        edgeStyle: waveformTheme.overlayBaseEdge,
      },
    );
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
    playheadSec,
    segments,
    size.height,
    size.width,
    timeRange,
    waveformTheme,
  ]);

  return (
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
        const hit = heldTool
          ? null
          : getSegmentHit(selectionStartSec, rect.width, timeRange, segments);

        dragRef.current = {
          mode:
            hit?.part === "start" || hit?.part === "end"
              ? "resize"
              : heldTool
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

        if (drag.mode === "pan") {
          if (Math.abs(event.clientX - drag.startX) < 3) {
            onSeek(drag.clickedSegmentStartSec ?? secondsValue);
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
          onAdjustSegment(drag.segmentIndex, {
            startSec:
              drag.resizeEdge === "start"
                ? secondsValue
                : drag.sourceSegment.startSec,
            endSec:
              drag.resizeEdge === "end" ? secondsValue : drag.sourceSegment.endSec,
          });
          setCursor("default");
          return;
        }

        const segment = {
          startSec: drag.selectionStartSec,
          endSec: secondsValue,
        };
        setGhostSegment(null);
        if (Math.abs(segment.endSec - segment.startSec) >= 0.01) {
          onCommitSegment(segment);
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

function SpectrogramPanel({
  worker,
  document,
  selectedChannel,
  timeRange,
  frequencyRange,
  frequencyScale,
  playheadSec,
  segments,
  heldTool,
  canvasTheme,
  onSeek,
  onSetTimeRange,
  onSetFrequencyRange,
  onWheelZoom,
  onCommitSegment,
  onAdjustSegment,
}: {
  worker: SpectrogramWorkerClient | null;
  document: HydratedDocument;
  selectedChannel: number;
  timeRange: TimeRange;
  frequencyRange: FrequencyRange;
  frequencyScale: FrequencyScale;
  playheadSec: number;
  segments: VadSegment[];
  heldTool: HeldTool;
  canvasTheme: ReturnType<typeof getCanvasTheme>;
  onSeek: (secondsValue: number) => void;
  onSetTimeRange: (startSec: number, endSec: number) => void;
  onSetFrequencyRange: (minFreq: number, maxFreq: number) => void;
  onWheelZoom: (centerFreq: number, factor: number) => void;
  onCommitSegment: (segment: VadSegment) => void;
  onAdjustSegment: (segmentIndex: number, segment: VadSegment) => void;
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
      segments,
      timeRange,
      size.width,
      size.height,
      {
        fillStyle: canvasTheme.overlayBase,
        outlineStyle: canvasTheme.overlayBaseEdge,
        edgeStyle: canvasTheme.overlayBaseEdge,
      },
    );
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

        const alpha = 1 - (event.clientY - rect.top) / rect.height;
        const centerFreq =
          frequencyRange.minFreq +
          alpha * (frequencyRange.maxFreq - frequencyRange.minFreq);
        onWheelZoom(centerFreq, event.deltaY > 0 ? 1.12 : 0.9);
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
        const hit = heldTool
          ? null
          : getSegmentHit(selectionStartSec, rect.width, timeRange, segments);

        dragRef.current = {
          mode:
            hit?.part === "start" || hit?.part === "end"
              ? "resize"
              : heldTool
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

        if (drag.mode === "pan") {
          if (
            Math.abs(event.clientX - drag.startX) < 3 &&
            Math.abs(event.clientY - drag.startY) < 3
          ) {
            onSeek(drag.clickedSegmentStartSec ?? secondsValue);
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
          onAdjustSegment(drag.segmentIndex, {
            startSec:
              drag.resizeEdge === "start"
                ? secondsValue
                : drag.sourceSegment.startSec,
            endSec:
              drag.resizeEdge === "end" ? secondsValue : drag.sourceSegment.endSec,
          });
          setCursor("default");
          return;
        }

        const segment = {
          startSec: drag.selectionStartSec,
          endSec: secondsValue,
        };
        setGhostSegment(null);
        if (Math.abs(segment.endSec - segment.startSec) >= 0.01) {
          onCommitSegment(segment);
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
