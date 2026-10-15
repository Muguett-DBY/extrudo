import { Plane, Vector3 } from 'three';
import type { SectionClip } from '../section/clip';

/**
 * How far (mm) the drawn cut lies past the plane, into the kept side. A face lying in the plane
 * (a section on a flat face at 0 mm) would otherwise be kept or clipped pixel by pixel as float
 * rounding falls, a speckle of face and cap; this way it is always cut away and the cap covers
 * it. Well above the rounding of view-space positions, well below anything printable.
 */
export const CLIP_INSET = 1e-3;

/** The clipping plane as three.js keeps it: it keeps what lies on its normal's side. */
export function planeOf(clip: SectionClip): Plane {
  const n = new Vector3(-clip.normal[0], -clip.normal[1], -clip.normal[2]);
  return new Plane(
    n,
    clip.normal[0] * clip.origin[0] +
      clip.normal[1] * clip.origin[1] +
      clip.normal[2] * clip.origin[2] -
      CLIP_INSET,
  );
}

/** Every section plane as three.js keeps it (several clip together: the model is their intersection). */
export function clipPlanes(clips: readonly SectionClip[] | undefined): Plane[] | undefined {
  if (!clips || clips.length === 0) return undefined;
  return clips.map(planeOf);
}
