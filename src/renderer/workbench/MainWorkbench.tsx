import { formatSeconds, getToolLabel } from "svara-ui/labelau";

import type { MainWorkbenchProps } from "./types";

function getFrequencyScaleLabel(value: MainWorkbenchProps["frequencyScale"]): string {
  switch (value) {
    case "linear":
      return "线性";
    case "mel":
      return "MEL";
    case "log":
      return "对数";
  }
}

function getTitle(props: MainWorkbenchProps): string {
  if (props.currentDocument) {
    return props.currentDocument.stem;
  }

  switch (props.mode) {
    case "no-directory":
      return "打开音频目录开始标注";
    case "invalid-directory":
      return "数据集目录不可用";
    case "empty-directory":
      return "当前目录没有可标注音频";
    case "no-selection":
      return props.isLoadingDocument ? "正在载入音频" : "选择左侧音频开始标注";
    case "ready":
      return "音频标注工作台";
  }
}

function getSubtitle(props: MainWorkbenchProps): string {
  if (props.currentDocument) {
    const indexLabel =
      props.selectedFileContext?.index === null ||
      props.selectedFileContext?.index === undefined
        ? null
        : `${props.selectedFileContext.index + 1} / ${props.selectedFileContext.total}`;
    const stateLabel = props.selectedFileContext?.stateLabel ?? "待开始";
    return [indexLabel, stateLabel].filter(Boolean).join(" · ");
  }

  switch (props.mode) {
    case "no-directory":
      return "选择一个包含音频文件的目录后，LabelAU 会生成待标注队列。";
    case "invalid-directory":
      return props.datasetErrorMessage ?? "上次使用的目录无法访问，请重新选择。";
    case "empty-directory":
      return "请导入音频，或切换到包含音频文件的目录。";
    case "no-selection":
      return props.isLoadingDocument
        ? "正在准备波形、时间轴和频谱视图。"
        : "标注区会显示波形、时间轴和片段轨道。";
    case "ready":
      return "";
  }
}

function EmptyWorkbenchState({
  mode,
  rootPath,
  datasetErrorMessage,
  onOpenDirectory,
  onImportDirectory,
  onClearRememberedDirectory,
}: Pick<
  MainWorkbenchProps,
  | "mode"
  | "rootPath"
  | "datasetErrorMessage"
  | "onOpenDirectory"
  | "onImportDirectory"
  | "onClearRememberedDirectory"
>) {
  if (mode === "invalid-directory") {
    return (
      <div className="workbench-empty-state workbench-empty-state-centered">
        <div className="workbench-empty-copy workbench-error-card">
          <div className="workbench-empty-icon" aria-hidden="true">
            !
          </div>
          <p className="eyebrow">目录不可用</p>
          <h2>找不到上次打开的数据集目录</h2>
          <p>上次记住的目录已经不存在或无法访问，你可以重新选择目录继续工作。</p>
          {rootPath ? <code className="workbench-error-path">{rootPath}</code> : null}
          {datasetErrorMessage ? (
            <p className="workbench-error-detail">{datasetErrorMessage}</p>
          ) : null}
          <div className="workbench-empty-actions">
            <button type="button" className="action-button" onClick={onOpenDirectory}>
              重新选择目录
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={onClearRememberedDirectory}
            >
              清除已记住路径
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (mode === "no-directory") {
    return (
      <div className="workbench-empty-state workbench-empty-state-centered">
        <div className="workbench-empty-copy">
          <div className="workbench-empty-icon" aria-hidden="true">
            ~
          </div>
          <p className="eyebrow">开始工作</p>
          <h2>打开音频目录开始标注</h2>
          <p>
            选择一个包含 WAV、FLAC 或 MP3 文件的目录后，LabelAU 会生成待标注队列。
          </p>
          <div className="workbench-empty-actions">
            <button type="button" className="action-button" onClick={onOpenDirectory}>
              打开目录
            </button>
            <button type="button" className="ghost-button" onClick={onImportDirectory}>
              导入音频
            </button>
          </div>
          <p className="workbench-shortcuts">Space 播放 · M 标注 · S 保存</p>
        </div>
      </div>
    );
  }

  if (mode === "empty-directory") {
    return (
      <div className="workbench-empty-state workbench-empty-state-centered">
        <div className="workbench-empty-copy">
          <div className="workbench-empty-icon" aria-hidden="true">
            ~
          </div>
          <p className="eyebrow">当前目录</p>
          <h2>当前目录没有可标注音频</h2>
          <p>
            此目录中没有找到 WAV、FLAC 或 MP3 文件。你可以导入音频，或切换到包含音频文件的目录。
          </p>
          <div className="workbench-empty-actions">
            <button type="button" className="action-button" onClick={onImportDirectory}>
              导入音频
            </button>
            <button type="button" className="ghost-button" onClick={onOpenDirectory}>
              更换目录
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="workbench-empty-state workbench-empty-state-skeleton">
      <div className="workbench-empty-copy">
        <p className="eyebrow">下一步</p>
        <h2>选择左侧音频开始标注</h2>
        <p>
          标注区会显示波形、时间轴和片段轨道。你可以使用 Space 播放，M 创建标注，S 保存结果。
        </p>
      </div>
      <div className="workbench-skeleton" aria-hidden="true">
        <div className="skeleton-title" />
        <div className="skeleton-waveform" />
        <div className="skeleton-timeline" />
        <div className="skeleton-track" />
      </div>
    </div>
  );
}

export function MainWorkbench(props: MainWorkbenchProps) {
  const {
    currentDocument,
    selectedSegment,
    selectedSegmentIndex,
    previousEntry,
    nextEntry,
    isSaving,
    isRunningVad,
    isRunningAsr,
    isDenoising,
    isPlaying,
    heldTool,
    frequencyScale,
    playbackRate,
    denoiseActionLabel,
    isInspectorOpen,
    showSpectrogram,
    inspector,
    statusBar,
    children,
    onSelectPrevious,
    onSelectNext,
    onSaveCurrent,
    onRunVad,
    onRunAsr,
    onDenoise,
    onTogglePlayback,
    onCycleTool,
    onToggleFrequencyScale,
    onCyclePlaybackRate,
    moreActions,
    editorRef,
  } = props;

  const canUseDocumentActions =
    Boolean(currentDocument) && !isRunningVad && !isRunningAsr && !isDenoising;

  return (
    <main
      className={
        isInspectorOpen
          ? "workspace paper-workspace inspector-open"
          : "workspace paper-workspace"
      }
    >
      <header className="workspace-header paper-workspace-header">
        <div className="paper-topbar">
          <div className="toolbar-title">
            <h2>{getTitle(props)}</h2>
            <p className="toolbar-subtitle">{getSubtitle(props)}</p>
          </div>

          <div className="toolbar-actions paper-toolbar-actions">
            <button
              className="ghost-button toolbar-nav-button"
              disabled={!previousEntry}
              onClick={onSelectPrevious}
            >
              上一条
            </button>
            <button
              className="ghost-button toolbar-nav-button"
              disabled={!nextEntry}
              onClick={onSelectNext}
            >
              下一条
            </button>
            <button
              className={
                currentDocument?.isDirty
                  ? "action-button action-button-attention"
                  : "action-button"
              }
              disabled={!currentDocument || isSaving}
              onClick={onSaveCurrent}
            >
              {isSaving ? "保存中" : "保存标注"}
            </button>
            {moreActions}
          </div>
        </div>

        {props.mode === "invalid-directory" ? (
          <div className="paper-alert paper-alert-error">
            <span>目录不可用</span>
            <strong>{props.datasetErrorMessage ?? "上次打开的数据集目录无法访问。"}</strong>
          </div>
        ) : null}

        {currentDocument ? (
          <div className="paper-controlbar">
            <div className="toolbar-controls paper-toolbar-controls">
              <div className="toolbar-control-group toolbar-control-group-playback">
                <button
                  className="ghost-button tool-button playback-button"
                  disabled={!canUseDocumentActions}
                  onClick={onTogglePlayback}
                >
                  {isPlaying ? "暂停" : "播放"}
                </button>
              </div>
              <div className="toolbar-control-group">
                <button
                  className="ghost-button tool-button toolbar-toggle"
                  disabled={!currentDocument}
                  onClick={onCycleTool}
                >
                  工具：{getToolLabel(heldTool)}
                </button>
                {showSpectrogram ? (
                  <button
                    className="ghost-button tool-button toolbar-toggle"
                    disabled={!currentDocument}
                    onClick={onToggleFrequencyScale}
                  >
                    频率：{getFrequencyScaleLabel(frequencyScale)}
                  </button>
                ) : null}
                <button
                  className="ghost-button tool-button toolbar-toggle"
                  disabled={!currentDocument}
                  onClick={onCyclePlaybackRate}
                >
                  倍速：{playbackRate}x
                </button>
              </div>
              <div className="toolbar-control-group">
                <button
                  className="ghost-button tool-button"
                  disabled={!canUseDocumentActions}
                  onClick={onRunVad}
                >
                  {isRunningVad ? "预标注中" : "VAD 自动切分"}
                </button>
                <button
                  className="ghost-button tool-button"
                  disabled={!canUseDocumentActions}
                  onClick={onRunAsr}
                >
                  {isRunningAsr ? "ASR 预标注中" : "ASR 预标注"}
                </button>
                <button
                  className="ghost-button tool-button"
                  disabled={!canUseDocumentActions}
                  onClick={onDenoise}
                >
                  {denoiseActionLabel}
                </button>
              </div>
            </div>

            <div className="toolbar-metrics paper-toolbar-metrics">
              <span>
                {formatSeconds(0)} -{" "}
                {formatSeconds(currentDocument.durationSec)}
              </span>
              <span>标注段 {currentDocument.segments.length}</span>
              {selectedSegment ? (
                <span>
                  片段{" "}
                  {typeof selectedSegmentIndex === "number"
                    ? selectedSegmentIndex + 1
                    : "-"}
                  ：{formatSeconds(selectedSegment.startSec)} /{" "}
                  {formatSeconds(selectedSegment.endSec)}
                </span>
              ) : (
                <span>未选择片段</span>
              )}
            </div>
          </div>
        ) : null}
      </header>

      <div className="paper-workbench-body">
        <section
          ref={editorRef}
          className={
            currentDocument
              ? showSpectrogram
                ? "editor paper-editor"
                : "editor paper-editor paper-editor-waveform-only"
              : "editor paper-editor paper-editor-empty"
          }
        >
          {currentDocument ? (
            children
          ) : (
            <EmptyWorkbenchState
              mode={props.mode}
              rootPath={props.rootPath}
              datasetErrorMessage={props.datasetErrorMessage}
              onOpenDirectory={props.onOpenDirectory}
              onImportDirectory={props.onImportDirectory}
              onClearRememberedDirectory={props.onClearRememberedDirectory}
            />
          )}
        </section>
        {inspector}
      </div>

      {statusBar}
    </main>
  );
}
