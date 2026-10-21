/**
 * The Mesh to Solid dialog (P4-13, FR-IO-10, ADR-0095): a mesh body, the
 * method and (prismatic only) the fitting tolerance. Fields are named like
 * the feature's inputs (`MeshToSolidInputs`), so the framework's default
 * mapping turns them into inputs and back.
 */
import {
  type BodyId,
  MESH_TO_SOLID_METHODS,
  type MeshToSolidMethod,
  type MeshToSolidReport,
  meshToSolidFeature,
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

// The tolerance only matters to prismatic (ADR-0095 §1).
const isPrismatic = (v: Pick<DialogValues, 'choices'>) =>
  (v.choices.method ?? 'prismatic') === 'prismatic';

/** The surface counts a Result line reads (the report's, or the region preview's). */
type Counts = Pick<
  MeshToSolidReport,
  'planes' | 'cylinders' | 'cones' | 'spheres' | 'tori' | 'unfit'
>;

const KINDS = [
  ['planes', 'plane'],
  ['cylinders', 'cylinder'],
  ['cones', 'cone'],
  ['spheres', 'sphere'],
  ['tori', 'torus'],
] as const;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * "6 planes, 1 cylinder · 0 unfit" (ADR-0095 §4): every kind found, and the
 * unfit regions always.
 */
export function surfaceSummary(counts: Counts): string {
  const found = KINDS.filter(([key]) => counts[key] > 0).map(([key, one]) =>
    plural(counts[key], one, key === 'tori' ? 'tori' : undefined),
  );
  return [found.join(', '), `${counts.unfit.regions} unfit`].filter(Boolean).join(' · ');
}

/** The Result line: the region preview while prismatic, else the draft's report. */
function summary(
  values: Pick<DialogValues, 'choices'>,
  ctx: DialogContext | undefined,
): string | undefined {
  const regions = ctx?.draftRegions;
  const report = ctx?.draftMeshToSolid;
  if (isPrismatic(values) && regions) return surfaceSummary(regions);
  if (!report || report.method !== (values.choices.method ?? 'prismatic')) return undefined;
  return report.method === 'faceted' ? plural(report.faces, 'face') : surfaceSummary(report);
}

const LEGEND: readonly LegendEntry[] = [
  { tone: 'create', label: 'Planes' },
  { tone: 'sketch', label: 'Cylinders' },
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
      hint: 'Prismatic finds planes and cylinders and rebuilds exact faces. Faceted keeps every flat facet as a face.',
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
      hint: 'What Prismatic found on the mesh: its colours in the view. For a region that fits nothing, raise the tolerance or use Faceted.',
      shown: (values, ctx) => summary(values, ctx) !== undefined,
      text: (values, ctx) => summary(values, ctx) ?? '',
      legend: (values, ctx) => (isPrismatic(values) && ctx.draftRegions ? LEGEND : []),
    },
  ],
  // The solid replaces the mesh body under its own ID: drawn as a body.
  previewStyle: () => 'new',
  // ADR-0095 §5: prismatic colours the mesh by what its segmentation found,
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
