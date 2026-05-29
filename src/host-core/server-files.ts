import { access, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import type { ServerDirectoryListing } from "../shared/contracts";
import { isSupportedAudioFile } from "../shared/audio-format";

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function getServerRoot(): Promise<string> {
  const configuredRoot = process.env.LABELAU_DATA_ROOT?.trim();
  if (configuredRoot) {
    return realpath(configuredRoot);
  }

  if (await pathExists("/data-bin")) {
    return realpath("/data-bin");
  }

  return realpath(process.cwd());
}

function assertWithinRoot(rootPath: string, targetPath: string): void {
  const relativePath = path.relative(rootPath, targetPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`目录不在允许访问范围内：${rootPath}`);
  }
}

export async function listServerDirectory(
  requestedPath?: string,
): Promise<ServerDirectoryListing> {
  const rootPath = await getServerRoot();
  const targetPath = requestedPath?.trim()
    ? path.resolve(requestedPath)
    : rootPath;
  const currentPath = await realpath(targetPath);
  assertWithinRoot(rootPath, currentPath);

  const entries = await readdir(currentPath, { withFileTypes: true });
  const visibleEntries = entries
    .filter((entry) => {
      if (entry.name.startsWith(".")) {
        return false;
      }
      return entry.isDirectory() || isSupportedAudioFile(entry.name);
    })
    .map((entry) => ({
      name: entry.name,
      path: path.join(currentPath, entry.name),
      kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
    }))
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name, "zh-Hans-CN");
    });

  const parentPath = path.dirname(currentPath);
  return {
    currentPath,
    parentPath: currentPath === rootPath ? null : parentPath,
    entries: visibleEntries,
  };
}
