import { formatSeconds } from "svara-ui/labelau";

import type { RightInspectorProps } from "./types";

export function RightInspector({
  isOpen,
  currentDocument,
  selectedSegment,
  selectedSegmentIndex,
  currentStateLabel,
  onTranscriptChange,
  onToggle,
}: RightInspectorProps) {
  const title = selectedSegment ? "当前标注片段" : "未选择标注片段";

  if (!isOpen) {
    return (
      <aside
        className="right-inspector right-inspector-collapsed"
        aria-label="片段信息"
      >
        <button
          type="button"
          className="inspector-drawer-button"
          title="展开片段信息"
          aria-label="展开片段信息"
          disabled={!currentDocument}
          onClick={onToggle}
        >
          ←
        </button>
      </aside>
    );
  }

  const segmentDuration =
    selectedSegment && selectedSegment.endSec > selectedSegment.startSec
      ? selectedSegment.endSec - selectedSegment.startSec
      : null;

  return (
    <aside className="right-inspector right-inspector-open" aria-label="片段信息">
      <button
        type="button"
        className="inspector-drawer-button"
        title="收起片段信息"
        aria-label="收起片段信息"
        onClick={onToggle}
      >
        →
      </button>
      <div className="right-inspector-header">
        <div>
          <p className="eyebrow">Inspector</p>
          <h2>片段检查器</h2>
        </div>
      </div>

      {selectedSegment ? (
        <div className="inspector-section">
          <div className="inspector-section-heading">
            <p className="eyebrow">当前标注片段</p>
            <strong>
              {typeof selectedSegmentIndex === "number"
                ? `片段 ${selectedSegmentIndex + 1}`
                : "片段"}
            </strong>
          </div>
          <dl className="inspector-list">
            <div>
              <dt>标签</dt>
              <dd>
                {typeof selectedSegmentIndex === "number"
                  ? `标注段 ${selectedSegmentIndex + 1}`
                  : "标注段"}
              </dd>
            </div>
            <div>
              <dt>起始时间</dt>
              <dd>{formatSeconds(selectedSegment.startSec)}</dd>
            </div>
            <div>
              <dt>结束时间</dt>
              <dd>{formatSeconds(selectedSegment.endSec)}</dd>
            </div>
            <div>
              <dt>时长</dt>
              <dd>{segmentDuration === null ? "-" : formatSeconds(segmentDuration)}</dd>
            </div>
            <div>
              <dt>保存状态</dt>
              <dd>{currentDocument?.isDirty ? "未保存" : "已保存"}</dd>
            </div>
          </dl>
          {typeof selectedSegmentIndex === "number" ? (
            <label className="inspector-field">
              <span>转写内容</span>
              <textarea
                value={selectedSegment.transcript ?? ""}
                placeholder="输入当前片段的转写文本"
                onChange={(event) =>
                  onTranscriptChange(selectedSegmentIndex, event.target.value)
                }
              />
            </label>
          ) : null}
          <p className="inspector-hint">
            可在波形或频谱中拖拽边界调整片段，转写修改会进入未保存状态。
          </p>
        </div>
      ) : (
        <div className="inspector-empty">
          <h3>{title}</h3>
          <p>在波形中拖拽选择一段音频，或使用 M 创建标注片段。</p>
        </div>
      )}

      <div className="inspector-section">
        <div className="inspector-section-heading">
          <p className="eyebrow">当前文件</p>
          <strong>{currentDocument?.stem ?? "未选择文件"}</strong>
        </div>
        <dl className="inspector-list">
          <div>
            <dt>文件状态</dt>
            <dd>{currentDocument ? currentStateLabel : "未选择"}</dd>
          </div>
          <div>
            <dt>标注段</dt>
            <dd>{currentDocument ? currentDocument.segments.length : 0}</dd>
          </div>
          <div>
            <dt>已转写</dt>
            <dd>
              {currentDocument
                ? currentDocument.segments.filter((segment) =>
                    Boolean(segment.transcript?.trim()),
                  ).length
                : 0}
            </dd>
          </div>
          <div>
            <dt>保存状态</dt>
            <dd>{currentDocument?.isDirty ? "未保存" : "已保存"}</dd>
          </div>
          <div>
            <dt>音频视图</dt>
            <dd>
              {currentDocument?.activeAudioView === "denoised"
                ? "降噪音频"
                : "原始音频"}
            </dd>
          </div>
        </dl>
      </div>
    </aside>
  );
}
