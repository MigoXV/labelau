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
          <button
            type="button"
            role="menuitem"
            disabled={!canUndo}
            onClick={() => runAndClose(onUndo)}
          >
            撤销上一步
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!canDiscardChanges}
            onClick={() => runAndClose(onDiscardChanges)}
          >
            舍弃未保存更改
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!canExportDataset}
            onClick={() => runAndClose(onExportDataset)}
          >
            {isExporting ? "导出中" : "导出标注数据集"}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => runAndClose(onOpenEngineSettings)}
          >
            引擎设置
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => runAndClose(onOpenHelp)}
          >
            帮助
          </button>

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
