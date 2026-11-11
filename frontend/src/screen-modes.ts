import type { ColorMode, PanelLayout } from './api'

export const colorModeOptions: Array<{ value: ColorMode; label: string }> = [
  { value: 'bw', label: 'Black / White' },
  { value: 'bwr', label: 'Black / White / Red' },
  { value: 'bwry', label: 'Black / White / Red / Yellow' },
]

export const panelLayoutOptions: Array<{ value: PanelLayout; labelKey: string }> = [
  { value: 'single', labelKey: 'panelLayoutSingle' },
  { value: 'linear', labelKey: 'panelLayoutLinear' },
  { value: 'dual-panel-left-right', labelKey: 'panelLayoutDualLeftRight' },
]

/** BWR plane encoding has no dual-panel variant (mirrors server validation). */
export function layoutAllowed(colorMode: ColorMode, layout: PanelLayout) {
  return colorMode !== 'bwr' || layout !== 'dual-panel-left-right'
}

export type ScreenPreset = { id: string; labelKey: string; width: number; height: number; color_mode: ColorMode; panel_layout: PanelLayout }

/** Panels supported by the ESP32 firmware; values must match its manifest checks exactly. */
export const screenPresets: ScreenPreset[] = [
  { id: 'qyeg1085-color', labelKey: 'presetColor1085', width: 1360, height: 480, color_mode: 'bwry', panel_layout: 'dual-panel-left-right' },
  { id: 'qyeg1085-mono', labelKey: 'presetMono1085', width: 1360, height: 480, color_mode: 'bw', panel_layout: 'dual-panel-left-right' },
  { id: 'hink-042-bwr', labelKey: 'presetHink042Bwr', width: 400, height: 300, color_mode: 'bwr', panel_layout: 'single' },
  { id: 'hink-0213-bw', labelKey: 'presetHink0213Bw', width: 128, height: 250, color_mode: 'bw', panel_layout: 'single' },
]
