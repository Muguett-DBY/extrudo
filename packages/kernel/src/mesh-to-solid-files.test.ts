// Mesh to Solid on real STL files (P4-13, ADR-0097's 2026-10-22 amendment):
// the owner's fixtures in fixtures/imports/mesh-to-solid/, and, when STL_DIR
// names a folder, every .stl under it (at TOL, default 0.01 mm), where only a
// trap fails: a refusal is an answer, a WASM RuntimeError is a bug.
import { readStl } from '@extrudo/io';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import drillBlockStl from '../../../fixtures/imports/mesh-to-solid/drill-block.stl?url&inline';
import holeFillerStl from '../../../fixtures/imports/mesh-to-solid/hole-filler-35mm.stl?url&inline';
import pegPeregoStl from '../../../fixtures/imports/mesh-to-solid/peg-perego-button.stl?url&inline';
import puzzleBaseStl from '../../../fixtures/imports/mesh-to-solid/puzzle-base-circle.stl?url&inline';
import flightCoverStl from '../../../fixtures/imports/mesh-to-solid/remove-before-flight-cover.stl?url&inline';
import trackStl from '../../../fixtures/imports/mesh-to-solid/track-straight-100mm.stl?url&inline';
import repairFootStl from '../../../fixtures/imports/mesh-to-solid/trashcan-repair-foot.stl?url&inline';
import spacerStl from '../../../fixtures/imports/mesh-to-solid/trashcan-spacer.stl?url&inline';
import { Kernel, KernelError, type ShapeHandle } from './kernel';
import { loadManifold } from './manifold';
import { loadOcct } from './occt/load';

const env =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

/** The kernel's tsconfig has no Node types: a module name in a variable keeps tsc out of it. */
interface NodeFs {
  readdirSync(
    path: string,
    options: { withFileTypes: true },
  ): { name: string; isDirectory(): boolean }[];
  readFileSync(path: string): Uint8Array;
  mkdirSync(path: string, options: { recursive: true }): void;
  writeFileSync(path: string, data: Uint8Array): void;
}
const nodeFs = 'node:fs';
const fs = env.STL_DIR ? ((await import(/* @vite-ignore */ nodeFs)) as NodeFs) : undefined;

let kernel: Kernel;

beforeAll(async () => {
  kernel = new Kernel(await loadOcct());
  kernel.enableMeshes(await loadManifold());
});

afterEach(() => {
  expect(kernel.stats().liveShapes).toBe(0);
});

/** The bytes of a `data:` URL (Vite's `?url&inline` import of a fixture). */
function bytesOf(dataUrl: string): Uint8Array {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** Every .stl under `root`, sorted, relative to it. */
function stlFiles(files: NodeFs, root: string, under = ''): string[] {
  const list: string[] = [];
  for (const entry of files.readdirSync(`${root}/${under}`, { withFileTypes: true })) {
    const path = `${under}${entry.name}`;
    if (entry.isDirectory()) list.push(...stlFiles(files, root, `${path}/`));
    else if (/\.stl$/i.test(entry.name)) list.push(path);
  }
  return list.sort();
}

/** The signed volume of a triangle mesh. */
function meshVolume(positions: ArrayLike<number>, indices: ArrayLike<number>): number {
  const at = (i: number) => positions[i] as number;
  let v = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = 3 * (indices[t] as number);
    const b = 3 * (indices[t + 1] as number);
    const c = 3 * (indices[t + 2] as number);
    v +=
      at(a) * (at(b + 1) * at(c + 2) - at(b + 2) * at(c + 1)) -
      at(a + 1) * (at(b) * at(c + 2) - at(b + 2) * at(c)) +
      at(a + 2) * (at(b) * at(c + 1) - at(b + 1) * at(c));
  }
  return v / 6;
}

/** A refusal is a KernelError; anything else (a WASM RuntimeError) is rethrown. */
function refusal(error: unknown): string {
  if (error instanceof KernelError) return error.message;
  throw error;
}

/**
 * What prismatic makes of a fixture (at 0.01 mm unless `tolerance` says):
 * faces by kind and the unfit regions left out of the exact rebuild (slice
 * C), or the hybrid rebuild's unfit regions and facets (slice D1), or the
 * refusal.
 */
type Outcome =
  | {
      planes: number;
      cylinders: number;
      cones: number;
      spheres: number;
      tori: number;
      leftOut?: number;
      tolerance?: number;
      /** The hybrid rebuild (slice D1): its unfit regions (as `leftOut`) and facet faces. */
      hybrid?: { unfit: number; facets: number };
    }
  | { refusal: string; tolerance?: number };

// Slice C's fixtures. drill-block's lettering walls (3 unfit regions) are
// left out; track-straight's socket-rim chamfer is left out at 0.05 mm. Slice
// D1: where the exact rebuild fails (track-straight at 0.01 and 0.1 mm,
// remove-before-flight-cover at 0.01 mm), the hybrid rebuild converts, the
// unfit regions (and any region whose face wouldn't build) as facets.
const DRILL_BLOCK: Outcome = {
  planes: 77,
  cylinders: 12,
  cones: 0,
  spheres: 0,
  tori: 4,
  leftOut: 3,
};
const TRACK_001: Outcome = {
  planes: 65,
  cylinders: 2,
  cones: 2,
  spheres: 0,
  tori: 0,
  hybrid: { unfit: 2, facets: 237 },
};
const TRACK_005: Outcome = {
  planes: 89,
  cylinders: 12,
  cones: 3,
  spheres: 0,
  tori: 3,
  leftOut: 1,
  tolerance: 0.05,
};
const TRACK_01: Outcome = {
  planes: 69,
  cylinders: 8,
  cones: 2,
  spheres: 0,
  tori: 0,
  hybrid: { unfit: 0, facets: 0 },
  tolerance: 0.1,
};
const FLIGHT_COVER: Outcome = {
  planes: 252,
  cylinders: 62,
  cones: 4,
  spheres: 0,
  tori: 0,
  hybrid: { unfit: 5, facets: 120 },
};

const fixtures: [string, string, Outcome][] = [
  [
    'hole-filler-35mm.stl',
    holeFillerStl,
    { planes: 3, cylinders: 2, cones: 0, spheres: 0, tori: 1 },
  ],
  [
    'trashcan-repair-foot.stl',
    repairFootStl,
    { planes: 12, cylinders: 4, cones: 0, spheres: 0, tori: 0 },
  ],
  [
    'puzzle-base-circle.stl',
    puzzleBaseStl,
    { planes: 35, cylinders: 1, cones: 0, spheres: 0, tori: 1 },
  ],
  [
    'trashcan-spacer.stl',
    spacerStl,
    {
      // Slice C: a fillet network whose short fillets are 0.016-0.026 mm off
      // round (twisted facets); those leftovers drop the split (ADR-0097), so
      // the network is one unfit region: slice D1 keeps it as facets.
      planes: 2,
      cylinders: 0,
      cones: 0,
      spheres: 4,
      tori: 4,
      hybrid: { unfit: 1, facets: 409 },
    },
  ],
  [
    // Slice D1: a freeform shell (39 % of the surface) as facets, the rest exact.
    'peg-perego-button.stl',
    pegPeregoStl,
    {
      planes: 108,
      cylinders: 94,
      cones: 8,
      spheres: 10,
      tori: 2,
      hybrid: { unfit: 3, facets: 670 },
    },
  ],
  // Slice C: unfit regions under 2 % of the surface are left out of the rebuild.
  ['drill-block.stl', drillBlockStl, DRILL_BLOCK],
  ['track-straight-100mm.stl', trackStl, TRACK_001],
  ['track-straight-100mm.stl', trackStl, TRACK_005],
  ['track-straight-100mm.stl', trackStl, TRACK_01],
  ['remove-before-flight-cover.stl', flightCoverStl, FLIGHT_COVER],
];

describe('Mesh to Solid, prismatic on the fixtures', { timeout: 120_000 }, () => {
  for (const [name, url, outcome] of fixtures) {
    const tolerance = outcome.tolerance ?? 0.01;
    it(`converts ${name} at ${tolerance} mm${'refusal' in outcome ? ' (refused)' : ''}`, () => {
      const stl = readStl(bytesOf(url));
      const volume = meshVolume(stl.mesh.positions, stl.mesh.indices);
      const mesh = kernel.meshFrom(stl.mesh);
      try {
        if ('refusal' in outcome) {
          expect(() => kernel.meshToSolid(mesh, { method: 'prismatic', tolerance })).toThrow(
            new KernelError(outcome.refusal),
          );
          return;
        }
        const { shape, report } = kernel.meshToSolid(mesh, { method: 'prismatic', tolerance });
        try {
          const { planes, cylinders, cones, spheres, tori } = report;
          expect({ planes, cylinders, cones, spheres, tori }).toEqual({
            planes: outcome.planes,
            cylinders: outcome.cylinders,
            cones: outcome.cones,
            spheres: outcome.spheres,
            tori: outcome.tori,
          });
          expect(report.rebuild).toBe(outcome.hybrid ? 'hybrid' : 'exact');
          expect(report.facets).toBe(outcome.hybrid?.facets ?? 0);
          expect(report.unfit.regions).toBe(outcome.hybrid?.unfit ?? outcome.leftOut ?? 0);
          if (outcome.leftOut) expect(report.unfit.fraction).toBeLessThanOrEqual(0.02);
          expect(kernel.isValid(shape)).toBe(true);
          expect(Math.abs(kernel.properties(shape).volume / volume - 1)).toBeLessThan(0.005);
        } finally {
          kernel.release(shape);
        }
      } finally {
        kernel.release(mesh);
      }
    });
  }
});

describe('Mesh to Solid, the segmentation', { timeout: 120_000 }, () => {
  it('puts every triangle of trashcan-spacer.stl on a surface, and converts or refuses it without a trap', () => {
    // At 0.1 and 0.2 mm, splitComponent's border moves once left regions on no
    // surface (and others on two): meshRegions mapped their triangles to -1
    // and the rebuild indexed adjacent[-1] (ADR-0097's 2026-10-22 amendment).
    const mesh = kernel.meshFrom(readStl(bytesOf(spacerStl)).mesh);
    try {
      for (const tolerance of [0.1, 0.2]) {
        const regions = kernel.meshRegions(mesh, tolerance);
        expect(regions.surfaceOf.filter((s) => s < 0 || s >= regions.kinds.length)).toHaveLength(0);
        try {
          kernel.release(kernel.meshToSolid(mesh, { method: 'prismatic', tolerance }).shape);
        } catch (error) {
          expect(error).toBeInstanceOf(KernelError);
        }
      }
    } finally {
      kernel.release(mesh);
    }
  });
});

/**
 * MESH_OUT: the mesh as the kernel stages it (manifold's order), for the spike
 * harness's `f` case: uint32 nodes, uint32 triangles, float32 xyz, uint32 corners.
 */
function writeStagedMesh(mesh: ShapeHandle, path: string): void {
  const { positions, indices } = kernel.exportMesh(mesh, {
    linearDeflection: 0.1,
    angularDeflection: 0.5,
  });
  const nodes = positions.length / 3;
  const bytes = new ArrayBuffer(8 + 4 * positions.length + 4 * indices.length);
  new Uint32Array(bytes, 0, 2).set([nodes, indices.length / 3]);
  new Float32Array(bytes, 8, positions.length).set(positions);
  new Uint32Array(bytes, 8 + 4 * positions.length, indices.length).set(indices);
  fs?.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  fs?.writeFileSync(path, new Uint8Array(bytes));
}

const stlDir = env.STL_DIR;
const tolerance = Number(env.TOL ?? '0.01');
const only = env.FILE;

describe.skipIf(!stlDir)('Mesh to Solid over STL_DIR', { timeout: 3_600_000 }, () => {
  const root = stlDir as string;
  for (const name of fs && stlDir ? stlFiles(fs, root) : []) {
    if (only && name !== only) continue;
    it(name, () => {
      const stl = readStl(new Uint8Array((fs as NodeFs).readFileSync(`${root}/${name}`)));
      const volume = meshVolume(stl.mesh.positions, stl.mesh.indices);
      const cells: string[] = [name, String(stl.mesh.indices.length / 3)];
      let mesh: ShapeHandle | undefined;
      try {
        mesh = kernel.meshFrom(stl.mesh);
      } catch (error) {
        cells.push(`mesh: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (mesh) {
        try {
          if (env.MESH_OUT) {
            writeStagedMesh(mesh, `${env.MESH_OUT}/${name.replace(/\.stl$/i, '.mesh')}`);
          }
          try {
            const r = kernel.meshRegions(mesh, tolerance);
            cells.push(
              `${r.planes}/${r.cylinders}/${r.cones}/${r.spheres}/${r.tori}`,
              `${r.unfit.regions}${r.suggestedTolerance ? `, try ${r.suggestedTolerance}` : ''}`,
            );
          } catch (error) {
            cells.push(refusal(error), '');
          }
          for (const method of ['prismatic', 'faceted'] as const) {
            const t0 = performance.now();
            try {
              const { shape, report } = kernel.meshToSolid(mesh, { method, tolerance });
              try {
                const ratio = kernel.properties(shape).volume / volume;
                const leftOut =
                  report.rebuild === 'hybrid'
                    ? `, hybrid: ${report.unfit.regions} unfit, ${report.facets} facets`
                    : report.unfit.regions
                      ? `, ${report.unfit.regions} unfit left out`
                      : '';
                cells.push(
                  `✓ ${report.faces} faces (${report.planes}/${report.cylinders}/${report.cones}/${report.spheres}/${report.tori})${leftOut}, valid ${kernel.isValid(shape)}, vol ${ratio.toFixed(4)} (${Math.round(performance.now() - t0)} ms)`,
                );
              } finally {
                kernel.release(shape);
              }
            } catch (error) {
              cells.push(`✗ ${refusal(error)} (${Math.round(performance.now() - t0)} ms)`);
            }
          }
        } finally {
          kernel.release(mesh);
        }
      }
      console.log(`| ${cells.join(' | ')} |`);
    });
  }
});
