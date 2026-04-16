import { describe, expect, it, vi } from "vitest";

import {
  saveDirtyDocuments,
  type DirtyDocumentForSave,
} from "./close-flow";

function createDocument(
  audioPath: string,
  stem: string,
): DirtyDocumentForSave {
  return {
    audioPath,
    csvPath: null,
    stem,
    segments: [{ startSec: 0.1, endSec: 0.3 }],
  };
}

describe("saveDirtyDocuments", () => {
  it("saves dirty documents in order and reports each saved file", async () => {
    const documentsByPath = new Map([
      ["alpha.wav", createDocument("alpha.wav", "alpha")],
      ["beta.wav", createDocument("beta.wav", "beta")],
    ]);
    const saveAnnotation = vi
      .fn()
      .mockResolvedValueOnce({ csvPath: "/tmp/alpha.csv" })
      .mockResolvedValueOnce({ csvPath: "/tmp/beta.csv" });
    const onSaved = vi.fn();

    const result = await saveDirtyDocuments({
      dirtyPaths: ["alpha.wav", "beta.wav"],
      documentsByPath,
      saveAnnotation,
      onSaved,
    });

    expect(saveAnnotation).toHaveBeenNthCalledWith(1, {
      audioPath: "alpha.wav",
      csvPath: null,
      segments: [{ startSec: 0.1, endSec: 0.3 }],
    });
    expect(saveAnnotation).toHaveBeenNthCalledWith(2, {
      audioPath: "beta.wav",
      csvPath: null,
      segments: [{ startSec: 0.1, endSec: 0.3 }],
    });
    expect(onSaved).toHaveBeenCalledTimes(2);
    expect(result).toEqual([
      {
        audioPath: "alpha.wav",
        csvPath: "/tmp/alpha.csv",
        stem: "alpha",
      },
      {
        audioPath: "beta.wav",
        csvPath: "/tmp/beta.csv",
        stem: "beta",
      },
    ]);
  });

  it("stops at the first save failure", async () => {
    const documentsByPath = new Map([
      ["alpha.wav", createDocument("alpha.wav", "alpha")],
      ["beta.wav", createDocument("beta.wav", "beta")],
      ["gamma.wav", createDocument("gamma.wav", "gamma")],
    ]);
    const saveAnnotation = vi
      .fn()
      .mockResolvedValueOnce({ csvPath: "/tmp/alpha.csv" })
      .mockRejectedValueOnce(new Error("disk full"));
    const onSaved = vi.fn();

    await expect(
      saveDirtyDocuments({
        dirtyPaths: ["alpha.wav", "beta.wav", "gamma.wav"],
        documentsByPath,
        saveAnnotation,
        onSaved,
      }),
    ).rejects.toThrow("disk full");

    expect(saveAnnotation).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith({
      audioPath: "alpha.wav",
      csvPath: "/tmp/alpha.csv",
      stem: "alpha",
    });
  });
});
