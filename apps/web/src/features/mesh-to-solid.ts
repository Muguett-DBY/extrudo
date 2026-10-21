/**
 * The Mesh to Solid dialog (P4-13, FR-IO-10, ADR-0097): a mesh body, the
 * method and (prismatic only) the fitting tolerance. Fields are named like
 * the feature's inputs (`MeshToSolidInputs`), so the framework's default
 * mapping turns them into inputs and back.
 */
import {
  type BodyId,
  MESH_TO_SOLID_METHODS,
  type MeshToSolidMethod,
  meshSurfaceSummary,
  meshToSolidFeature,
  meshToSolidSummary,
} from '@extrudo/core';
import {
  type DialogContext,
  type DialogValues,
  defineFeatureDialog,
  type LegendEntry,
} from './spec';

const METHOD_LABELS: Record<MeshToSolidMethod, string> = {
  prismatic: 'Prismatic',
  faceted: 'Faceted',
};

// The tolerance only matters to prismatic (ADR-0097 §1).
const isPrismatic = (v: Pick<DialogValues, 'choices'>) =>
  (v.choices.method ?? 'prismatic') === 'prismatic';

/** The Result line: the region preview while prismatic, else the draft's report. */
function summary(
  values: Pick<DialogValues, 'choices'>,
  ctx: DialogContext | undefined,
): string | undefined {
  const regions = ctx?.draftRegions;
  const report = ctx?.draftMeshToSolid;
  if (isPrismatic(values) && regions) return meshSurfaceSummary(regions);
  if (!report || report.method !== (values.choices.method ?? 'prismatic')) return undefined;
  return meshToSolidSummary(report);
}

const LEGEND: readonly LegendEntry[] = [
  { tone: 'create', label: 'Planes' },
  { tone: 'sketch', label: 'Curved' },
  { tone: 'error', label: 'Fits nothing' },
];

export const meshToSolidDialog = defineFeatureDialog({
  ...meshToSolidFeature,
  command: 'meshToSolid',
  fields: [
    {
      kind: 'selection',
      name: 'body',
      label: 'Body',
      accepts: ['body'],
      max: 1,
      prompt: 'Pick a mesh body',
      hint: 'An imported mesh (STL, 3MF, OBJ, OpenSCAD). The solid replaces it under the same name.',
    },
    {
      kind: 'choice',
      name: 'method',
      label: 'Method',
      options: MESH_TO_SOLID_METHODS.map((value) => ({ value, label: METHOD_LABELS[value] })),
      default: 'prismatic',
      hint: 'Prismatic finds planes, cylinders, cones, spheres and tori and rebuilds exact faces. Faceted keeps every flat facet as a face.',
    },
    {
      kind: 'expression',
      name: 'tolerance',
      label: 'Tolerance',
      unit: 'length',
      default: '0.01 mm',
      hint: 'How far a facet may sit from a fitted surface (Prismatic only).',
      shown: isPrismatic,
    },
    {
      kind: 'info',
      name: 'summary',
      label: 'Result',
      hint: 'What Prismatic found on the mesh: its colours in the view: planes, curved surfaces (cylinders, cones, spheres, tori), and what fits nothing. For a region that fits nothing, raise the tolerance or use Faceted.',
      shown: (values, ctx) => summary(values, ctx) !== undefined,
      text: (values, ctx) => summary(values, ctx) ?? '',
      legend: (values, ctx) => (isPrismatic(values) && ctx.draftRegions ? LEGEND : []),
    },
  ],
  // The solid replaces the mesh body under its own ID: drawn as a body.
  previewStyle: () => 'new',
  // ADR-0097 §5: prismatic colours the mesh by what its segmentation found,
  // in milliseconds, while the draft's solid (its status, the Result line's
  // report) is built behind it.
  regions: (values, ctx) => {
    const body = values.refs.body?.[0];
    if (!isPrismatic(values) || body?.kind !== 'body') return undefined;
    const tolerance = ctx.value('tolerance');
    if (tolerance === undefined || !(tolerance > 0)) return undefined;
    return { body: body.id as BodyId, tolerance };
  },
});
