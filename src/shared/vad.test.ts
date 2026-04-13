import { describe, expect, it } from "vitest";

import { addSegment, eraseSegment, normalizeSegments } from "./vad";

describe("vad segment operations", () => {
  it("coalesces overlapping and adjacent segments", () => {
    expect(
      normalizeSegments([
        { startSec: 1, endSec: 2 },
        { startSec: 1.5, endSec: 3 },
        { startSec: 3, endSec: 3.5 },
      ]),
    ).toEqual([{ startSec: 1, endSec: 3.5 }]);
  });

  it("adds a segment into the current track", () => {
    expect(
      addSegment(
        [
          { startSec: 0, endSec: 1 },
          { startSec: 3, endSec: 4 },
        ],
        { startSec: 0.75, endSec: 3.25 },
      ),
    ).toEqual([{ startSec: 0, endSec: 4 }]);
  });

  it("erases a partial range from the current track", () => {
    expect(
      eraseSegment([{ startSec: 0, endSec: 5 }], { startSec: 1, endSec: 3 }),
    ).toEqual([
      { startSec: 0, endSec: 1 },
      { startSec: 3, endSec: 5 },
    ]);
  });
});
