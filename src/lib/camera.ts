/**
 * R2.8.10 — first-load camera (presentation only).
 *
 * The camera is an explicit UI/product choice, never a semantic one: the
 * reconciled graph does not decide what is "important", and the producer emits
 * no notion of a representative class. `ENTRY_CLASS` below is the single,
 * configured starting point — nothing is inferred.
 *
 * Modes (both presentation-only; geometry and semantics are untouched):
 *
 *   overview — fit the whole graph. The current default, unchanged.
 *   entry    — open centred on the configured entry class at a readable zoom
 *              (the STRUCTURAL LOD floor), so first contact shows a legible
 *              region rather than 37 tables at ~0.16 zoom.
 *
 * The product default is `DEFAULT_CAMERA_MODE`; flipping it changes only the
 * first-load camera. The runtime seam `window.__erdCamera.setMode` exists so the
 * modes can be compared without committing the product decision.
 */
import { LOD_ZOOM } from './types';

export type CameraMode = 'overview' | 'entry';

/** Explicit product configuration: the class a readable-entry camera opens on. */
export const ENTRY_CLASS = 'person';

/** Readable-entry zoom: the STRUCTURAL LOD floor, where labels/badges display. */
export const ENTRY_ZOOM = LOD_ZOOM.STRUCTURAL_MIN;

/**
 * Product default. Kept as the whole-graph overview so first-load behaviour is
 * unchanged; the readable-entry camera is one constant away.
 */
export const DEFAULT_CAMERA_MODE: CameraMode = 'overview';
