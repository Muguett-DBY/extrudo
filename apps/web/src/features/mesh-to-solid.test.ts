import { MeshToSolidInputsSchema, meshToSolidSettings } from '@extrudo/core';
import { describe, expect, it } from 'vitest';
import { meshToSolidDialog } from './mesh-to-solid';
import { featureDialogs, specForCommand } from './registry';
import { BOX, setupDialogs } from './testing';
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
    ).toEqual(['body', 'method']);
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
    // The method defaults to faceted for now (ADR-0095 §3, slice 3 flips it).
    expect(t.open()?.values.choices.method).toBe('faceted');
    expect(MeshToSolidInputsSchema.safeParse(t.open()?.draft.inputs).success).toBe(true);
    expect(t.controller.ok()).toBe(true);
    const feature = t.store.getState().doc.features.at(-1);
    expect(feature).toMatchObject({ type: 'meshToSolid', name: 'Mesh to Solid1' });
    expect(meshToSolidSettings(feature?.inputs as never)).toMatchObject({
      body: { kind: 'body', id: BOX },
      method: 'faceted',
    });
  });
});
