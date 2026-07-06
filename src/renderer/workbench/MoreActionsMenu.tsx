import { useEffect, useRef, useState } from "react";
import { ThemeControl } from "svara-ui/labelau";

import type { MoreActionsMenuProps } from "./types";

export function MoreActionsMenu({
  canDiscardChanges,
  canExportDataset,
  canUndo,
  isExporting,
  uiThemePreference,
  onDiscardChanges,
  onExportDataset,
  onOpenEngineSettings,
  onOpenHelp,
  onUndo,
  onThemeChange,
}: MoreActionsMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as Node | null)
      ) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  const runAndClose = (action: () => void) => {
    action();
    setIsOpen(false);
  };

  const exportReason = canExportDataset
    ? null
    : "需要先有已保存的标注数据";
  const discardReason = canDiscardChanges ? null : "当前无未保存修改";
  const undoReason = canUndo ? null : "当前没有可撤销操作";

  return (
    <div className="more-actions" ref={menuRef}>
      <button
        type="button"
        className="ghost-button more-actions-trigger"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((previous) => !previous)}
      >
        更多
      </button>

      {isOpen ? (
        <div className="more-actions-panel" role="menu">
          <div className="more-actions-group">
            <p>文件操作</p>
            <button
              type="button"
              role="menuitem"
              disabled={!canExportDataset || isExporting}
              title={exportReason ?? undefined}
              onClick={() => runAndClose(onExportDataset)}
            >
              <span>{isExporting ? "导出中" : "导出标注数据"}</span>
              {exportReason ? <em>{exportReason}</em> : null}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!canUndo}
              title={undoReason ?? undefined}
              onClick={() => runAndClose(onUndo)}
            >
              <span>撤销上一步</span>
              {undoReason ? <em>{undoReason}</em> : null}
            </button>
            <button
              type="button"
              role="menuitem"
              className="danger-menu-item"
              disabled={!canDiscardChanges}
              title={discardReason ?? undefined}
              onClick={() => runAndClose(onDiscardChanges)}
            >
              <span>舍弃未保存更改</span>
              {discardReason ? <em>{discardReason}</em> : null}
            </button>
          </div>

          <div className="more-actions-group">
            <p>工具设置</p>
            <button
              type="button"
              role="menuitem"
              onClick={() => runAndClose(onOpenEngineSettings)}
            >
              <span>引擎设置</span>
            </button>
          </div>

          <div className="more-actions-group">
            <p>帮助与外观</p>
            <button
              type="button"
              role="menuitem"
              onClick={() => runAndClose(onOpenHelp)}
            >
              <span>帮助</span>
            </button>
          </div>

          <div className="more-actions-theme">
            <ThemeControl
              value={uiThemePreference}
              onChange={(value) => {
                onThemeChange(value);
                setIsOpen(false);
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
