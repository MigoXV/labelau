import { describe, expect, it } from "vitest";

import {
  getCloseDialogDetail,
  mapCloseDialogResponse,
} from "./window-close";

describe("window close dialog helpers", () => {
  it("maps dialog button indexes to close actions", () => {
    expect(mapCloseDialogResponse(0)).toBe("save-and-exit");
    expect(mapCloseDialogResponse(1)).toBe("discard-and-exit");
    expect(mapCloseDialogResponse(2)).toBe("cancel");
    expect(mapCloseDialogResponse(99)).toBe("cancel");
  });

  it("formats the close confirmation detail using the dirty file count", () => {
    expect(getCloseDialogDetail(1)).toContain("1 个未保存文件");
    expect(getCloseDialogDetail(3)).toContain("3 个未保存文件");
  });
});
