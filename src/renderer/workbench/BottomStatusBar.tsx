import type { StatusBarViewModel } from "./types";

interface BottomStatusBarProps {
  viewModel: StatusBarViewModel;
}

const SHORTCUTS_TITLE = "Space 播放 · M 标注 · S 保存 · E 擦除";

export function BottomStatusBar({ viewModel }: BottomStatusBarProps) {
  return (
    <footer className="status-bar paper-status-bar">
      <div className="status-group status-group-time">
        <span className="status-chip">{viewModel.timeLabel}</span>
      </div>

      <div className="status-group status-group-main">
        {viewModel.chips.map((chip) => (
          <span
            className="status-chip"
            key={chip}
            title={chip === "快捷键" ? SHORTCUTS_TITLE : undefined}
          >
            {chip}
          </span>
        ))}
      </div>

      <div className="status-group status-group-message">
        <span className={viewModel.isError ? "error-text" : undefined}>
          {viewModel.message}
        </span>
      </div>
    </footer>
  );
}
