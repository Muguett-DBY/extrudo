import { describe, expect, it } from 'vitest';
import type { BodyMesh } from '@extrudo/kernel';
import { type RegionPalette, regionGeometry } from './regionGeometry';

const palette: RegionPalette = { plane: [0, 1, 0], curved: [0, 0, 1], unfit: [1, 0, 0] };

describe('regionGeometry', () => {
  // Two triangles sharing an edge (nodes 1 and 2), on two surfaces.
  const mesh: BodyMesh = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 2, 1, 3]),
    faceRanges: new Uint32Array([0, 2]),
    edgePoints: new Float32Array(),
    edgeRanges: new Uint32Array(),
    edgeFlags: new Uint8Array(),
    vertices: new Float32Array(),
    mesh: true,
  };

  it('gives every triangle its own nodes, coloured by its surface kind', () => {
    const g = regionGeometry(mesh, { surfaceOf: new Int32Array([1, 0]), kinds: [-1, 0] }, palette);
    expect(g?.positions).toEqual(
      new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0]),
    );
    // Triangle 0 is on surface 1 (a plane), triangle 1 on surface 0 (unfit).
    expect(Array.from(g?.colors ?? [])).toEqual([
      0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,
    ]);
    expect(g?.normals).toHaveLength(18);
  });

  it('colours every curved kind alike', () => {
    for (const kind of [1, 2, 3, 4]) {
      const g = regionGeometry(mesh, { surfaceOf: new Int32Array([0, 0]), kinds: [kind] }, palette);
      expect(Array.from(g?.colors.subarray(0, 3) ?? [])).toEqual([0, 0, 1]);
    }
  });

  it('draws nothing for regions of another mesh', () => {
    expect(regionGeometry(mesh, { surfaceOf: new Int32Array([0]), kinds: [0] }, palette)).toBe(
      undefined,
    );
  });
});
