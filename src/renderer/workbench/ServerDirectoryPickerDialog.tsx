import { useCallback, useEffect, useState, type FormEvent } from "react";

import type { ServerDirectoryListing } from "../../shared/contracts";

interface ServerDirectoryPickerDialogProps {
  initialPath?: string;
  listDirectory: (path?: string) => Promise<ServerDirectoryListing>;
  onSelect: (path: string) => void;
  onClose: () => void;
}

function formatBreadcrumb(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) {
    return normalized || "/";
  }

  const prefix = normalized.startsWith("/") ? "/ " : "";
  return `${prefix}${parts.join(" / ")}`;
}

export function ServerDirectoryPickerDialog({
  initialPath,
  listDirectory,
  onSelect,
  onClose,
}: ServerDirectoryPickerDialogProps) {
  const [listing, setListing] = useState<ServerDirectoryListing | null>(null);
  const [pathInput, setPathInput] = useState(initialPath ?? "");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const loadDirectory = useCallback(
    async (nextPath?: string) => {
      setIsLoading(true);
      setErrorMessage(null);

      try {
        const nextListing = await listDirectory(nextPath?.trim() || undefined);
        setListing(nextListing);
        setPathInput(nextListing.currentPath);
      } catch (error) {
        setErrorMessage(
          error instanceof Error ? error.message : "无法读取这个目录",
        );
      } finally {
        setIsLoading(false);
      }
    },
    [listDirectory],
  );

  useEffect(() => {
    void loadDirectory(initialPath);
  }, [initialPath, loadDirectory]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handlePathSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void loadDirectory(pathInput);
  };

  const handleSelect = async () => {
    const selectedPath = pathInput.trim() || listing?.currentPath;
    if (!selectedPath) {
      return;
    }

    if (selectedPath === listing?.currentPath) {
      onSelect(selectedPath);
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);
    try {
      const nextListing = await listDirectory(selectedPath);
      onSelect(nextListing.currentPath);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "无法选择这个目录",
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="server-picker-backdrop" role="presentation" onClick={onClose}>
      <section
        className="server-picker-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="server-picker-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="server-picker-header">
          <div>
            <p className="eyebrow">目录浏览器</p>
            <h2 id="server-picker-title">选择服务器目录</h2>
            <p>
              选择或输入包含 WAV、FLAC 或 MP3 文件的目录，LabelAU 会扫描并生成任务队列。
            </p>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>
            关闭
          </button>
        </header>

        <form className="server-picker-path-form" onSubmit={handlePathSubmit}>
          <label>
            <span>目录路径</span>
            <input
              value={pathInput}
              placeholder="/workspace/apps/labelau/data-bin"
              spellCheck={false}
              onChange={(event) => setPathInput(event.target.value)}
            />
          </label>
          <button type="submit" className="ghost-button" disabled={isLoading}>
            转到
          </button>
        </form>

        <div className="server-picker-toolbar">
          <code title={listing?.currentPath ?? pathInput}>
            {formatBreadcrumb(listing?.currentPath ?? pathInput)}
          </code>
          <div>
            <button
              type="button"
              className="ghost-button"
              disabled={!listing?.parentPath || isLoading}
              onClick={() => void loadDirectory(listing?.parentPath)}
            >
              返回上级
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={isLoading}
              onClick={() => void loadDirectory(pathInput)}
            >
              刷新
            </button>
          </div>
        </div>

        {errorMessage ? (
          <div className="server-picker-error" role="alert">
            {errorMessage}
          </div>
        ) : null}

        <div className="server-picker-list">
          {isLoading && !listing ? (
            <div className="server-picker-empty">正在读取目录</div>
          ) : null}
          {!isLoading && listing && listing.entries.length === 0 ? (
            <div className="server-picker-empty">当前目录为空</div>
          ) : null}
          {listing?.entries.map((entry) =>
            entry.kind === "directory" ? (
              <button
                type="button"
                key={entry.path}
                className="server-picker-row"
                disabled={isLoading}
                onClick={() => void loadDirectory(entry.path)}
              >
                <span>DIR</span>
                <strong title={entry.path}>{entry.name}</strong>
                <em aria-hidden="true">›</em>
              </button>
            ) : (
              <div
                key={entry.path}
                className="server-picker-row server-picker-row-file"
              >
                <span>AUD</span>
                <strong title={entry.path}>{entry.name}</strong>
              </div>
            ),
          )}
        </div>

        <footer className="server-picker-footer">
          <span>{isLoading ? "正在读取目录" : "可以粘贴路径后直接选择"}</span>
          <div>
            <button type="button" className="ghost-button" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="action-button"
              disabled={isLoading || !pathInput.trim()}
              onClick={() => void handleSelect()}
            >
              选择此目录
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
