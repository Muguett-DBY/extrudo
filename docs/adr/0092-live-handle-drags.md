# ADR-0092: Live handle drags: one preview at a time, a still shell, an optimistic ghost

- **Status:** Accepted, 2026-10-18
- **Issue:** #76 ("Handle drags should feel live", tester feedback).
- **Builds on:** ADR-0027 (feature dialogs, live previews through the
  `Recomputer`), ADR-0028 (extrude, press-pull).
- **No schema or file-format change.**

## Context

A tester found handle drags "clunky": the preview ghost didn't follow the pointer.
Measured on the dev laptop (production build, a 60 Hz pointer, the Wall bracket
template), the ghost **didn't move at all during a continuous drag**: it jumped
when the pointer paused. Three causes:

1. **The `Recomputer`'s 60 ms trailing debounce** restarted on every pointer move,
   so while the pointer kept moving no preview was ever asked for.
2. **Every dialog change rendered the whole `AppShell`** (about 2800 lines; 10–12 ms
   in production, ~250 ms in development), because `useFeatureDialogs` returned the
   whole `OpenDialog` and the shell read the preview from it.
3. **A kernel preview takes time**: editing Extrude1 is ~4 ms of kernel work, a
   press-pull join on the filleted bracket ~34 ms in Node (OCCT 20–25 ms, meshing
   6–14 ms; transfer is at most 52 KiB) and 60–100 ms in the browser. Even with
   1 and 2 fixed the ghost trails the pointer by one preview.

## Decision

### 1. One preview at a time; the newest draft waits (`packages/kernel/src/recomputer.ts`)

`RecomputeEngine.preview` no longer debounces. One preview runs at a time; while it
runs, **only the newest draft waits** (a waiting one that a newer draft replaces
resolves `undefined`), and it starts as soon as the running one ends. A running
preview still resolves with its own answer, so the dialog can show it;
`endPreview` drops it. `previewDelayMs` defaults to 0 and applies only when nothing
is running.

The dialog (`apps/web/src/features/dialog.ts`) **shows an older draft's answer**
while a newer one is on its way (marked `pending`), and never one older than the one
it shows (`shownSequence`). A dialog with its own `previewDelay` (the script's
debounce) still shows only its current draft's answer.

### 2. The shell follows a still slice of the dialog (`useFeatureDialogs.ts`)

`useFeatureDialogs` subscribes with `useShallow(shellParts)`: mode, ID, note, spec,
pick field, base, refs, choices, toggles and labels, **not the expressions**. It
returns a `DialogShell` with `values: ShownValues` (`DialogValues` without `exprs`),
so a field's `shown` rule can't read an expression any more (the type says so). The
viewport reads the preview through `DialogViewport` and `useViewPreview`
(`useShallow(previewInputs)`), so a typed or dragged value renders the view only.
An edited feature's `base` keeps its record while its meshes are the same.

### 3. An optimistic ghost on the UI thread (`apps/web/src/features/ghost.ts`)

A distance arrow may say `ghost: 'stretch' | 'move'` and an angle arc
`ghost: 'turn'`. When the dialog asks for a preview it keeps the draft's
**ghost hints** (each such handle's rule, origin, direction or axis, scale and
the field's value); the preview shown carries the hints of the draft it was made
from. On every change `ghostMatrix` turns "what the handles changed since" into
one world matrix (`DialogPreview.ghost`, `ViewPreview.ghost`), and `PreviewShapes`
draws the shapes under it. The kernel's answer for the current draft brings hints
whose values are the current ones, so the matrix goes away.

- `stretch`: from the plane through the arrow's origin across its direction, by
  new ÷ shown (an extrude of one side or symmetric, a box's length, width and
  height, a cylinder's height). It doesn't stretch through zero.
- `move`: along the direction by the change times the arrow's scale (Move's free
  arrows, a primitive's X, Y and Offset).
- `turn`: about the axis through the origin (Move's rotate mode, a box's rotation).

No ghost while the values are invalid or the shown draft failed: that drawing stays
where it was, dimmed.

### Measured after (production build, dev laptop, headless Chromium with GPU)

| Drag | before | after |
|---|---|---|
| Edit Extrude1: kernel answers per second | 0 | 31–35 |
| Press-pull on the bracket: kernel answers per second | 0 | 15–21 |
| Press-pull: ghost behind the arrow (video, median / p90 / max) | 137 / 205 / 342 ms | 0 / 24 / 94 ms |
| Frames | 17 ms | 17 ms, no long tasks |

## Rejected

- **Coarser tessellation and no edges while dragging** (the issue's third item):
  meshing is 6–14 ms of a ~34 ms press-pull, so a coarser mesh saves 4–8 ms, and
  the ghost already follows the pointer.
- **A shorter debounce**: any trailing debounce waits for the pointer to stop.
- **Cancelling the running preview**: OCCT can't be interrupted inside an
  operation, and dropping its answer would leave the ghost with nothing new.
- **Moving the ghost in the worker**: it would still wait one round trip.
- **Free-move rotation rings as `turn`**: Move turns about the unmoved bodies'
  centre and then translates, so a turn about the ring's origin is wrong once the
  bodies were moved; those rings wait for the kernel (it is quick for a move).
  Diameters (cylinder, sphere, torus) and two-sided extrudes don't stretch along
  one direction, so they have no hint either.

## Consequences

- A new handle that changes a ghost rigidly (or stretches it from a plane) should
  say so with `ghost`; a wrong hint shows a wrong ghost until the kernel's answer,
  so leave it out where the change isn't one of the three.
- Field `shown` rules read `ShownValues`: a field that must hide on an expression's
  value needs another way (a choice or toggle).
- `previewInputs` and `shellParts` are what the view and the shell follow; a new
  field that the shell needs goes into `shellParts`.
