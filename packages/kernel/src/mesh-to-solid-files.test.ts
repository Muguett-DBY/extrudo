// Mesh to Solid on real STL files (P4-13, ADR-0097's 2026-10-22 amendment):
// the owner's fixtures in fixtures/imports/mesh-to-solid/, and, when STL_DIR
// names a folder, every .stl under it (at TOL, default 0.01 mm), where only a
// trap fails: a refusal is an answer, a WASM RuntimeError is a bug.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readStl } from '@extrudo/io';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import holeFillerStl from '../../../fixtures/imports/mesh-to-solid/hole-filler-35mm.stl?url&inline';
import puzzleBaseStl from '../../../fixtures/imports/mesh-to-solid/puzzle-base-circle.stl?url&inline';
import repairFootStl from '../../../fixtures/imports/mesh-to-solid/trashcan-repair-foot.stl?url&inline';
import spacerStl from '../../../fixtures/imports/mesh-to-solid/trashcan-spacer.stl?url&inline';
import { Kernel, KernelError, type ShapeHandle } from './kernel';
import { loadManifold } from './manifold';
import { loadOcct } from './occt/load';

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

/** Every .stl under `root`, sorted. */
function stlFiles(root: string): string[] {
  const list: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) list.push(...stlFiles(path));
    else if (/\.stl$/i.test(entry.name)) list.push(path);
  }
  return list.sort();
}

/** The signed volume of a triangle mesh. */
function meshVolume(positions: ArrayLike<number>, indices: ArrayLike<number>): number {
  let v = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => 3 * (indices[t + k] as number));
    const p = (i: number, k: number) => positions[(i as number) + k] as number;
    v +=
      p(a, 0) * (p(b, 1) * p(c, 2) - p(b, 2) * p(c, 1)) -
      p(a, 1) * (p(b, 0) * p(c, 2) - p(b, 2) * p(c, 0)) +
      p(a, 2) * (p(b, 0) * p(c, 1) - p(b, 1) * p(c, 0));
  }
  return v / 6;
}

/** A refusal is a KernelError; anything else (a WASM RuntimeError) is rethrown. */
function refusal(error: unknown): string {
  if (error instanceof KernelError) return error.message;
  throw error;
}

describe('Mesh to Solid, the segmentation', { timeout: 120_000 }, () => {
  it('puts every triangle of trashcan-spacer.stl on a surface, and refuses it without a trap', () => {
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

const stlDir = process.env.STL_DIR;
const tolerance = Number(process.env.TOL ?? '0.01');
const only = process.env.FILE;

describe.skipIf(!stlDir)('Mesh to Solid over STL_DIR', { timeout: 3_600_000 }, () => {
  const root = stlDir as string;
  for (const file of stlDir ? stlFiles(root) : []) {
    const name = relative(root, file);
    if (only && name !== only) continue;
    it(name, () => {
      const stl = readStl(new Uint8Array(readFileSync(file)));
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
                cells.push(
                  `✓ ${report.faces} faces (${report.planes}/${report.cylinders}/${report.cones}/${report.spheres}/${report.tori}), valid ${kernel.isValid(shape)}, vol ${ratio.toFixed(4)} (${Math.round(performance.now() - t0)} ms)`,
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
