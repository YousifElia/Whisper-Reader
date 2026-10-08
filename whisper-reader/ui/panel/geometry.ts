/**
 * Panel size and position.
 *
 * Split out from panel.ts so the stylesheet can read COMPACT_HEIGHT without
 * importing the panel itself, which would be circular.
 */

export type PanelMode = 'compact' | 'full';

export interface PanelGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  mode: PanelMode;
}

export const COMPACT_HEIGHT = 60;
export const MIN_WIDTH = 320;
export const MIN_HEIGHT = 320;
export const EDGE_GAP = 16;

export const DEFAULT_GEOMETRY: PanelGeometry = {
  /** Negative means "place it bottom-right the first time it opens". */
  x: -1,
  y: -1,
  width: 380,
  height: 600,
  mode: 'compact',
};
