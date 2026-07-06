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
  datasetState,
  stats,
}: Pick<TaskQueueProps, "rootPath" | "datasetState" | "stats">): string {
  if (datasetState === "invalid") {
    return "目录不可用 · 请重新选择";
  }

  if (datasetState === "scanning") {
    return "正在扫描目录";
  }

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
    default:
      return "未处理";
  }
}

function getSidebarStateTone(state: EntryState): string {
  switch (state) {
    case "dirty":
      return "warning";
    case "matched":
    case "saved":
      return "success";
    case "new":
      return "neutral";
    default:
      return "neutral";
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
  datasetState,
  datasetErrorMessage,
  stats,
  isScanning,
  onRefreshDirectory,
}: Pick<
  TaskQueueProps,
  | "rootPath"
  | "datasetState"
  | "datasetErrorMessage"
  | "stats"
  | "isScanning"
  | "onRefreshDirectory"
>) {
  return (
    <section
      className={
        datasetState === "invalid"
          ? "directory-summary directory-summary-invalid"
          : "directory-summary"
      }
      title={(datasetErrorMessage ?? rootPath) || undefined}
    >
      <div className="directory-summary-main">
        <strong>{getDirectoryName(rootPath)}</strong>
        <span>{getDirectoryStatus({ rootPath, datasetState, stats })}</span>
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
  datasetState,
  isScanning,
  onOpenDirectory,
  onImportDirectory,
  onClearRememberedDirectory,
}: Pick<
  TaskQueueProps,
  | "rootPath"
  | "datasetState"
  | "isScanning"
  | "onOpenDirectory"
  | "onImportDirectory"
  | "onClearRememberedDirectory"
>) {
  const canImport =
    Boolean(rootPath) &&
    !isScanning &&
    (datasetState === "ready" || datasetState === "empty");

  return (
    <div className="directory-actions">
      <button className="ghost-button" onClick={onOpenDirectory}>
        {rootPath ? "更换目录" : "打开目录"}
      </button>
      <button
        className="ghost-button"
        disabled={!canImport}
        onClick={onImportDirectory}
      >
        导入音频
      </button>
      {datasetState === "invalid" ? (
        <button
          className="ghost-button"
          type="button"
          onClick={onClearRememberedDirectory}
        >
          清除路径
        </button>
      ) : null}
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
      <span className={`audio-queue-state ${state} ${getSidebarStateTone(state)}`}>
        {getSidebarStateLabel(state)}
      </span>
    </button>
  );
}

function AudioQueue({
  rootPath,
  datasetState,
  tree,
  stats,
  dirtyPaths,
  savedPaths,
  entryOverrides,
  selectedAudioPath,
  treePanelRef,
  searchQuery,
  onClearFilters,
  onImportDirectory,
  onSelectEntry,
}: Pick<
  TaskQueueProps,
  | "rootPath"
  | "datasetState"
  | "tree"
  | "stats"
  | "dirtyPaths"
  | "savedPaths"
  | "entryOverrides"
  | "selectedAudioPath"
  | "treePanelRef"
  | "searchQuery"
  | "onClearFilters"
  | "onImportDirectory"
  | "onSelectEntry"
>) {
  const entries = tree ? flattenQueueEntries(tree) : [];
  const isFilterEmpty = stats.all > 0 && entries.length === 0;
  const isSearchEmpty = isFilterEmpty && searchQuery.trim().length > 0;
  const canImport =
    Boolean(rootPath) && (datasetState === "ready" || datasetState === "empty");

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
            <h3>{isSearchEmpty ? "没有匹配的音频文件" : "当前筛选下没有音频"}</h3>
            <p>{isSearchEmpty ? "换一个文件名或目录关键词再试。" : "切换筛选条件或清除搜索关键词。"}</p>
            <button type="button" className="text-button" onClick={onClearFilters}>
              清空筛选
            </button>
          </div>
        ) : (
          <div className="audio-queue-empty">
            <h3>{datasetState === "invalid" ? "目录不可用" : "暂无音频任务"}</h3>
            <p>
              {datasetState === "invalid"
                ? "请重新选择目录，或清除已记住路径后重新开始。"
                : "打开包含音频的目录后，待标注文件会按顺序出现在这里。"}
            </p>
            {canImport ? (
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

function SidebarFooter({
  rootPath,
  datasetState,
}: Pick<TaskQueueProps, "rootPath" | "datasetState">) {
  return (
    <footer className="sidebar-footer">
      {datasetState === "invalid"
        ? "目录不可用，请重新选择"
        : rootPath
          ? "Space 播放 · M 标注 · S 保存 · E 擦除"
          : "尚未打开工作目录"}
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
  datasetState,
  datasetErrorMessage,
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
  onClearRememberedDirectory,
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
            datasetState={datasetState}
            datasetErrorMessage={datasetErrorMessage}
            stats={stats}
            isScanning={isScanning}
            onRefreshDirectory={onRefreshDirectory}
          />
          <DirectoryActions
            rootPath={rootPath}
            datasetState={datasetState}
            isScanning={isScanning}
            onOpenDirectory={onOpenDirectory}
            onImportDirectory={onImportDirectory}
            onClearRememberedDirectory={onClearRememberedDirectory}
          />
          <QueueFilters
            stats={stats}
            fileFilter={fileFilter}
            onFileFilterChange={onFileFilterChange}
          />
          <AudioQueue
            rootPath={rootPath}
            datasetState={datasetState}
            tree={tree}
            stats={stats}
            dirtyPaths={dirtyPaths}
            savedPaths={savedPaths}
            entryOverrides={entryOverrides}
            selectedAudioPath={selectedAudioPath}
            treePanelRef={treePanelRef}
            searchQuery={searchQuery}
            onClearFilters={onClearFilters}
            onImportDirectory={onImportDirectory}
            onSelectEntry={onSelectEntry}
          />
          <SidebarFooter rootPath={rootPath} datasetState={datasetState} />
        </div>
      ) : (
        <div className="sidebar-panel sidebar-panel-search">
          <SidebarHeader />
          <DirectorySummary
            rootPath={rootPath}
            datasetState={datasetState}
            datasetErrorMessage={datasetErrorMessage}
            stats={stats}
            isScanning={isScanning}
            onRefreshDirectory={onRefreshDirectory}
          />
          <DirectoryActions
            rootPath={rootPath}
            datasetState={datasetState}
            isScanning={isScanning}
            onOpenDirectory={onOpenDirectory}
            onImportDirectory={onImportDirectory}
            onClearRememberedDirectory={onClearRememberedDirectory}
          />
          <QueueSearch
            stats={stats}
            searchQuery={searchQuery}
            onSearchQueryChange={onSearchQueryChange}
          />
          <AudioQueue
            rootPath={rootPath}
            datasetState={datasetState}
            tree={tree}
            stats={stats}
            dirtyPaths={dirtyPaths}
            savedPaths={savedPaths}
            entryOverrides={entryOverrides}
            selectedAudioPath={selectedAudioPath}
            treePanelRef={treePanelRef}
            searchQuery={searchQuery}
            onClearFilters={onClearFilters}
            onImportDirectory={onImportDirectory}
            onSelectEntry={onSelectEntry}
          />
          <SidebarFooter rootPath={rootPath} datasetState={datasetState} />
        </div>
      )}
    </SidebarShell>
  );
}
