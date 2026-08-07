import type sharp from "sharp";

export type SharpInput = Parameters<typeof sharp>[0];
export type PanelLayout = "linear" | "dual-panel-left-right";

export interface RawImage {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
  readonly channels: 1 | 3 | 4;
}

export interface QuantizedBwImage {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
  readonly channels: 1;
}

export interface QuantizedBwryImage {
  /** Palette indexes: 0=white, 1=yellow, 2=red, 3=black. */
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
  readonly channels: 1;
}

/** Half-open bounds matching PIL getbbox/crop: [x0, y0, x1, y1]. */
export type DirtyRegion = readonly [
  x0: number,
  y0: number,
  x1: number,
  y1: number,
];

/** Inclusive widget/screen clip used to split dirty regions. */
export interface DirtyClipRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface EncodedDirtyRegion {
  readonly region: DirtyRegion;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly stride: number;
  /** `[old plane][new plane]`, each `stride * height` bytes. */
  readonly data: Buffer;
}

export interface HtmlWidget {
  readonly html: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly zIndex?: number;
  readonly id?: string;
}

export interface ScreenHtmlOptions {
  readonly width: number;
  readonly height: number;
  readonly widgets: readonly HtmlWidget[];
  readonly background?: string;
  readonly title?: string;
  readonly extraHeadHtml?: string;
}

export interface HtmlRenderOptions {
  readonly html: string;
  readonly width: number;
  readonly height: number;
  readonly timeoutMs?: number;
  readonly deviceScaleFactor?: number;
  readonly waitForFonts?: boolean;
}

export interface SnapshotRegionArtifact {
  readonly id: string;
  readonly data: Uint8Array;
}

export interface SnapshotArtifacts {
  readonly frame: Uint8Array;
  readonly sourcePng: Uint8Array;
  readonly previewPng: Uint8Array;
  readonly regions?: readonly SnapshotRegionArtifact[];
}

export interface SnapshotWriteOptions {
  readonly snapshotRoot: string;
  readonly screenId: string;
  readonly snapshotId: string;
  readonly artifacts: SnapshotArtifacts;
}

export interface SnapshotPaths {
  readonly directory: string;
  readonly framePath: string;
  readonly sourcePath: string;
  readonly previewPath: string;
  readonly regionPaths: Readonly<Record<string, string>>;
}

export interface SnapshotCleanupRecord {
  readonly id: string;
  readonly createdAt: Date | string | number;
  readonly directory: string;
}

export interface SnapshotCleanupPlan {
  readonly keep: readonly SnapshotCleanupRecord[];
  readonly remove: readonly SnapshotCleanupRecord[];
}
