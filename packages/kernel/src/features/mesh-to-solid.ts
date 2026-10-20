/**
 * The Mesh to Solid feature in the kernel (P4-13, FR-IO-10, ADR-0095): turns
 * one imported mesh body into a B-rep solid through `Kernel.meshToSolid`
 * (§3), under the same body ID, so the body keeps its name, colour and place
 * in the browser. Suppressing the feature gives the mesh back.
 *
 * `faceted` merges the mesh's coplanar triangles into real faces; a solid of
 * more than `FACETED_FACE_CAP` faces is refused. `prismatic` (slice 3)
 * recognises planes and cylinders within `tolerance` and rebuilds exact
 * faces. A solid body (not a mesh) is refused with the message the kernel's
 * own check gives; the facade never falls back from one method to the other.
 *
 * The result's faces are named `toSolid:<feature>:face:<n>`, `n` the face's
 * position in the result shape, edges and vertices derived (ADR-0005): there
 * is no history into the mesh to name them from, so a later reference
 * survives until the mesh, the method or the tolerance changes. The report
 * (§4) goes out with the feature.
 */
import {
  type BodyId,
  MESH_TO_SOLID_DEFAULT_TOLERANCE,
  type MeshToSolidInputs,
  meshToSolidFeature,
  meshToSolidSettings,
} from '@extrudo/core';
import { KernelError, type MeshToSolidReport, type ShapeHandle } from '../kernel';
import { deriveNames, type TopoNames } from '../naming/names';
import type { EvalContext, FeatureOutput, KernelFeatureDefinition } from '../recompute/types';
import { splitSolids } from './bodies';
import { existing } from './transform';

/** The feature's report (ADR-0095 §4): `kind` plus the kernel's `MeshToSolidReport`. */
export interface MeshToSolidFeatureReport extends MeshToSolidReport {
  kind: 'meshToSolid';
}

/** Whether a kernel report is Mesh to Solid's. */
export function isMeshToSolidReport(report: unknown): report is MeshToSolidFeatureReport {
  return (report as { kind?: unknown } | null | undefined)?.kind === 'meshToSolid';
}

export const kernelMeshToSolid: KernelFeatureDefinition<MeshToSolidInputs> = {
  ...meshToSolidFeature,
  bodyAccess: () => 'write',
  evaluate: evaluateMeshToSolid,
};

function evaluateMeshToSolid(ctx: EvalContext<MeshToSolidInputs>): FeatureOutput {
  const { kernel } = ctx;
  const settings = meshToSolidSettings(ctx.inputs);
  if (!settings.body) throw new KernelError('Pick the mesh body to convert.');
  const [id] = existing(ctx, [settings.body], 'convert');
  const shape = ctx.bodies.get(id) as ShapeHandle;
  if (!kernel.isMesh(shape)) {
    // The kernel throws the same text; checking first keeps the feature's
    // message exact (ADR-0095 §1).
    throw new KernelError('Mesh to Solid needs a mesh body: this body is already a solid.');
  }
  const tolerance = ctx.inputs.tolerance ? ctx.value('tolerance') : MESH_TO_SOLID_DEFAULT_TOLERANCE;
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new KernelError('The tolerance must be greater than 0 mm.');
  }

  using scope = kernel.scope();
  const { shape: solid, report } = kernel.meshToSolid(shape, {
    method: settings.method,
    tolerance,
  });
  scope.track(solid);
  // The names before the keep: a shape kept and then lost to a throw would
  // leak (ADR-0024).
  const names = new Map<BodyId, TopoNames>([[id, meshToSolidNames(ctx, solid)]]);
  const bodies = new Map(ctx.bodies);
  bodies.set(id, scope.keep(solid));
  const output = splitSolids(ctx, scope, { bodies, names });
  return { ...output, report: { kind: 'meshToSolid', ...report } };
}

/**
 * Every face of the converted shape named `toSolid:<feature>:face:<n>`, its
 * edges and vertices derived from those faces (ADR-0005, as `importNames`).
 */
function meshToSolidNames(ctx: EvalContext, shape: ShapeHandle): TopoNames {
  const description = ctx.describe(shape);
  return deriveNames(
    description.faces.map((_, i) => `toSolid:${ctx.feature.id}:face:${i + 1}`),
    description,
  );
}
