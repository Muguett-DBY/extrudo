import {
  type FeatureId,
  MeshToSolidInputsSchema,
  type MeshToSolidReport,
  meshToSolidSettings,
  meshSurfaceSummary as surfaceSummary,
} from '@extrudo/core';
import type { MeshRegions, Preview } from '@extrudo/kernel';
import { describe, expect, it } from 'vitest';
import { viewPreview } from './dialog';
import { meshToSolidDialog } from './mesh-to-solid';
import { featureDialogs, specForCommand } from './registry';
import type { InfoField } from './spec';
import { BOX, settle, setupDialogs } from './testing';
import { defaultValues, shownFields } from './values';

const shown = (method: 'prismatic' | 'faceted') => {
  const values = defaultValues(meshToSolidDialog);
  return shownFields(meshToSolidDialog, {
    ...values,
    choices: { ...values.choices, method },
  }).map((f) => f.name);
};

describe('the mesh to solid dialog', () => {
  it('is the app’s dialog for the Mesh to Solid tool, a modify feature', () => {
    expect(specForCommand(featureDialogs(), 'meshToSolid')?.type).toBe('meshToSolid');
    expect(meshToSolidDialog.category).toBe('modify');
    expect(
      shownFields(meshToSolidDialog, defaultValues(meshToSolidDialog)).map((f) => f.name),
    ).toEqual(['body', 'method', 'tolerance']);
  });

  it('picks one mesh body', () => {
    const body = meshToSolidDialog.fields.find((f) => f.name === 'body');
    expect(body).toMatchObject({ kind: 'selection', accepts: ['body'], max: 1 });
  });

  it('shows the tolerance only while the method is prismatic', () => {
    expect(shown('prismatic')).toEqual(['body', 'method', 'tolerance']);
    expect(shown('faceted')).toEqual(['body', 'method']);
  });

  it('takes a selected body; OK inserts a conversion whose inputs parse', () => {
    const t = setupDialogs([meshToSolidDialog]);
    t.session.getState().select([{ kind: 'body', id: BOX }]);
    t.controller.start('meshToSolid');
    expect(t.open()?.values.refs.body).toEqual([{ kind: 'body', id: BOX }]);
    // The method defaults to prismatic (ADR-0097 §1).
    expect(t.open()?.values.choices.method).toBe('prismatic');
    expect(MeshToSolidInputsSchema.safeParse(t.open()?.draft.inputs).success).toBe(true);
    expect(t.controller.ok()).toBe(true);
    const feature = t.store.getState().doc.features.at(-1);
    expect(feature).toMatchObject({ type: 'meshToSolid', name: 'Mesh to Solid1' });
    expect(meshToSolidSettings(feature?.inputs as never)).toMatchObject({
      body: { kind: 'body', id: BOX },
      method: 'prismatic',
    });
  });
});

const NONE = { regions: 0, triangles: 0, fraction: 0 };

/** The box's six planes as the kernel's region preview gives them. */
function sixPlanes(): MeshRegions {
  return {
    surfaceOf: new Int32Array([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]),
    kinds: new Int32Array(6),
    planes: 6,
    cylinders: 0,
    cones: 0,
    spheres: 0,
    tori: 0,
    unfit: NONE,
  };
}

/** A preview of the draft with its Mesh to Solid report. */
function previewWith(id: FeatureId, report: MeshToSolidReport): Preview {
  return { features: { [id]: { status: 'ok' } }, bodies: {}, tools: [], meshToSolid: report };
}

const counts = { planes: 0, cylinders: 0, cones: 0, spheres: 0, tori: 0, unfit: NONE };

describe('the mesh to solid dialog: regions and the Result line (ADR-0097 §4, §5)', () => {
  const summaryField = meshToSolidDialog.fields.find((f) => f.name === 'summary') as InfoField;

  /** The Result line and its legend as the dialog shows them, or undefined while hidden. */
  const result = (t: ReturnType<typeof setupDialogs>) => {
    const open = t.open();
    const ctx = t.controller.context();
    if (!open || !ctx) return undefined;
    if (!shownFields(meshToSolidDialog, open.values, ctx).some((f) => f.name === 'summary')) {
      return undefined;
    }
    return {
      text: summaryField.text(open.values, ctx),
      legend: summaryField.legend?.(open.values, ctx).map((e) => e.tone) ?? [],
    };
  };

  /** A conversion dialog on the box (as if it were a mesh). */
  const started = () => {
    const t = setupDialogs([meshToSolidDialog]);
    t.session.getState().select([{ kind: 'body', id: BOX }]);
    t.controller.start('meshToSolid');
    return t;
  };

  it('says what was found: kinds with a count, unfit always', () => {
    expect(surfaceSummary({ ...counts, planes: 6 })).toBe('6 planes · 0 unfit');
    expect(surfaceSummary({ ...counts, planes: 6, cylinders: 1 })).toBe(
      '6 planes, 1 cylinder · 0 unfit',
    );
    expect(surfaceSummary({ ...counts, planes: 1, spheres: 1 })).toBe(
      '1 plane, 1 sphere · 0 unfit',
    );
    expect(surfaceSummary({ ...counts, planes: 1, tori: 2, unfit: { ...NONE, regions: 3 } })).toBe(
      '1 plane, 2 tori · 3 unfit',
    );
    expect(surfaceSummary({ ...counts, unfit: { ...NONE, regions: 1 } })).toBe('1 unfit');
  });

  it('asks for the regions of the picked body at the tolerance, and shows them', async () => {
    const t = started();
    expect(t.kernel.regions).toHaveLength(1);
    expect(t.kernel.regions[0]).toMatchObject({ body: BOX, tolerance: 0.01, base: false });
    expect(result(t)).toBeUndefined();
    t.kernel.regions[0]?.resolve(sixPlanes());
    await settle();
    expect(t.open()?.preview.regions?.body).toBe(BOX);
    expect(result(t)).toEqual({
      text: '6 planes · 0 unfit',
      legend: ['create', 'sketch', 'error'],
    });
    // The view colours the body in place of any drawing.
    const view = viewPreview(t.open());
    expect(view?.regions?.body).toBe(BOX);
    expect(view?.shapes).toEqual([]);
    // The preview's answer keeps the regions.
    t.kernel.previews.at(-1)?.resolve(
      previewWith(t.open()?.id as FeatureId, {
        method: 'prismatic',
        faces: 6,
        ...counts,
        planes: 6,
      }),
    );
    await settle();
    expect(t.open()?.preview.regions).toBeDefined();
  });

  it('asks again when the tolerance changes, and drops the late answer', async () => {
    const t = started();
    t.controller.setExpr('tolerance', '0.05 mm');
    expect(t.kernel.regions.map((r) => r.tolerance)).toEqual([0.01, 0.05]);
    t.kernel.regions[0]?.resolve(sixPlanes());
    await settle();
    expect(t.open()?.preview.regions).toBeUndefined();
    t.kernel.regions[1]?.resolve({ ...sixPlanes(), planes: 5 });
    await settle();
    expect(t.open()?.preview.regions?.planes).toBe(5);
    // The same request again asks nothing.
    t.controller.setExpr('tolerance', '0.05 mm');
    expect(t.kernel.regions).toHaveLength(2);
  });

  it('clears the regions for Faceted, whose line is the report: "6 faces"', async () => {
    const t = started();
    t.kernel.regions[0]?.resolve(sixPlanes());
    await settle();
    t.controller.setChoice('method', 'faceted');
    expect(t.open()?.preview.regions).toBeUndefined();
    expect(viewPreview(t.open())?.regions).toBeUndefined();
    expect(t.kernel.regions).toHaveLength(1);
    t.kernel.previews.at(-1)?.resolve(
      previewWith(t.open()?.id as FeatureId, {
        method: 'faceted',
        faces: 6,
        ...counts,
        planes: 6,
      }),
    );
    await settle();
    expect(result(t)).toEqual({ text: '6 faces', legend: [] });
    // Back to prismatic: asked again.
    t.controller.setChoice('method', 'prismatic');
    expect(t.kernel.regions).toHaveLength(2);
  });

  it('drops an answer that comes after the dialog closed', async () => {
    const t = started();
    t.controller.cancel();
    t.kernel.regions[0]?.resolve(sixPlanes());
    await settle();
    expect(t.open()).toBeUndefined();
  });

  it('editing waits for the base: the mesh before the feature is only there', async () => {
    const t = started();
    expect(t.controller.ok()).toBe(true);
    const id = t.store.getState().doc.features.at(-1)?.id as FeatureId;
    t.controller.edit(id);
    const asked = t.kernel.regions.length;
    t.kernel.previews.at(-1)?.resolve({
      ...previewWith(id, { method: 'prismatic', faces: 6, ...counts, planes: 6 }),
      base: { [BOX]: t.mesh },
    });
    await settle();
    expect(t.kernel.regions).toHaveLength(asked + 1);
    expect(t.kernel.regions.at(-1)).toMatchObject({ body: BOX, base: true });
  });
});
