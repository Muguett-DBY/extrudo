/**
 * The Mesh to Solid dialog (P4-13, FR-IO-10, ADR-0097): a mesh body, the
 * method and (prismatic only) the tolerance. The tolerance is Auto by
 * default (slice D2): the kernel picks one from the mesh, and only Custom
 * writes the `tolerance` input. The fields are named like the feature's
 * inputs where they are one (`body`, `method`, `tolerance`); `toleranceMode`
 * is a dialog-only choice, so the spec maps the inputs itself.
 */
import {
  type BodyId,
  type FeatureInputs,
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

// Auto is the default (ADR-0097, slice D2); Custom writes the value below.
const isCustom = (v: Pick<DialogValues, 'choices'>) =>
  (v.choices.toleranceMode ?? 'auto') === 'custom';

/**
 * The Result line: the region preview while prismatic, else the draft's
 * report; a hybrid result's report (it says what stayed facets) once it is in.
 * Either carries " · auto 0.02 mm" when the tolerance was Auto.
 */
function summary(
  values: Pick<DialogValues, 'choices'>,
  ctx: DialogContext | undefined,
): string | undefined {
  const regions = ctx?.draftRegions;
  const report = ctx?.draftMeshToSolid;
  const current = report?.method === (values.choices.method ?? 'prismatic');
  if (current && report?.rebuild === 'hybrid') return meshToSolidSummary(report);
  if (isPrismatic(values) && regions) return meshSurfaceSummary(regions);
  if (!report || !current) return undefined;
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
      hint: 'Prismatic finds planes, cylinders, cones, spheres and tori and rebuilds exact faces; what fits nothing stays as facets. Faceted keeps every flat facet as a face.',
    },
    {
      kind: 'choice',
      name: 'toleranceMode',
      label: 'Tolerance',
      options: [
        { value: 'auto', label: 'Auto' },
        { value: 'custom', label: 'Custom' },
      ],
      default: 'auto',
      shown: isPrismatic,
      hint: 'Auto picks the tolerance from the mesh (0.01 to 0.1 mm). Custom uses the value below.',
    },
    {
      kind: 'expression',
      name: 'tolerance',
      label: 'Custom tolerance',
      unit: 'length',
      default: '0.01 mm',
      hint: 'How far a facet may sit from a fitted surface (Prismatic only).',
      shown: (values) => isPrismatic(values) && isCustom(values),
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
  // `toleranceMode` is a dialog-only choice (no input): Auto writes no
  // `tolerance` input; Custom writes the expression (ADR-0097, slice D2).
  toInputs: (values): FeatureInputs => {
    const inputs: FeatureInputs = {
      body: { kind: 'ref', refs: [...(values.refs.body ?? [])] },
      method: { kind: 'enum', value: values.choices.method ?? 'prismatic' },
    };
    if (isPrismatic(values) && isCustom(values)) {
      inputs.tolerance = {
        kind: 'expr',
        expr: values.exprs.tolerance ?? '0.01 mm',
        unit: 'length',
      };
    }
    return inputs;
  },
  // A feature whose `tolerance` input is present opens with Custom selected.
  fromInputs: (inputs): Partial<DialogValues> => ({
    refs: inputs.body?.kind === 'ref' ? { body: [...inputs.body.refs] } : {},
    choices: {
      method: inputs.method?.kind === 'enum' ? inputs.method.value : 'prismatic',
      toleranceMode: inputs.tolerance ? 'custom' : 'auto',
    },
    exprs: inputs.tolerance?.kind === 'expr' ? { tolerance: inputs.tolerance.expr } : {},
  }),
  // The solid replaces the mesh body under its own ID: drawn as a body.
  previewStyle: () => 'new',
  // ADR-0097 §5: prismatic colours the mesh by what its segmentation found,
  // in milliseconds, while the draft's solid (its status, the Result line's
  // report) is built behind it. Auto asks the kernel with -1 (slice D2).
  regions: (values, ctx) => {
    const body = values.refs.body?.[0];
    if (!isPrismatic(values) || body?.kind !== 'body') return undefined;
    const tolerance = isCustom(values) ? ctx.value('tolerance') : -1;
    if (tolerance === undefined || (tolerance !== -1 && !(tolerance > 0))) return undefined;
    return { body: body.id as BodyId, tolerance };
  },
});
