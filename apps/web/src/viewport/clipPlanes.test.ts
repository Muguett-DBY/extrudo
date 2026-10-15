import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CLIP_INSET, planeOf } from './clipPlanes';

describe('planeOf', () => {
  const plane = planeOf({ origin: [5, 0, 2.4], normal: [0, 0, 1] });

  it('clips what lies on the plane itself, so a face in the plane is cut away whole', () => {
    // three clips where the distance is negative.
    expect(plane.distanceToPoint(new Vector3(30, 10, 2.4))).toBeCloseTo(-CLIP_INSET);
  });

  it('keeps the side the normal points away from and clips the other', () => {
    expect(plane.distanceToPoint(new Vector3(0, 0, 2.39))).toBeGreaterThan(0);
    expect(plane.distanceToPoint(new Vector3(0, 0, 2.41))).toBeLessThan(0);
  });
});
