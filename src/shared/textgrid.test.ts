import { describe, expect, it } from "vitest";

import {
  parseTextGridAnnotationText,
  serializeTextGrid,
} from "./textgrid";

describe("TextGrid annotations", () => {
  it("serializes annotation segments as a Praat long TextGrid", () => {
    const text = serializeTextGrid(
      [
        { startSec: 0.25, endSec: 0.5, transcript: 'hello "world"' },
        { startSec: 0.75, endSec: 1, transcript: "done" },
      ],
      1.25,
    );

    expect(text).toContain('File type = "ooTextFile"');
    expect(text).toContain('Object class = "TextGrid"');
    expect(text).toContain('name = "transcript"');
    expect(text).toContain("intervals: size = 5");
    expect(text).toContain('text = "hello ""world"""');
    expect(text).toContain("xmax = 1.25");
  });

  it("parses the transcript tier and ignores empty filler intervals", () => {
    const source = serializeTextGrid(
      [
        { startSec: 0.25, endSec: 0.5, transcript: 'hello "world"' },
        { startSec: 0.75, endSec: 1, transcript: "done" },
      ],
      1.25,
    );

    expect(parseTextGridAnnotationText(source)).toEqual([
      {
        id: "textgrid_0",
        startSec: 0.25,
        endSec: 0.5,
        transcript: 'hello "world"',
      },
      {
        id: "textgrid_1",
        startSec: 0.75,
        endSec: 1,
        transcript: "done",
      },
    ]);
  });

  it("parses multi-line Praat text entries", () => {
    const source = [
      'File type = "ooTextFile"',
      'Object class = "TextGrid"',
      "",
      "xmin = 0",
      "xmax = 2",
      "tiers? <exists>",
      "size = 1",
      "item []:",
      "\titem [1]:",
      '\t\tclass = "IntervalTier"',
      '\t\tname = "transcript"',
      "\t\txmin = 0",
      "\t\txmax = 2",
      "\t\tintervals: size = 1",
      "\t\t\tintervals [1]:",
      "\t\t\t\txmin = 0.1",
      "\t\t\t\txmax = 0.3",
      '\t\t\t\ttext = "first line',
      'second ""line"""',
      "",
    ].join("\n");

    expect(parseTextGridAnnotationText(source)[0]).toMatchObject({
      startSec: 0.1,
      endSec: 0.3,
      transcript: 'first line\nsecond "line"',
    });
  });
});
