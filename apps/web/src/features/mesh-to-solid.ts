/**
 * The Mesh to Solid dialog (P4-13, FR-IO-10, ADR-0095): a mesh body, the
 * method and (prismatic only) the fitting tolerance. Fields are named like
 * the feature's inputs (`MeshToSolidInputs`), so the framework's default
 * mapping turns them into inputs and back.
 */
import { MESH_TO_SOLID_METHODS, type MeshToSolidMethod, meshToSolidFeature } from '@extrudo/core';
import { type DialogValues, defineFeatureDialog } from './spec';

const METHOD_LABELS: Record<MeshToSolidMethod, string> = {
  prismatic: 'Prismatic',
  faceted: 'Faceted',
};

// The tolerance only matters to prismatic (ADR-0095 §1).
const isPrismatic = (v: DialogValues) => (v.choices.method ?? 'prismatic') === 'prismatic';

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
  ],
  // The solid replaces the mesh body under its own ID: drawn as a body.
  previewStyle: () => 'new',
});
