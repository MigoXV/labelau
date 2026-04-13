import path from "node:path";
import { readdir } from "node:fs/promises";

import type {
  CorpusDirectory,
  CorpusEntry,
  CorpusEntryTree,
} from "../shared/contracts";

import { readWavMetadata } from "./wav";

interface DirectoryPairing {
  wavs: Map<string, string>;
  csvs: Map<string, string>;
}

function sortEntries(entries: CorpusEntry[]): CorpusEntry[] {
  return [...entries].sort((left, right) =>
    left.audioPath.localeCompare(right.audioPath),
  );
}

function sortDirectories(directories: CorpusDirectory[]): CorpusDirectory[] {
  return [...directories].sort((left, right) => left.name.localeCompare(right.name));
}

async function buildDirectoryTree(
  rootPath: string,
  currentPath: string,
): Promise<CorpusDirectory | null> {
  const children = await readdir(currentPath, { withFileTypes: true });
  const pairing: DirectoryPairing = {
    wavs: new Map(),
    csvs: new Map(),
  };

  const directories: CorpusDirectory[] = [];

  for (const child of children) {
    const absolutePath = path.join(currentPath, child.name);
    if (child.isDirectory()) {
      const nested = await buildDirectoryTree(rootPath, absolutePath);
      if (nested) {
        directories.push(nested);
      }
      continue;
    }

    if (!child.isFile()) {
      continue;
    }

    const extension = path.extname(child.name).toLowerCase();
    const stem = path.basename(child.name, path.extname(child.name));
    if (extension === ".wav") {
      pairing.wavs.set(stem, absolutePath);
    } else if (extension === ".csv") {
      pairing.csvs.set(stem, absolutePath);
    }
  }

  const entries = await Promise.all(
    [...pairing.wavs.entries()].map(async ([stem, audioPath]) => {
      const csvPath = pairing.csvs.get(stem) ?? null;
      const metadata = await readWavMetadata(audioPath);
      const relativeDir = path.relative(rootPath, currentPath);
      return {
        audioPath,
        csvPath,
        relativeDir: relativeDir === "" ? "." : relativeDir,
        stem,
        hasAnnotation: Boolean(csvPath),
        isDirty: false,
        audioMeta: metadata,
      } satisfies CorpusEntry;
    }),
  );

  const filteredEntries = sortEntries(entries);
  const filteredDirectories = sortDirectories(directories);

  if (filteredEntries.length === 0 && filteredDirectories.length === 0) {
    return null;
  }

  return {
    name: path.basename(currentPath),
    relativePath: path.relative(rootPath, currentPath),
    directories: filteredDirectories,
    entries: filteredEntries,
  };
}

export async function scanCorpus(rootPath: string): Promise<CorpusEntryTree> {
  const tree = await buildDirectoryTree(rootPath, rootPath);
  if (!tree) {
    return {
      name: path.basename(rootPath),
      relativePath: "",
      directories: [],
      entries: [],
    };
  }

  return {
    ...tree,
    relativePath: "",
  };
}
