/** Dependency-free screen color/layout definitions shared by routes, registry and rendering. */

export const COLOR_MODES = ["bw", "bwr", "bwry"] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

export const PANEL_LAYOUTS = ["single", "linear", "dual-panel-left-right"] as const;
export type PanelLayout = (typeof PANEL_LAYOUTS)[number];

const COLORS: Record<ColorMode, readonly string[]> = {
  bw: ["black", "white"],
  bwr: ["black", "white", "red"],
  bwry: ["black", "white", "red", "yellow"],
};

export function isColorMode(value: unknown): value is ColorMode {
  return typeof value === "string" && (COLOR_MODES as readonly string[]).includes(value);
}

export function isPanelLayout(value: unknown): value is PanelLayout {
  return typeof value === "string" && (PANEL_LAYOUTS as readonly string[]).includes(value);
}

/** Physical colors a screen can show; unknown modes fall back to black/white. */
export function colorModeColors(colorMode: string): string[] {
  return [...(isColorMode(colorMode) ? COLORS[colorMode] : COLORS.bw)];
}

/** Layouts that can carry a given color mode (BWR plane encoding has no dual-panel variant). */
export function layoutSupportsColorMode(panelLayout: PanelLayout, colorMode: ColorMode): boolean {
  return colorMode !== "bwr" || panelLayout !== "dual-panel-left-right";
}
