// Mesh to Solid (P4-13, ADR-0097 §3): a mesh body's triangles go through the
// facade into one B-rep solid. Faceted merges coplanar facets; prismatic
// recognises planes and cylinders and rebuilds the body from exact surfaces.
// Real OCCT, a real manifold module and `strictLeaks`: a mesh handle or a
// solid a test forgets fails the `afterEach`.
import { readStl, type TriangleMesh } from '@extrudo/io';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import cubeStl from '../../../fixtures/imports/cube.stl?url&inline';
import { Kernel, KernelError, type ShapeHandle, type SurfaceGeometry } from './kernel';
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

/** cube.stl's mesh plus an identical copy offset by `offset` (indices don't overlap). */
function cubeAndCopy(offset: readonly [number, number, number]): ShapeHandle {
  const { mesh } = readStl(bytesOf(cubeStl));
  const n = mesh.positions.length / 3;
  const positions = new Float64Array(n * 6);
  positions.set(mesh.positions, 0);
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++)
      positions[3 * (n + i) + k] = (mesh.positions[3 * i + k] as number) + (offset[k] as number);
  const indices = new Uint32Array(mesh.indices.length * 2);
  indices.set(mesh.indices, 0);
  for (let i = 0; i < mesh.indices.length; i++)
    indices[mesh.indices.length + i] = (mesh.indices[i] as number) + n;
  return kernel.meshFrom({ positions, indices });
}

/** The size of cube.stl (one 20 mm cube). */
function cubeExtent(): [number, number, number] {
  const { mesh } = readStl(bytesOf(cubeStl));
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    xs.push(mesh.positions[i] as number);
    ys.push(mesh.positions[i + 1] as number);
    zs.push(mesh.positions[i + 2] as number);
  }
  const extent = (values: number[]): number => Math.max(...values) - Math.min(...values);
  return [extent(xs), extent(ys), extent(zs)];
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
      const start = performance.now();
      try {
        const { shape } = kernel.meshToSolid(mesh, { method: 'faceted', tolerance: 0.01 });
        kernel.release(shape);
      } catch (e) {
        error = e;
      }
      const ms = performance.now() - start;
      expect(error).toBeInstanceOf(KernelError);
      expect((error as Error).message).toMatch(/^Faceted would give /);
      expect((error as Error).message).toContain('Extrudo converts up to 2,000');
      // The face count comes before the build (ADR-0097 §3, 2026-10-22).
      expect(ms).toBeLessThan(1000);
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

  it('converts a mesh of two disjoint closed shells into a compound of two solids', () => {
    const mesh = cubeAndCopy([30, 0, 0]);
    try {
      const { shape, report } = kernel.meshToSolid(mesh, { method: 'faceted', tolerance: 0.01 });
      try {
        expect(kernel.isValid(shape)).toBe(true);
        expect(kernel.count(shape, 'face')).toBe(12);
        expect(kernel.properties(shape).volume).toBeCloseTo(16000, 6);
        expect(report).toMatchObject({ faces: 12, planes: 12 });
        const solids = kernel.solids(shape);
        try {
          expect(solids).toHaveLength(2);
          for (const solid of solids) expect(kernel.properties(solid).volume).toBeCloseTo(8000, 6);
        } finally {
          kernel.release(...solids);
        }
      } finally {
        kernel.release(shape);
      }
    } finally {
      kernel.release(mesh);
    }
  });

  it('refuses shells that only touch at a vertex, naming the reason', () => {
    const mesh = cubeAndCopy(cubeExtent());
    try {
      let error: unknown;
      try {
        const { shape } = kernel.meshToSolid(mesh, { method: 'faceted', tolerance: 0.01 });
        kernel.release(shape);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(KernelError);
      expect((error as Error).message).toContain('vertex joins shells that only touch at a point');
    } finally {
      kernel.release(mesh);
    }
  });
});

/** An OCCT solid meshed (fine or coarse) as a mesh body; the solid is released. */
function meshOfSolid(solid: ShapeHandle, linear: number, angular: number): ShapeHandle {
  const mesh = kernel.exportMesh(solid, { linearDeflection: linear, angularDeflection: angular });
  kernel.release(solid);
  return kernel.meshFrom(mesh);
}

/** Converts with prismatic and releases the mesh; the caller releases the shape. */
function prismatic(mesh: ShapeHandle, tolerance = 0.01) {
  try {
    return kernel.meshToSolid(mesh, { method: 'prismatic', tolerance });
  } finally {
    kernel.release(mesh);
  }
}

/** Prismatic's refusal of `mesh` (released), with how long it took. */
function refusal(mesh: ShapeHandle, tolerance = 0.01): { message: string; ms: number } {
  const start = performance.now();
  try {
    kernel.release(prismatic(mesh, tolerance).shape);
  } catch (error) {
    expect(error).toBeInstanceOf(KernelError);
    return { message: (error as Error).message, ms: performance.now() - start };
  }
  throw new Error('the mesh converted');
}

/** The radii of the cylinder faces. */
function radii(shape: ShapeHandle): number[] {
  return Array.from({ length: kernel.count(shape, 'face') }, (_, i) =>
    kernel.surfaceGeometry(shape, i),
  )
    .filter((g) => g.type === 'cylinder')
    .map((g) => g.radius as number);
}

const sorted = (list: string[]) => [...list].sort();

/** Every face's surface. */
function surfaces(shape: ShapeHandle): SurfaceGeometry[] {
  return Array.from({ length: kernel.count(shape, 'face') }, (_, i) =>
    kernel.surfaceGeometry(shape, i),
  );
}

/** `solid` with the edges whose sampled points all pass `pick` filleted by `radius` (the solid is released). */
function filleted(
  solid: ShapeHandle,
  radius: number,
  pick: (points: readonly (readonly number[])[], type: string) => boolean,
): ShapeHandle {
  const edges = Array.from({ length: kernel.count(solid, 'edge') }, (_, i) => i).filter((i) => {
    const g = kernel.edgeGeometry(solid, i);
    return g.type !== 'degenerate' && pick(g.points, g.type);
  });
  const rounded = kernel.fillet(solid, edges, radius).shape;
  kernel.release(solid);
  return rounded;
}

/** A donut about Z: major radius 10, tube radius 3 (a revolved circle). */
function donut(): ShapeHandle {
  const { faces } = kernel.planarFaces(
    [{ kind: 'arc', center: [10, 0], radius: 3, from: 0, sweep: 2 * Math.PI }],
    { origin: [0, 0, 0], x: [1, 0, 0], normal: [0, -1, 0] },
    1e-4,
  );
  const [disc, ...rest] = faces;
  if (!disc) throw new Error('no face');
  kernel.release(...rest.map((f) => f.shape));
  const solid = kernel.revolve(
    disc.shape,
    { origin: [0, 0, 0], direction: [0, 0, 1] },
    2 * Math.PI,
  ).shape;
  kernel.release(disc.shape);
  return solid;
}

/** A 40 x 30 x 5 plate with a through hole of radius 3 at its centre. */
function plate(): ShapeHandle {
  const box = kernel.box([40, 30, 5]);
  const drill = kernel.cylinder(3, 7, [20, 15, -1]);
  const cut = kernel.cut(box, drill).shape;
  kernel.release(box);
  kernel.release(drill);
  return cut;
}
const PLATE_VOLUME = 6000 - 45 * Math.PI;

/** The 32-gon cylinder r 5, h 20, its nodes moved radially by up to ±0.005 mm (deterministic). */
function noisyCylinder(): ShapeHandle {
  const solid = manifold.Manifold.cylinder(20, 5, 5, 32);
  const gl = solid.getMesh();
  solid.delete();
  const positions = new Float64Array(gl.numVert * 3);
  for (let i = 0; i < gl.numVert; i++) {
    const x = gl.vertProperties[gl.numProp * i] as number;
    const y = gl.vertProperties[gl.numProp * i + 1] as number;
    const z = gl.vertProperties[gl.numProp * i + 2] as number;
    const r = Math.hypot(x, y);
    const scale = (r + 0.005 * Math.sin(1.7 * i + 0.3)) / r;
    positions.set([x * scale, y * scale, z], 3 * i);
  }
  return kernel.meshFrom({ positions, indices: Uint32Array.from(gl.triVerts) });
}

describe('Kernel.meshToSolid, prismatic', { timeout: 300_000 }, () => {
  it('1: turns cube.stl into six exact planes', () => {
    const { shape, report } = prismatic(cube());
    try {
      expect(kernel.count(shape, 'face')).toBe(6);
      expect(kinds(shape)).toEqual(Array(6).fill('plane'));
      expect(kernel.isValid(shape)).toBe(true);
      expect(kernel.properties(shape).volume).toBeCloseTo(8000, 6);
      expect(report).toEqual({
        method: 'prismatic',
        faces: 6,
        planes: 6,
        cylinders: 0,
        cones: 0,
        spheres: 0,
        tori: 0,
        unfit: { regions: 0, triangles: 0, fraction: 0 },
      });
    } finally {
      kernel.release(shape);
    }
  });

  // 2-4: the same cylinder at 32, 360 (the fine trap: facets 1 degree apart)
  // and 16 segments (coarse: its polygon is 2.5 % short of the circle).
  for (const segments of [32, 360, 16]) {
    it(`${segments === 32 ? 2 : segments === 360 ? 3 : 4}: rebuilds a ${segments}-gon cylinder as 2 planes and an exact cylinder`, () => {
      const { shape, report } = prismatic(meshOf(manifold.Manifold.cylinder(20, 5, 5, segments)));
      try {
        expect(kernel.count(shape, 'face')).toBe(3);
        expect(sorted(kinds(shape))).toEqual(['cylinder', 'plane', 'plane']);
        const [radius] = radii(shape);
        expect(Math.abs((radius as number) - 5)).toBeLessThan(1e-6);
        const volume = kernel.properties(shape).volume;
        expect(Math.abs(volume / (Math.PI * 25 * 20) - 1)).toBeLessThan(0.001);
        expect(report).toMatchObject({ faces: 3, planes: 2, cylinders: 1, unfit: { regions: 0 } });
      } finally {
        kernel.release(shape);
      }
    });
  }

  it('5: rebuilds a plate with a hole: the hole is a circle and takes a fillet', () => {
    const { shape } = prismatic(meshOfSolid(plate(), 0.001, 0.05));
    try {
      expect(kernel.count(shape, 'face')).toBe(7);
      expect(sorted(kinds(shape))).toEqual(sorted([...Array(6).fill('plane'), 'cylinder']));
      expect(Math.abs(kernel.properties(shape).volume / PLATE_VOLUME - 1)).toBeLessThan(0.001);
      const topCircle = Array.from({ length: kernel.count(shape, 'edge') }, (_, i) => i).find(
        (i) => {
          const g = kernel.edgeGeometry(shape, i);
          return g.type === 'circle' && Math.abs((g.points[0]?.[2] ?? 0) - 5) < 1e-6;
        },
      );
      expect(topCircle).toBeDefined();
      const filleted = kernel.fillet(shape, [topCircle as number], 1).shape;
      try {
        expect(kernel.isValid(filleted)).toBe(true);
        expect(kernel.count(filleted, 'face')).toBe(8);
      } finally {
        kernel.release(filleted);
      }
    } finally {
      kernel.release(shape);
    }
  });

  // 6: the tangency trap: a fillet's cylinder touches both its planes.
  for (const [name, linear, angular] of [
    ['fine', 0.001, 0.05],
    ['coarse (8 segments)', 1, Math.PI / 16 + 1e-3],
  ] as const) {
    it(`6: rebuilds a box with a filleted edge, meshed ${name}`, () => {
      const box = kernel.box([20, 20, 20]);
      const rounded = kernel.fillet(box, [0], 2).shape;
      kernel.release(box);
      const exact = kernel.properties(rounded).volume;
      const { shape, report } = prismatic(meshOfSolid(rounded, linear, angular));
      try {
        expect(kernel.count(shape, 'face')).toBe(7);
        expect(sorted(kinds(shape))).toEqual(sorted([...Array(6).fill('plane'), 'cylinder']));
        expect(Math.abs((radii(shape)[0] as number) - 2)).toBeLessThan(1e-3);
        expect(Math.abs(kernel.properties(shape).volume / exact - 1)).toBeLessThan(0.001);
        expect(report).toMatchObject({ planes: 6, cylinders: 1 });
      } finally {
        kernel.release(shape);
      }
    });
  }

  it('7: refuses an ellipsoid: one region fits no plane, cylinder, sphere, cone or torus', () => {
    const sphere = manifold.Manifold.sphere(10, 48);
    const ellipsoid = sphere.scale([1, 1, 0.6]);
    sphere.delete();
    const { message } = refusal(meshOf(ellipsoid));
    expect(message).toBe(
      "Mesh to Solid couldn't close the body: 1 region (100 % of the surface) fits no plane, cylinder, sphere, cone or torus. Use Faceted, or simplify the mesh in your slicer.",
    );
  });

  it('8: refuses a 602-face staircase over the 500-surface cap, quickly', () => {
    // 299 steps: the bottom, the back, 299 risers and 299 treads, and the two caps.
    const steps = 299;
    const outline: [number, number][] = [
      [0, 0],
      [steps, 0],
    ];
    for (let i = 0; i < steps; i++) outline.push([steps - i, i + 1], [steps - i - 1, i + 1]);
    const section = new manifold.CrossSection([outline]);
    const solid = section.extrude(5);
    section.delete();
    const { message, ms } = refusal(meshOf(solid));
    console.log(`prismatic: the staircase refused in ${ms.toFixed(0)} ms`);
    expect(message).toBe(
      'This mesh has 602 surfaces; Extrudo rebuilds up to 500. Use Faceted, or simplify the mesh in your slicer.',
    );
    expect(ms).toBeLessThan(3000);
  });

  it('9: suggests a tolerance for a noisy cylinder, and converts at that tolerance', () => {
    const { message } = refusal(noisyCylinder(), 0.001);
    console.log(`prismatic: the noisy cylinder at 0.001 mm: ${message}`);
    const match = /Raise the tolerance to ([0-9.]+) mm, or use Faceted\.$/.exec(message);
    expect(message).toMatch(
      /^Mesh to Solid couldn't close the body: 1 region \(\d+ % of the surface\) fits no plane, cylinder, sphere, cone or torus\./,
    );
    expect(match).not.toBeNull();
    // The sphere through two rings a diameter apart also nearly fits the side,
    // so the suggestion is the sphere's deviation, not the cylinder's.
    const suggested = Number(match?.[1]);
    expect(suggested).toBeGreaterThanOrEqual(0.002);
    expect(suggested).toBeLessThanOrEqual(0.02);
    const { shape, report } = prismatic(noisyCylinder(), 0.02);
    try {
      expect(sorted(kinds(shape))).toEqual(['cylinder', 'plane', 'plane']);
      expect(report).toMatchObject({ planes: 2, cylinders: 1 });
    } finally {
      kernel.release(shape);
    }
  });

  it('11: converts a 20k-triangle plate and a 500k-triangle sphere in under 3 s and 10 s', () => {
    const mesh = meshOfSolid(plate(), 0.0002, 0.0025);
    const triangles =
      kernel.exportMesh(mesh, { linearDeflection: 1, angularDeflection: 1 }).indices.length / 3;
    let start = performance.now();
    const { shape } = prismatic(mesh);
    const convert = performance.now() - start;
    try {
      expect(kernel.count(shape, 'face')).toBe(7);
    } finally {
      kernel.release(shape);
    }
    start = performance.now();
    const sphere = meshOf(manifold.Manifold.sphere(10, 1000));
    const sphereTriangles =
      kernel.exportMesh(sphere, { linearDeflection: 1, angularDeflection: 1 }).indices.length / 3;
    const { shape: ball } = prismatic(sphere);
    const ballMs = performance.now() - start;
    try {
      expect(kernel.count(ball, 'face')).toBe(1);
      expect(kinds(ball)).toEqual(['sphere']);
    } finally {
      kernel.release(ball);
    }
    console.log(
      `prismatic: plate ${triangles} triangles converted in ${convert.toFixed(0)} ms; sphere ${sphereTriangles} triangles converted in ${ballMs.toFixed(0)} ms`,
    );
    expect(triangles).toBeGreaterThan(15_000);
    expect(sphereTriangles).toBeGreaterThan(400_000);
    expect(convert).toBeLessThan(3000);
    expect(ballMs).toBeLessThan(10_000);
  });

  it('12: converts a sphere into one exact sphere face', () => {
    const { shape, report } = prismatic(meshOf(manifold.Manifold.sphere(10, 48)));
    try {
      expect(kernel.count(shape, 'face')).toBe(1);
      expect(kinds(shape)).toEqual(['sphere']);
      expect(Math.abs((kernel.surfaceGeometry(shape, 0).radius as number) - 10)).toBeLessThan(1e-3);
      const volume = kernel.properties(shape).volume;
      expect(Math.abs(volume / ((4 / 3) * Math.PI * 1000) - 1)).toBeLessThan(0.01);
      expect(report).toMatchObject({ planes: 0, cylinders: 0, spheres: 1, cones: 0 });
    } finally {
      kernel.release(shape);
    }
  });

  it('13: rebuilds a dome: the sphere snaps to the cylinder’s radius', () => {
    const cylinder = manifold.Manifold.cylinder(10, 10, 10, 64);
    const cap0 = manifold.Manifold.sphere(10, 64);
    const cap = cap0.translate([0, 0, 10]);
    cap0.delete();
    const solid = manifold.Manifold.union(cylinder, cap);
    cylinder.delete();
    cap.delete();
    const { shape } = prismatic(meshOf(solid));
    try {
      expect(kernel.count(shape, 'face')).toBe(3);
      expect(sorted(kinds(shape))).toEqual(['cylinder', 'plane', 'sphere']);
      const geoms = Array.from({ length: 3 }, (_, i) => kernel.surfaceGeometry(shape, i));
      const cyl = geoms.find((g) => g.type === 'cylinder');
      const ball = geoms.find((g) => g.type === 'sphere');
      expect(Math.abs((ball?.radius as number) - (cyl?.radius as number))).toBeLessThan(1e-6);
      expect(Math.abs(ball?.origin?.[0] ?? 1)).toBeLessThan(1e-6);
      expect(Math.abs(ball?.origin?.[1] ?? 1)).toBeLessThan(1e-6);
      const volume = kernel.properties(shape).volume;
      expect(Math.abs(volume / (Math.PI * 100 * 10 + (2 / 3) * Math.PI * 1000) - 1)).toBeLessThan(
        0.01,
      );
    } finally {
      kernel.release(shape);
    }
  });

  it('14: rebuilds a truncated cone', () => {
    const { shape } = prismatic(meshOf(manifold.Manifold.cylinder(20, 10, 4, 64)));
    try {
      expect(kernel.count(shape, 'face')).toBe(3);
      const geoms = Array.from({ length: 3 }, (_, i) => kernel.surfaceGeometry(shape, i));
      expect(geoms.filter((g) => g.type === 'plane')).toHaveLength(2);
      const cone = geoms.find((g) => g.type === 'cone');
      expect(cone).toBeDefined();
      expect(Math.abs((cone?.halfAngle as number) - Math.atan(6 / 20))).toBeLessThan(1e-3);
      const volume = kernel.properties(shape).volume;
      expect(Math.abs(volume / ((Math.PI * 20 * (100 + 40 + 16)) / 3) - 1)).toBeLessThan(0.005);
    } finally {
      kernel.release(shape);
    }
  });

  it('15: rebuilds a countersunk hole', () => {
    const cube = manifold.Manifold.cube([40, 30, 5]);
    const hole0 = manifold.Manifold.cylinder(7, 3, 3, 64);
    const hole = hole0.translate([20, 15, -1]);
    hole0.delete();
    const sink0 = manifold.Manifold.cylinder(3, 3, 6, 64);
    const sink = sink0.translate([20, 15, 2]);
    sink0.delete();
    const drilled = cube.subtract(hole);
    cube.delete();
    hole.delete();
    const solid = drilled.subtract(sink);
    drilled.delete();
    sink.delete();
    const exact = solid.volume();
    const { shape } = prismatic(meshOf(solid));
    try {
      expect(kernel.count(shape, 'face')).toBe(8);
      const list = kinds(shape);
      expect(list.filter((k) => k === 'plane')).toHaveLength(6);
      expect(list).toContain('cylinder');
      expect(list).toContain('cone');
      expect(Math.abs(kernel.properties(shape).volume / exact - 1)).toBeLessThan(0.005);
    } finally {
      kernel.release(shape);
    }
  });

  it('16: converts a pointed cone to a plane and a cone (manifold’s apex works)', () => {
    // The harness's OCCT cone refuses at the rebuild (MakerVolume can't do
    // the singular apex); manifold's mesh for the same cone converts.
    const { shape, report } = prismatic(meshOf(manifold.Manifold.cylinder(20, 10, 0, 64)));
    try {
      expect(kernel.count(shape, 'face')).toBe(2);
      expect(sorted(kinds(shape))).toEqual(['cone', 'plane']);
      const cone = Array.from({ length: 2 }, (_, i) => kernel.surfaceGeometry(shape, i)).find(
        (g) => g.type === 'cone',
      );
      expect(Math.abs((cone?.halfAngle as number) - Math.atan(10 / 20))).toBeLessThan(1e-3);
      expect(report).toMatchObject({ planes: 1, cones: 1, spheres: 0 });
    } finally {
      kernel.release(shape);
    }
  });

  it('17: converts a donut into one torus face', () => {
    const { shape, report } = prismatic(meshOfSolid(donut(), 0.01, 0.2));
    try {
      expect(kinds(shape)).toEqual(['torus']);
      const torus = kernel.surfaceGeometry(shape, 0);
      expect(Math.abs((torus.radius as number) - 10)).toBeLessThan(1e-6);
      expect(Math.abs((torus.minorRadius as number) - 3)).toBeLessThan(1e-6);
      const volume = kernel.properties(shape).volume;
      expect(Math.abs(volume / (2 * Math.PI * Math.PI * 10 * 9) - 1)).toBeLessThan(0.005);
      expect(report).toMatchObject({ faces: 1, tori: 1, unfit: { regions: 0 } });
    } finally {
      kernel.release(shape);
    }
  });

  it('18: splits a box with four filleted top edges into planes and cylinders', () => {
    // OCCT mitres the corners where two top fillets meet (no corner face),
    // so the smooth ring is four cylinders.
    const rounded = filleted(kernel.box([40, 30, 10]), 2, (points) =>
      points.every((p) => Math.abs((p[2] as number) - 10) < 1e-6),
    );
    const exact = kernel.properties(rounded).volume;
    const { shape, report } = prismatic(meshOfSolid(rounded, 0.01, 0.2));
    try {
      expect(sorted(kinds(shape))).toEqual(
        sorted([...Array(6).fill('plane'), ...Array(4).fill('cylinder')]),
      );
      expect(Math.abs(kernel.properties(shape).volume / exact - 1)).toBeLessThan(1e-6);
      expect(report).toMatchObject({ planes: 6, cylinders: 4, unfit: { regions: 0 } });
    } finally {
      kernel.release(shape);
    }
  });

  it('19: rebuilds a cylinder with a filleted end: plane, cylinder, torus', () => {
    const rounded = filleted(
      kernel.cylinder(5, 20),
      2,
      (points, type) =>
        type === 'circle' && points.every((p) => Math.abs((p[2] as number) - 20) < 1e-6),
    );
    const exact = kernel.properties(rounded).volume;
    const { shape } = prismatic(meshOfSolid(rounded, 0.01, 0.2));
    try {
      const geoms = surfaces(shape);
      expect(sorted(geoms.map((g) => g.type))).toEqual(['cylinder', 'plane', 'plane', 'torus']);
      const cylinder = geoms.find((g) => g.type === 'cylinder') as SurfaceGeometry;
      const torus = geoms.find((g) => g.type === 'torus') as SurfaceGeometry;
      expect(Math.abs((torus.origin?.[0] ?? 1) - (cylinder.origin?.[0] ?? 0))).toBeLessThan(1e-9);
      expect(Math.abs((torus.origin?.[1] ?? 1) - (cylinder.origin?.[1] ?? 0))).toBeLessThan(1e-9);
      expect(Math.abs((torus.radius as number) - 3)).toBeLessThan(1e-3);
      expect(Math.abs((torus.minorRadius as number) - 2)).toBeLessThan(1e-3);
      expect(Math.abs(kernel.properties(shape).volume / exact - 1)).toBeLessThan(0.001);
    } finally {
      kernel.release(shape);
    }
  });

  it("20: rebuilds a plate whose hole is filleted: the torus takes the hole's axis", () => {
    const rounded = filleted(
      plate(),
      1,
      (points, type) =>
        type === 'circle' && points.every((p) => Math.abs((p[2] as number) - 5) < 1e-6),
    );
    const exact = kernel.properties(rounded).volume;
    const { shape } = prismatic(meshOfSolid(rounded, 0.01, 0.2));
    try {
      const geoms = surfaces(shape);
      expect(sorted(geoms.map((g) => g.type))).toEqual(
        sorted([...Array(6).fill('plane'), 'cylinder', 'torus']),
      );
      const torus = geoms.find((g) => g.type === 'torus') as SurfaceGeometry;
      expect(Math.abs((torus.origin?.[0] ?? 0) - 20)).toBeLessThan(1e-6);
      expect(Math.abs((torus.origin?.[1] ?? 0) - 15)).toBeLessThan(1e-6);
      expect(Math.abs((torus.radius as number) - 4)).toBeLessThan(1e-3);
      expect(Math.abs((torus.minorRadius as number) - 1)).toBeLessThan(1e-3);
      expect(Math.abs(kernel.properties(shape).volume / exact - 1)).toBeLessThan(0.001);
    } finally {
      kernel.release(shape);
    }
  });

  it('21: splits a box with all twelve edges filleted', () => {
    const box = kernel.box([20, 20, 20]);
    const rounded = filleted(box, 2, () => true);
    const exact = kernel.properties(rounded).volume;
    const { shape, report } = prismatic(meshOfSolid(rounded, 0.01, 0.2));
    try {
      expect(kernel.count(shape, 'face')).toBe(26);
      expect(sorted(kinds(shape))).toEqual(
        sorted([
          ...Array(6).fill('plane'),
          ...Array(12).fill('cylinder'),
          ...Array(8).fill('sphere'),
        ]),
      );
      expect(Math.abs(kernel.properties(shape).volume / exact - 1)).toBeLessThan(1e-6);
      expect(report).toMatchObject({ planes: 6, cylinders: 12, spheres: 8, unfit: { regions: 0 } });
    } finally {
      kernel.release(shape);
    }
  });
});

describe('Kernel.meshRegions', { timeout: 300_000 }, () => {
  /** The regions of `mesh` (released). */
  function regionsOf(mesh: ShapeHandle, tolerance = 0.01) {
    try {
      return kernel.meshRegions(mesh, tolerance);
    } finally {
      kernel.release(mesh);
    }
  }

  it('gives cube.stl six planes, one per pair of triangles', () => {
    const regions = regionsOf(cube());
    expect(regions.surfaceOf).toHaveLength(12);
    expect(Array.from(regions.kinds)).toEqual(Array(6).fill(0));
    expect(new Set(regions.surfaceOf).size).toBe(6);
    expect(regions).toMatchObject({
      planes: 6,
      cylinders: 0,
      unfit: { regions: 0, triangles: 0, fraction: 0 },
    });
    expect(regions.suggestedTolerance).toBeUndefined();
  });

  it("puts a 32-gon's side on its cylinder, in the view mesh's triangle order", () => {
    const mesh = meshOf(manifold.Manifold.cylinder(20, 5, 5, 32));
    // The view's triangles (`BodyMesh.indices` / 3) are the ones regions map onto.
    const view = kernel.mesh(mesh, { linearDeflection: 1, angularDeflection: 1 });
    const regions = regionsOf(mesh);
    expect([...regions.kinds].sort()).toEqual([0, 0, 1]);
    const cylinder = regions.kinds.indexOf(1);
    const triangles = view.indices.length / 3;
    expect(regions.surfaceOf).toHaveLength(triangles);
    let side = 0;
    for (let t = 0; t < triangles; t++) {
      const z = [0, 1, 2].map((k) => view.positions[3 * (view.indices[3 * t + k] as number) + 2]);
      const flat = z[0] === z[1] && z[1] === z[2];
      if (!flat) side++;
      expect(regions.surfaceOf[t] === cylinder).toBe(!flat);
    }
    expect(side).toBe(64);
  });

  it('marks an ellipsoid as one unfit surface', () => {
    const sphere = manifold.Manifold.sphere(10, 48);
    const ellipsoid = sphere.scale([1, 1, 0.6]);
    sphere.delete();
    const regions = regionsOf(meshOf(ellipsoid));
    expect(Array.from(regions.kinds)).toEqual([-1]);
    expect(regions.surfaceOf.every((s) => s === 0)).toBe(true);
    expect(regions.unfit.regions).toBe(1);
    expect(regions.unfit.fraction).toBe(1);
  });

  it('puts a sphere on one sphere surface', () => {
    const regions = regionsOf(meshOf(manifold.Manifold.sphere(10, 48)));
    expect(Array.from(regions.kinds)).toEqual([3]);
    expect(regions.spheres).toBe(1);
    expect(regions.cones).toBe(0);
    expect(regions.unfit.regions).toBe(0);
  });

  it('puts a donut on one torus surface', () => {
    const regions = regionsOf(meshOfSolid(donut(), 0.01, 0.2));
    expect(Array.from(regions.kinds)).toEqual([4]);
    expect(regions.tori).toBe(1);
    expect(regions.unfit.regions).toBe(0);
  });

  it("splits the filleted box's ring into cylinders and spheres", () => {
    const rounded = filleted(kernel.box([20, 20, 20]), 2, () => true);
    const regions = regionsOf(meshOfSolid(rounded, 0.01, 0.2));
    const kinds = Array.from(regions.kinds);
    expect(kinds).toContain(1);
    expect(kinds).toContain(3);
    expect(kinds).not.toContain(-1);
    expect(regions).toMatchObject({ planes: 6, cylinders: 12, spheres: 8 });
  });

  it('suggests a tolerance for the noisy 32-gon at 0.001 mm', () => {
    const regions = regionsOf(noisyCylinder(), 0.001);
    // The sphere through the two rings also nearly fits, so ~0.003, not 0.006.
    expect(regions.suggestedTolerance).toBeGreaterThanOrEqual(0.002);
    expect(regions.suggestedTolerance).toBeLessThanOrEqual(0.02);
  });

  it('refuses a solid and a tolerance of 0', () => {
    const box = kernel.box([1, 1, 1]);
    try {
      expect(() => kernel.meshRegions(box, 0.01)).toThrow(
        new KernelError('Mesh to Solid needs a mesh body: this body is already a solid.'),
      );
    } finally {
      kernel.release(box);
    }
    expect(() => regionsOf(cube(), 0)).toThrow(
      new KernelError('Mesh to Solid needs a tolerance above 0 mm.'),
    );
  });

  it('segments a 500k-triangle sphere in under 3 s, and agrees with the conversion on a plate', () => {
    const sphere = meshOf(manifold.Manifold.sphere(10, 1000));
    let start = performance.now();
    const regions = regionsOf(sphere);
    const sphereMs = performance.now() - start;
    expect(regions.surfaceOf.length).toBeGreaterThan(400_000);
    expect(Array.from(regions.kinds)).toEqual([3]);
    expect(regions.spheres).toBe(1);
    const platePieces = meshOfSolid(plate(), 0.0002, 0.0025);
    start = performance.now();
    const plateRegions = kernel.meshRegions(platePieces, 0.01);
    const plateMs = performance.now() - start;
    start = performance.now();
    const { shape, report } = prismatic(platePieces);
    const convertMs = performance.now() - start;
    kernel.release(shape);
    console.log(
      `meshRegions: sphere ${regions.surfaceOf.length} triangles in ${sphereMs.toFixed(0)} ms; plate ${plateRegions.surfaceOf.length} triangles in ${plateMs.toFixed(0)} ms (converted in ${convertMs.toFixed(0)} ms)`,
    );
    expect(plateRegions).toMatchObject({ planes: report.planes, cylinders: report.cylinders });
    expect(sphereMs).toBeLessThan(3000);
  });

  it('times a 302-surface staircase: regions, then the conversion', () => {
    const steps = 149;
    const outline: [number, number][] = [
      [0, 0],
      [steps, 0],
    ];
    for (let i = 0; i < steps; i++) outline.push([steps - i, i + 1], [steps - i - 1, i + 1]);
    const section = new manifold.CrossSection([outline]);
    const solid = section.extrude(5);
    section.delete();
    const mesh = meshOf(solid);
    let start = performance.now();
    const regions = kernel.meshRegions(mesh, 0.01);
    const regionsMs = performance.now() - start;
    start = performance.now();
    const { shape, report } = prismatic(mesh);
    const convertMs = performance.now() - start;
    kernel.release(shape);
    console.log(
      `meshRegions: staircase ${regions.kinds.length} surfaces in ${regionsMs.toFixed(0)} ms; converted in ${convertMs.toFixed(0)} ms (${report.faces} faces)`,
    );
    expect(regions.planes).toBe(302);
    expect(report.faces).toBe(302);
  });
});
