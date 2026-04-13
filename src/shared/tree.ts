import type { CorpusDirectory, CorpusEntry } from "./contracts";

export function flattenEntries(tree: CorpusDirectory): CorpusEntry[] {
  return [
    ...tree.entries,
    ...tree.directories.flatMap((directory) => flattenEntries(directory)),
  ];
}

export function filterTree(
  tree: CorpusDirectory,
  query: string,
): CorpusDirectory | null {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return tree;
  }

  const entries = tree.entries.filter((entry) => {
    const haystack = `${entry.stem} ${entry.relativeDir}`.toLowerCase();
    return haystack.includes(normalizedQuery);
  });

  const directories = tree.directories
    .map((directory) => filterTree(directory, normalizedQuery))
    .filter((directory): directory is CorpusDirectory => Boolean(directory));

  if (entries.length === 0 && directories.length === 0) {
    return null;
  }

  return {
    ...tree,
    directories,
    entries,
  };
}
