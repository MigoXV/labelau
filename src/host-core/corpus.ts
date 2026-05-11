import path from "node:path";
import { readdir } from "node:fs/promises";

import type {
  CorpusDirectory,
  CorpusEntry,
  ScanDirectoryResult,
  ScanWarning,
} from "../shared/contracts";
import { getAudioExtension } from "../shared/audio-format";

import { readAudioMetadata } from "./audio";

interface DirectoryPairing {
  audioFiles: Map<string, string>;
  csvs: Map<string, string>;
}

interface DirectoryScanResult {
  tree: CorpusDirectory | null;
  warnings: ScanWarning[];
}

function sortEntries(entries: CorpusEntry[]): CorpusEntry[] {
  return [...entries].sort((left, right) =>
    left.audioPath.localeCompare(right.audioPath),
  );
}

function sortDirectories(directories: CorpusDirectory[]): CorpusDirectory[] {
  return [...directories].sort((left, right) => left.name.localeCompare(right.name));
}

function sortWarnings(warnings: ScanWarning[]): ScanWarning[] {
  return [...warnings].sort((left, right) =>
    left.audioPath.localeCompare(right.audioPath),
  );
}

function normalizeAudioReadError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("Unsupported audio file:")) {
    return "不支持的音频文件";
  }

  if (message.startsWith("Incomplete audio metadata:")) {
    return "音频元数据不完整";
  }

  return "读取音频元数据失败";
}

async function buildDirectoryTree(
  rootPath: string,
  currentPath: string,
): Promise<DirectoryScanResult> {
  const children = await readdir(currentPath, { withFileTypes: true });
  const pairing: DirectoryPairing = {
    audioFiles: new Map(),
    csvs: new Map(),
  };

  const directories: CorpusDirectory[] = [];
  const warnings: ScanWarning[] = [];

  for (const child of children) {
    const absolutePath = path.join(currentPath, child.name);
    if (child.isDirectory()) {
      const nested = await buildDirectoryTree(rootPath, absolutePath);
      warnings.push(...nested.warnings);
      if (nested.tree) {
        directories.push(nested.tree);
      }
      continue;
    }

    if (!child.isFile()) {
      continue;
    }

    const extension = path.extname(child.name).toLowerCase();
    const stem = path.basename(child.name, path.extname(child.name));
    if (getAudioExtension(child.name)) {
      pairing.audioFiles.set(stem, absolutePath);
    } else if (extension === ".csv") {
      pairing.csvs.set(stem, absolutePath);
    }
  }

  const entries: CorpusEntry[] = [];
  for (const [stem, audioPath] of pairing.audioFiles.entries()) {
    try {
      const csvPath = pairing.csvs.get(stem) ?? null;
      const metadata = await readAudioMetadata(audioPath);
      const relativeDir = path.relative(rootPath, currentPath);
      entries.push({
        audioPath,
        csvPath,
        relativeDir: relativeDir === "" ? "." : relativeDir,
        stem,
        hasAnnotation: Boolean(csvPath),
        isDirty: false,
        audioMeta: metadata,
      });
    } catch (error) {
      warnings.push({
        audioPath,
        stem,
        reason: normalizeAudioReadError(error),
      });
    }
  }

  const filteredEntries = sortEntries(entries);
  const filteredDirectories = sortDirectories(directories);
  const sortedWarnings = sortWarnings(warnings);

  if (filteredEntries.length === 0 && filteredDirectories.length === 0) {
    return {
      tree: null,
      warnings: sortedWarnings,
    };
  }

  return {
    tree: {
      name: path.basename(currentPath),
      relativePath: path.relative(rootPath, currentPath),
      directories: filteredDirectories,
      entries: filteredEntries,
    },
    warnings: sortedWarnings,
  };
}

export async function scanCorpus(rootPath: string): Promise<ScanDirectoryResult> {
  const { tree, warnings } = await buildDirectoryTree(rootPath, rootPath);
  return {
    tree: tree
      ? {
          ...tree,
          relativePath: "",
        }
      : {
          name: path.basename(rootPath),
          relativePath: "",
          directories: [],
          entries: [],
        },
    warnings,
  };
}
