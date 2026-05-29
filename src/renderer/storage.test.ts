import { afterEach, describe, expect, it } from "vitest";

import {
  readStoredJson,
  readStoredNumber,
  readStoredString,
  writeStoredJson,
  writeStoredNumber,
  writeStoredString,
} from "./storage";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    localStorage: new MemoryStorage(),
  },
});

describe("renderer storage", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("stores values with the LabelAU prefix", () => {
    writeStoredString("theme", "dark");
    writeStoredNumber("sidebar-width", 232);
    writeStoredJson("engine", { vadGrpcUrl: "127.0.0.1:50051" });

    expect(window.localStorage.getItem("labelau:theme")).toBe("dark");
    expect(readStoredString("theme")).toBe("dark");
    expect(readStoredNumber("sidebar-width", 320)).toBe(232);
    expect(readStoredJson("engine", { vadGrpcUrl: "" })).toEqual({
      vadGrpcUrl: "127.0.0.1:50051",
    });
  });

  it("falls back and clamps invalid values", () => {
    writeStoredString("bad-json", "{");
    writeStoredString("too-small", "12");

    expect(readStoredJson("bad-json", { ok: true })).toEqual({ ok: true });
    expect(readStoredNumber("missing", 320)).toBe(320);
    expect(readStoredNumber("too-small", 320, { min: 240, max: 520 })).toBe(240);
  });
});
