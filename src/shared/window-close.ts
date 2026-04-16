export type WindowCloseAction =
  | "save-and-exit"
  | "discard-and-exit"
  | "cancel";

export function mapCloseDialogResponse(response: number): WindowCloseAction {
  switch (response) {
    case 0:
      return "save-and-exit";
    case 1:
      return "discard-and-exit";
    default:
      return "cancel";
  }
}

export function getCloseDialogDetail(dirtyCount: number): string {
  if (dirtyCount === 1) {
    return "当前有 1 个未保存文件。选择“保存并退出”会先保存后关闭应用。";
  }

  return `当前有 ${dirtyCount} 个未保存文件。选择“保存并退出”会先保存全部文件后关闭应用。`;
}
