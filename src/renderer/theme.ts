import type { CSSProperties } from "react";
import { useEffect, useState } from "react";

export type SystemThemeMode = "light" | "dark";
export type UiThemePreference = "system" | "light" | "dark";

export interface CanvasTheme {
  mode: SystemThemeMode;
  spectrogramBackground: string;
  overlayBase: string;
  overlayBaseEdge: string;
  overlayMark: string;
  overlayMarkEdge: string;
  overlayErase: string;
  overlayEraseEdge: string;
  playhead: string;
  frequencyLabel: string;
  frequencyGuide: string;
}

export interface WaveformTheme {
  mode: SystemThemeMode;
  background: string;
  laneEven: string;
  laneOdd: string;
  waveform: string;
  label: string;
  grid: string;
  playhead: string;
  overlayBase: string;
  overlayBaseEdge: string;
  overlayMark: string;
  overlayMarkEdge: string;
  overlayErase: string;
  overlayEraseEdge: string;
}

const darkTheme: CanvasTheme = {
  mode: "dark",
  spectrogramBackground: "#09040f",
  overlayBase: "rgba(70, 197, 188, 0.16)",
  overlayBaseEdge: "rgba(135, 255, 244, 0.96)",
  overlayMark: "rgba(70, 197, 188, 0.22)",
  overlayMarkEdge: "rgba(151, 255, 247, 0.98)",
  overlayErase: "rgba(236, 111, 76, 0.22)",
  overlayEraseEdge: "rgba(255, 183, 160, 0.98)",
  playhead: "#fff2dc",
  frequencyLabel: "rgba(255, 234, 210, 0.92)",
  frequencyGuide: "rgba(255, 234, 210, 0.12)",
};

const lightTheme: CanvasTheme = {
  mode: "light",
  spectrogramBackground: "#09040f",
  overlayBase: "rgba(24, 143, 160, 0.14)",
  overlayBaseEdge: "rgba(170, 255, 255, 0.98)",
  overlayMark: "rgba(24, 143, 160, 0.22)",
  overlayMarkEdge: "rgba(188, 255, 255, 0.98)",
  overlayErase: "rgba(207, 94, 63, 0.2)",
  overlayEraseEdge: "rgba(255, 201, 182, 0.98)",
  playhead: "#fff2dc",
  frequencyLabel: "rgba(255, 234, 210, 0.92)",
  frequencyGuide: "rgba(255, 234, 210, 0.12)",
};

export function getCanvasTheme(mode: SystemThemeMode): CanvasTheme {
  return mode === "dark" ? darkTheme : lightTheme;
}

export function getWaveformTheme(mode: SystemThemeMode): WaveformTheme {
  if (mode === "dark") {
    return {
      mode: "dark",
      background: "#0f0f0f",
      laneEven: "#151515",
      laneOdd: "#101010",
      waveform: "#d8cdbd",
      label: "#e7decf",
      grid: "rgba(231, 222, 207, 0.12)",
      playhead: "#f0e6d7",
      overlayBase: "rgba(86, 197, 154, 0.2)",
      overlayBaseEdge: "rgba(207, 255, 219, 0.96)",
      overlayMark: "rgba(86, 197, 154, 0.28)",
      overlayMarkEdge: "rgba(214, 255, 225, 1)",
      overlayErase: "rgba(229, 107, 84, 0.24)",
      overlayEraseEdge: "rgba(255, 210, 197, 1)",
    };
  }

  return {
    mode: "light",
    background: "#f3efe8",
    laneEven: "#f6f2eb",
    laneOdd: "#efe9df",
    waveform: "#5d5146",
    label: "#6b5f53",
    grid: "rgba(78, 67, 58, 0.12)",
    playhead: "#ffffff",
    overlayBase: "rgba(54, 160, 118, 0.18)",
    overlayBaseEdge: "rgba(47, 104, 78, 0.92)",
    overlayMark: "rgba(54, 160, 118, 0.26)",
    overlayMarkEdge: "rgba(34, 87, 65, 0.96)",
    overlayErase: "rgba(211, 96, 69, 0.22)",
    overlayEraseEdge: "rgba(130, 55, 42, 0.92)",
  };
}

function readSystemTheme(): SystemThemeMode {
  if (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }

  return "light";
}

export function useSystemTheme(): SystemThemeMode {
  const [mode, setMode] = useState<SystemThemeMode>(() => readSystemTheme());

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const syncTheme = () => setMode(mediaQuery.matches ? "dark" : "light");

    syncTheme();
    mediaQuery.addEventListener("change", syncTheme);
    return () => mediaQuery.removeEventListener("change", syncTheme);
  }, []);

  return mode;
}

export function resolveUiThemeMode(
  preference: UiThemePreference,
  systemTheme: SystemThemeMode,
): SystemThemeMode {
  return preference === "system" ? systemTheme : preference;
}

export function buildUiThemeStyle(mode: SystemThemeMode): CSSProperties {
  if (mode === "dark") {
    return {
      "--app-bg": "#050505",
      "--body-radial": "rgba(255, 255, 255, 0.018)",
      "--body-top": "#0d0d0d",
      "--panel-bg": "#0a0a0a",
      "--panel-bg-strong": "#101010",
      "--panel-border": "rgba(255, 255, 255, 0.07)",
      "--canvas-border": "rgba(255, 255, 255, 0.07)",
      "--text-primary": "#e7decf",
      "--text-secondary": "#e7decf",
      "--text-tertiary": "#e7decf",
      "--accent": "#e7decf",
      "--accent-soft": "rgba(255, 255, 255, 0.06)",
      "--danger": "#e26d5a",
      "--shadow": "0 4px 14px rgba(0, 0, 0, 0.12)",
      colorScheme: "dark",
    } as CSSProperties;
  }

  return {
    "--app-bg": "#f3f4f6",
    "--body-radial": "rgba(255, 255, 255, 0.78)",
    "--body-top": "#fafafa",
    "--panel-bg": "#f7f8fa",
    "--panel-bg-strong": "#ffffff",
    "--panel-border": "rgba(15, 23, 42, 0.08)",
    "--canvas-border": "rgba(15, 23, 42, 0.08)",
    "--text-primary": "#54493f",
    "--text-secondary": "#54493f",
    "--text-tertiary": "#54493f",
    "--accent": "#54493f",
    "--accent-soft": "rgba(15, 23, 42, 0.06)",
    "--danger": "#c95e4b",
    "--shadow": "0 4px 14px rgba(15, 23, 42, 0.04)",
    colorScheme: "light",
  } as CSSProperties;
}
