import { describe, expect, it } from "vitest";

import {
  auditionTimeToSeconds,
  parseAuditionText,
  secondsToAuditionTime,
  serializeAuditionText,
} from "./audition";

describe("audition formatter", () => {
  it("formats seconds using Audition-compatible timestamps", () => {
    expect(secondsToAuditionTime(65.432)).toBe("1:05.432");
    expect(secondsToAuditionTime(3665.432)).toBe("1:01:05.432");
  });

  it("parses serialized segments without changing timing", () => {
    const text = serializeAuditionText([
      { startSec: 0.5, endSec: 1.25 },
      { startSec: 4.5, endSec: 5.75 },
    ]);

    expect(parseAuditionText(text)).toEqual([
      { startSec: 0.5, endSec: 1.25 },
      { startSec: 4.5, endSec: 5.75 },
    ]);
    expect(auditionTimeToSeconds("1:05.432")).toBeCloseTo(65.432, 6);
  });
});
