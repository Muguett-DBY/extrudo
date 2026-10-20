// Mesh to Solid (P4-13, ADR-0095 §3), faceted: a mesh body's triangles go
// through the facade into one B-rep solid whose coplanar facets are merged.
// Real OCCT, a real manifold module and `strictLeaks`: a mesh handle or a
// solid a test forgets fails the `afterEach`.
import { readStl, type TriangleMesh } from '@extrudo/io';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import cubeStl from '../../../fixtures/imports/cube.stl?url&inline';
import { Kernel, KernelError, type ShapeHandle } from './kernel';
import { loadManifold, type Manifold } from './manifold';
import { loadOcct } from './occt/load';

let kernel: Kernel;
let manifold: Awaited<ReturnType<typeof loadManifold>>;

beforeAll(async () => {
  kernel = new Kernel(await loadOcct());
  manifold = await loadManifold();
  kernel.enableMeshes(manifold);
});

afterEach(() => {
  expect(kernel.stats().liveShapes).toBe(0);
});

/** The bytes of a `data:` URL (Vite's `?url&inline` import of a fixture). */
function bytesOf(dataUrl: string): Uint8Array {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** A manifold-3d solid as a mesh body (the manifold is freed). */
function meshOf(solid: Manifold): ShapeHandle {
  const gl = solid.getMesh();
  const positions = new Float64Array(gl.numVert * 3);
  for (let i = 0; i < gl.numVert; i++) {
    for (let k = 0; k < 3; k++)
      positions[3 * i + k] = gl.vertProperties[gl.numProp * i + k] as number;
  }
  const mesh: TriangleMesh = { positions, indices: Uint32Array.from(gl.triVerts) };
  solid.delete();
  return kernel.meshFrom(mesh);
}

function cube(): ShapeHandle {
  return kernel.meshFrom(readStl(bytesOf(cubeStl)).mesh);
}

/** The surface kind of every face. */
function kinds(shape: ShapeHandle): string[] {
  return Array.from(
    { length: kernel.count(shape, 'face') },
    (_, i) => kernel.surfaceGeometry(shape, i).type,
  );
}

describe('Kernel.meshToSolid, faceted', { timeout: 300_000 }, () => {
  it('turns cube.stl into a six-plane solid of the same volume', () => {
    const mesh = cube();
    try {
      const { shape, report } = kernel.meshToSolid(mesh, { method: 'faceted', tolerance: 0.01 });
      try {
        expect(kernel.count(shape, 'face')).toBe(6);
        expect(kinds(shape)).toEqual(Array(6).fill('plane'));
        expect(kernel.isValid(shape)).toBe(true);
        expect(kernel.properties(shape).volume).toBeCloseTo(8000, 6);
        expect(report).toEqual({
          method: 'faceted',
          faces: 6,
          planes: 6,
          cylinders: 0,
          cones: 0,
          spheres: 0,
          tori: 0,
          unfit: { regions: 0, triangles: 0, fraction: 0 },
        });
        expect(report.suggestedTolerance).toBeUndefined();
      } finally {
        kernel.release(shape);
      }
    } finally {
      kernel.release(mesh);
    }
  });

  it('gives a body that fillets and cuts like a native solid', () => {
    const mesh = cube();
    const { shape } = kernel.meshToSolid(mesh, { method: 'faceted', tolerance: 0.01 });
    kernel.release(mesh);
    try {
      const filleted = kernel.fillet(shape, [0], 1).shape;
      expect(kernel.count(filleted, 'face')).toBe(7);
      kernel.release(filleted);

      const { min, max } = kernel.properties(shape).bbox;
      const drill = kernel.cylinder(3, max[2] - min[2] + 10, [
        (min[0] + max[0]) / 2,
        (min[1] + max[1]) / 2,
        min[2] - 5,
      ]);
      const cut = kernel.cut(shape, drill).shape;
      kernel.release(drill);
      try {
        expect(kernel.count(cut, 'face')).toBe(7);
        expect(kinds(cut).sort()).toEqual([...Array(6).fill('plane'), 'cylinder'].sort());
        expect(kernel.properties(cut).volume).toBeCloseTo(8000 - Math.PI * 9 * 20, 3);
      } finally {
        kernel.release(cut);
      }
    } finally {
      kernel.release(shape);
    }
  });

  it('keeps a 32-sided cylinder mesh as 34 planes (faceted merges coplanar facets only)', () => {
    const mesh = meshOf(manifold.Manifold.cylinder(10, 10, 10, 32));
    const { shape, report } = kernel.meshToSolid(mesh, { method: 'faceted', tolerance: 0.01 });
    kernel.release(mesh);
    try {
      expect(kernel.count(shape, 'face')).toBe(34);
      expect(kinds(shape)).toEqual(Array(34).fill('plane'));
      expect(report).toMatchObject({ faces: 34, planes: 34 });
    } finally {
      kernel.release(shape);
    }
  });

  it('refuses a mesh that would give more than 2,000 faces', () => {
    const mesh = meshOf(manifold.Manifold.sphere(10, 128));
    try {
      let error: unknown;
      try {
        const { shape } = kernel.meshToSolid(mesh, { method: 'faceted', tolerance: 0.01 });
        kernel.release(shape);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(KernelError);
      expect((error as Error).message).toMatch(/^Faceted would give /);
      expect((error as Error).message).toContain('Extrudo converts up to 2,000');
    } finally {
      kernel.release(mesh);
    }
  });

  it('refuses a solid body', () => {
    const box = kernel.box([10, 10, 10]);
    try {
      expect(() => kernel.meshToSolid(box, { method: 'faceted', tolerance: 0.01 })).toThrow(
        new KernelError('Mesh to Solid needs a mesh body: this body is already a solid.'),
      );
    } finally {
      kernel.release(box);
    }
  });

  it("says prismatic isn't built yet", () => {
    const mesh = cube();
    try {
      expect(() => kernel.meshToSolid(mesh, { method: 'prismatic', tolerance: 0.01 })).toThrow(
        "Prismatic conversion isn't built yet.",
      );
    } finally {
      kernel.release(mesh);
    }
  });
});
