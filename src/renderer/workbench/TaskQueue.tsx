import { useState, type ReactNode } from "react";
import { formatSeconds } from "svara-ui/labelau";

import type { CorpusDirectory, CorpusEntry } from "../../shared/contracts";
import { getEntryState } from "../editor/file-state";
import type { EntryState, FileFilter } from "../editor/types";
import type { TaskQueueProps } from "./types";

const FILTERS: Array<{
  value: FileFilter;
  label: string;
  stat: keyof TaskQueueProps["stats"];
}> = [
  { value: "all", label: "全部", stat: "all" },
  { value: "pending", label: "未处理", stat: "pending" },
  { value: "dirty", label: "未保存", stat: "dirty" },
  { value: "done", label: "已完成", stat: "done" },
];

type SidebarPanel = "queue" | "search";

const SIDEBAR_PANELS: Array<{
  value: SidebarPanel;
  label: string;
  icon: string;
}> = [
  { value: "queue", label: "任务队列", icon: "≡" },
  { value: "search", label: "搜索", icon: "⌕" },
];

function getDirectoryName(rootPath: string): string {
  if (!rootPath) {
    return "尚未打开工作目录";
  }

  const parts = rootPath.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] ?? rootPath : rootPath;
}

function getDirectoryStatus({
  rootPath,
  stats,
}: Pick<TaskQueueProps, "rootPath" | "stats">): string {
  if (!rootPath) {
    return "选择一个包含音频文件的目录开始标注";
  }

  const parts = [`当前目录`, `${stats.all} 个音频`];
  if (stats.pending > 0) {
    parts.push(`${stats.pending} 个未处理`);
  }
  if (stats.dirty > 0) {
    parts.push(`${stats.dirty} 个未保存`);
  }
  return parts.join(" · ");
}

function getEntryDuration(entry: CorpusEntry): string {
  const durationSec = entry.audioMeta.durationSec;
  return Number.isFinite(durationSec) && durationSec > 0
    ? formatSeconds(durationSec)
    : "时长待载入";
}

function getSidebarStateLabel(state: EntryState): string {
  switch (state) {
    case "dirty":
      return "未保存";
    case "matched":
    case "saved":
      return "已完成";
    case "new":
      return "未处理";
  }
}

function flattenQueueEntries(tree: CorpusDirectory): CorpusEntry[] {
  return [
    ...tree.entries,
    ...tree.directories.flatMap((directory) => flattenQueueEntries(directory)),
  ];
}

function SidebarHeader() {
  return (
    <div className="sidebar-header paper-sidebar-header">
      <div>
        <h1>LabelAU</h1>
        <p>音频标注工作台</p>
      </div>
    </div>
  );
}

function DirectorySummary({
  rootPath,
  stats,
  isScanning,
  onRefreshDirectory,
}: Pick<
  TaskQueueProps,
  "rootPath" | "stats" | "isScanning" | "onRefreshDirectory"
>) {
  return (
    <section className="directory-summary" title={rootPath || undefined}>
      <div className="directory-summary-main">
        <strong>{getDirectoryName(rootPath)}</strong>
        <span>{getDirectoryStatus({ rootPath, stats })}</span>
      </div>
      {rootPath ? (
        <button
          type="button"
          className="directory-refresh-button"
          disabled={isScanning}
          title="刷新目录"
          aria-label="刷新目录"
          onClick={onRefreshDirectory}
        >
          {isScanning ? "…" : "↻"}
        </button>
      ) : null}
    </section>
  );
}

function DirectoryActions({
  rootPath,
  isScanning,
  onOpenDirectory,
  onImportDirectory,
}: Pick<
  TaskQueueProps,
  "rootPath" | "isScanning" | "onOpenDirectory" | "onImportDirectory"
>) {
  return (
    <div className="directory-actions">
      <button className="ghost-button" onClick={onOpenDirectory}>
        打开目录
      </button>
      <button
        className="ghost-button"
        disabled={!rootPath || isScanning}
        onClick={onImportDirectory}
      >
        导入音频
      </button>
    </div>
  );
}

function QueueSearch({
  stats,
  searchQuery,
  onSearchQueryChange,
}: Pick<
  TaskQueueProps,
  | "stats"
  | "searchQuery"
  | "onSearchQueryChange"
>) {
  if (stats.all === 0) {
    return null;
  }

  return (
    <section className="queue-toolbar queue-search-panel">
      <label className="queue-search">
        <span>搜索</span>
        <input
          placeholder="搜索音频文件"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
        />
      </label>
    </section>
  );
}

function QueueFilters({
  stats,
  fileFilter,
  onFileFilterChange,
}: Pick<TaskQueueProps, "stats" | "fileFilter" | "onFileFilterChange">) {
  if (stats.all === 0) {
    return null;
  }

  return (
    <section className="queue-toolbar">
      <div className="queue-filter-list" aria-label="任务筛选">
        {FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            className={
              fileFilter === filter.value
                ? "queue-filter-option active"
                : "queue-filter-option"
            }
            onClick={() => onFileFilterChange(filter.value)}
          >
            <span>{filter.label}</span>
            <strong>{stats[filter.stat]}</strong>
          </button>
        ))}
      </div>
    </section>
  );
}

interface AudioQueueItemProps
  extends Pick<
    TaskQueueProps,
    "dirtyPaths" | "savedPaths" | "entryOverrides" | "selectedAudioPath"
  > {
  entry: CorpusEntry;
  onSelectEntry: (entry: CorpusEntry) => void;
}

function AudioQueueItem({
  entry,
  selectedAudioPath,
  dirtyPaths,
  savedPaths,
  entryOverrides,
  onSelectEntry,
}: AudioQueueItemProps) {
  const state = getEntryState(entry, dirtyPaths, savedPaths, entryOverrides);
  const isActive = entry.audioPath === selectedAudioPath;

  return (
    <button
      type="button"
      data-audio-path={entry.audioPath}
      className={isActive ? "audio-queue-item active" : "audio-queue-item"}
      onClick={() => onSelectEntry(entry)}
    >
      <span className="audio-queue-item-main">
        <strong title={entry.stem}>{entry.stem}</strong>
        <span>
          {entry.relativeDir ? `${entry.relativeDir} · ` : null}
          {getEntryDuration(entry)}
        </span>
      </span>
      <span className={`audio-queue-state ${state}`}>
        {getSidebarStateLabel(state)}
      </span>
    </button>
  );
}

function AudioQueue({
  rootPath,
  tree,
  stats,
  dirtyPaths,
  savedPaths,
  entryOverrides,
  selectedAudioPath,
  treePanelRef,
  onClearFilters,
  onImportDirectory,
  onSelectEntry,
}: Pick<
  TaskQueueProps,
  | "rootPath"
  | "tree"
  | "stats"
  | "dirtyPaths"
  | "savedPaths"
  | "entryOverrides"
  | "selectedAudioPath"
  | "treePanelRef"
  | "onClearFilters"
  | "onImportDirectory"
  | "onSelectEntry"
>) {
  const entries = tree ? flattenQueueEntries(tree) : [];
  const isFilterEmpty = stats.all > 0 && entries.length === 0;

  return (
    <section className="audio-queue">
      <div className="audio-queue-heading">
        <h2>任务队列</h2>
        <span>{stats.all} 个音频</span>
      </div>

      <div ref={treePanelRef} className="audio-queue-list">
        {entries.length > 0 ? (
          entries.map((entry) => (
            <AudioQueueItem
              key={entry.audioPath}
              entry={entry}
              selectedAudioPath={selectedAudioPath}
              dirtyPaths={dirtyPaths}
              savedPaths={savedPaths}
              entryOverrides={entryOverrides}
              onSelectEntry={onSelectEntry}
            />
          ))
        ) : isFilterEmpty ? (
          <div className="audio-queue-empty">
            <h3>当前筛选下没有音频</h3>
            <p>切换筛选条件或清除搜索关键词</p>
            <button type="button" className="text-button" onClick={onClearFilters}>
              清空筛选
            </button>
          </div>
        ) : (
          <div className="audio-queue-empty">
            <h3>暂无音频任务</h3>
            <p>打开包含音频的目录后，待标注文件会按顺序出现在这里。</p>
            {rootPath ? (
              <button
                type="button"
                className="text-button"
                onClick={onImportDirectory}
              >
                导入音频
              </button>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

function SidebarFooter({ rootPath }: Pick<TaskQueueProps, "rootPath">) {
  return (
    <footer className="sidebar-footer">
      {rootPath ? "Space 播放 · M 标注 · S 保存 · E 擦除" : "尚未打开工作目录"}
    </footer>
  );
}

function SidebarActivityBar({
  activePanel,
  isCollapsed,
  stats,
  searchQuery,
  onSelectPanel,
}: Pick<
  TaskQueueProps,
  "stats" | "searchQuery"
> & {
  activePanel: SidebarPanel;
  isCollapsed: boolean;
  onSelectPanel: (panel: SidebarPanel) => void;
}) {
  return (
    <nav className="sidebar-activity-bar" aria-label="左侧视图">
      <div className="sidebar-activity-brand" aria-hidden="true">
        LA
      </div>
      <div className="sidebar-activity-actions">
        {SIDEBAR_PANELS.map((panel) => (
          <button
            key={panel.value}
            type="button"
            className={
              activePanel === panel.value
                ? "sidebar-activity-button active"
                : "sidebar-activity-button"
            }
            title={panel.label}
            aria-label={panel.label}
            aria-pressed={!isCollapsed && activePanel === panel.value}
            onClick={() => onSelectPanel(panel.value)}
          >
            <span aria-hidden="true">{panel.icon}</span>
            {panel.value === "queue" ? <em>{stats.all}</em> : null}
            {panel.value === "search" && searchQuery ? <em>{stats.all}</em> : null}
          </button>
        ))}
      </div>
    </nav>
  );
}

function SidebarShell({
  children,
  activePanel,
  isCollapsed,
  stats,
  searchQuery,
  onSelectPanel,
}: {
  children: ReactNode;
  activePanel: SidebarPanel;
  isCollapsed: boolean;
  stats: TaskQueueProps["stats"];
  searchQuery: string;
  onSelectPanel: (panel: SidebarPanel) => void;
}) {
  return (
    <aside className="sidebar paper-sidebar">
      <SidebarActivityBar
        activePanel={activePanel}
        isCollapsed={isCollapsed}
        stats={stats}
        searchQuery={searchQuery}
        onSelectPanel={onSelectPanel}
      />
      {children}
    </aside>
  );
}

export function TaskQueue({
  rootPath,
  tree,
  stats,
  isSidebarCollapsed,
  searchQuery,
  fileFilter,
  selectedAudioPath,
  dirtyPaths,
  savedPaths,
  entryOverrides,
  isScanning,
  treePanelRef,
  importDirectoryInputRef,
  onOpenDirectory,
  onImportDirectory,
  onImportDirectoryChange,
  onRefreshDirectory,
  onToggleSidebar,
  onSearchQueryChange,
  onFileFilterChange,
  onClearFilters,
  onSelectEntry,
}: TaskQueueProps) {
  const [activePanel, setActivePanel] = useState<SidebarPanel>("queue");

  const selectPanel = (panel: SidebarPanel) => {
    if (!isSidebarCollapsed && activePanel === panel) {
      onToggleSidebar();
      return;
    }

    setActivePanel(panel);
    if (isSidebarCollapsed) {
      onToggleSidebar();
    }
  };

  if (isSidebarCollapsed) {
    return (
      <aside className="sidebar paper-sidebar paper-sidebar-collapsed">
        <SidebarActivityBar
          activePanel={activePanel}
          isCollapsed={isSidebarCollapsed}
          stats={stats}
          searchQuery={searchQuery}
          onSelectPanel={selectPanel}
        />
      </aside>
    );
  }

  return (
    <SidebarShell
      activePanel={activePanel}
      isCollapsed={isSidebarCollapsed}
      stats={stats}
      searchQuery={searchQuery}
      onSelectPanel={selectPanel}
    >
      <input
        ref={importDirectoryInputRef}
        type="file"
        hidden
        accept=".wav,.flac,.mp3"
        multiple
        {...({ webkitdirectory: "" } as Record<string, string>)}
        onChange={onImportDirectoryChange}
      />
      {activePanel === "queue" ? (
        <div className="sidebar-panel sidebar-panel-queue">
          <SidebarHeader />
          <DirectorySummary
            rootPath={rootPath}
            stats={stats}
            isScanning={isScanning}
            onRefreshDirectory={onRefreshDirectory}
          />
          <DirectoryActions
            rootPath={rootPath}
            isScanning={isScanning}
            onOpenDirectory={onOpenDirectory}
            onImportDirectory={onImportDirectory}
          />
          <QueueFilters
            stats={stats}
            fileFilter={fileFilter}
            onFileFilterChange={onFileFilterChange}
          />
          <AudioQueue
            rootPath={rootPath}
            tree={tree}
            stats={stats}
            dirtyPaths={dirtyPaths}
            savedPaths={savedPaths}
            entryOverrides={entryOverrides}
            selectedAudioPath={selectedAudioPath}
            treePanelRef={treePanelRef}
            onClearFilters={onClearFilters}
            onImportDirectory={onImportDirectory}
            onSelectEntry={onSelectEntry}
          />
          <SidebarFooter rootPath={rootPath} />
        </div>
      ) : (
        <div className="sidebar-panel sidebar-panel-search">
          <SidebarHeader />
          <QueueSearch
            stats={stats}
            searchQuery={searchQuery}
            onSearchQueryChange={onSearchQueryChange}
          />
          <AudioQueue
            rootPath={rootPath}
            tree={tree}
            stats={stats}
            dirtyPaths={dirtyPaths}
            savedPaths={savedPaths}
            entryOverrides={entryOverrides}
            selectedAudioPath={selectedAudioPath}
            treePanelRef={treePanelRef}
            onClearFilters={onClearFilters}
            onImportDirectory={onImportDirectory}
            onSelectEntry={onSelectEntry}
          />
          <SidebarFooter rootPath={rootPath} />
        </div>
      )}
    </SidebarShell>
  );
}
