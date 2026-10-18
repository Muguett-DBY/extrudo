import type { FeatureId } from '@extrudo/core';
import type { Preview } from '@extrudo/kernel';
import { describe, expect, it } from 'vitest';
import { shallow } from 'zustand/shallow';
import { boxMesh } from '../selection/testing';
import { previewInputs } from './dialog';
import { BOX, faceItem, namedBoxMesh, settle, setupDialogs } from './testing';
import { shellParts } from './useFeatureDialogs';

function preview(over: Partial<Preview> = {}): Preview {
  return { features: {}, bodies: {}, tools: [], ...over };
}

// A handle drag rewrites an expression on every pointer move: the shell must not
// render for it, and the view only for its preview: the ghost the handle moves,
// and the kernel's answer.
describe('what the shell and the view follow of an open dialog (issue #76)', () => {
  it('keeps the shell still while an expression changes, and the drawing until an answer', async () => {
    const t = setupDialogs();
    t.controller.start('fake-press');
    t.controller.select.onClick(faceItem(1), false);
    await settle();
    t.kernel.previews.at(-1)?.resolve(preview({ tools: [{ mesh: boxMesh(), style: 'join' }] }));
    await settle();
    const shell = shellParts(t.open());
    const view = previewInputs(t.open());
    expect(view).toBeDefined();

    t.controller.setExpr('distance', '7 mm');
    expect(shallow(shellParts(t.open()), shell)).toBe(true);
    // The ghost follows the handle; the kernel's drawing stays until its answer.
    expect(previewInputs(t.open())?.drawing).toBe(view?.drawing);
    expect(previewInputs(t.open())?.ghost).toBeDefined();

    t.kernel.previews.at(-1)?.resolve(preview({ tools: [{ mesh: boxMesh(), style: 'join' }] }));
    await settle();
    expect(shallow(previewInputs(t.open()), view)).toBe(false);
    expect(shallow(shellParts(t.open()), shell)).toBe(true);

    // Half-typed text dims the preview; a choice is the shell's to follow.
    t.controller.setTyping('distance', 'Distance: Unknown name `wal`.');
    expect(previewInputs(t.open())?.dimmed).toBe(true);
    t.controller.setChoice('operation', 'cut');
    expect(shallow(shellParts(t.open()), shell)).toBe(false);
  });

  it("keeps an edited feature's base while each preview brings the same meshes", async () => {
    const t = setupDialogs();
    t.session.getState().select([faceItem(1)]);
    t.controller.start('fake-press');
    t.controller.ok();
    t.controller.edit(t.store.getState().doc.features[1]?.id as FeatureId);
    const before = namedBoxMesh();
    t.kernel.previews.at(-1)?.resolve(preview({ base: { [BOX]: before } }));
    await settle();
    const shell = shellParts(t.open());
    t.controller.setExpr('distance', '7 mm');
    t.kernel.previews.at(-1)?.resolve(preview({ base: { [BOX]: before } }));
    await settle();
    expect(shallow(shellParts(t.open()), shell)).toBe(true);
  });
});
