import type { CorpusDirectory, CorpusEntry } from "../../shared/contracts";
import type { EntryOverlayState, EntryState, FileFilter } from "./types";

export function getEntryState(
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

export function getEntryStateLabel(state: EntryState): string {
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

export function matchesFileFilter(state: EntryState, filter: FileFilter): boolean {
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

export function filterTreeByState(
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
