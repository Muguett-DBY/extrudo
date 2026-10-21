/**
 * Mesh to Solid's region preview in the view (ADR-0095 §5): a mesh body's
 * triangles coloured by the kind of surface prismatic's segmentation put
 * them on. A mesh shares its nodes between triangles of different surfaces,
 * so the coloured copy is de-indexed: three nodes of its own per triangle.
 * Kept out of `Bodies.tsx` so it is tested without React Three Fiber.
 */
import { MESH_REGION_KIND } from '@extrudo/core';
import type { BodyMesh } from '@extrudo/kernel';
import type { ViewRegions } from '../features/preview';

/** The colours of the region kinds, linear RGB (as a colour attribute takes them). */
export interface RegionPalette {
  /** Planes: the `create` category colour. */
  plane: readonly [number, number, number];
  /** Cylinders and every other curved kind: the `sketch` category colour. */
  curved: readonly [number, number, number];
  /** Regions that fit nothing: the `error` colour. */
  unfit: readonly [number, number, number];
}

export interface RegionGeometry {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
}

/**
 * The de-indexed, coloured copy of `mesh` for `regions`, or undefined when
 * the regions don't belong to this mesh (another triangle count: the body
 * changed since they were asked for).
 */
export function regionGeometry(
  mesh: BodyMesh,
  regions: Pick<ViewRegions, 'surfaceOf' | 'kinds'>,
  palette: RegionPalette,
): RegionGeometry | undefined {
  const { positions: p, normals: n, indices } = mesh;
  const triangles = indices.length / 3;
  if (regions.surfaceOf.length !== triangles) return undefined;
  const positions = new Float32Array(9 * triangles);
  const normals = new Float32Array(9 * triangles);
  const colors = new Float32Array(9 * triangles);
  for (let t = 0; t < triangles; t++) {
    const kind = regions.kinds[regions.surfaceOf[t] as number] ?? MESH_REGION_KIND.unfit;
    const color =
      kind === MESH_REGION_KIND.plane
        ? palette.plane
        : kind === MESH_REGION_KIND.unfit
          ? palette.unfit
          : palette.curved;
    for (let k = 0; k < 3; k++) {
      const node = indices[3 * t + k] as number;
      const at = 9 * t + 3 * k;
      positions.set(p.subarray(3 * node, 3 * node + 3), at);
      normals.set(n.subarray(3 * node, 3 * node + 3), at);
      colors.set(color, at);
    }
  }
  return { positions, normals, colors };
}
