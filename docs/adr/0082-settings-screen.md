# ADR-0082: A Settings screen

- **Status:** Accepted, 2026-10-10 (the owner: "PLA density should by default be
  1.24. There should be a proper general settings screen where this can be
  tweaked.").
- **Builds on:** ADR-0008 (display settings as preferences, mouse presets),
  ADR-0034 (`export.model`), ADR-0042 (`marking.radial`, `marking.slots`),
  ADR-0048 and its P4-12 amendment (`print.material`), ADR-0062 (`slicers.paths`),
  ADR-0074 (`viewport.autoProject`), ADR-0075 (the desktop preferences file),
  ADR-0079 round 2 (the gear's Settings menu).

## Context

A person's settings are scattered: the gear menu has a few checkboxes, the
Print Info panel has the material fields, the sketch palette has its display
checkboxes, the Export dialog remembers its own choices, the theme lives in
the gear and on the home screen. All of them are **preferences** (per browser
or desktop install, `platform.preferences`), never in the document. There is
nowhere to see them together, and one useful thing, a material's density, can
only be changed for the "Custom" material.

PLA's built-in density already is 1.24 g/cm³; what showed 1.3 was the *custom*
density's default. The request is really "a density you can tweak, starting at
1.24, in one place".

## Decision

1. **A modal dialog "Settings"** (`apps/web/src/settings/`), opened from the
   gear's new "Settings…" item, the command `openSettings` ("Settings…", Ctrl+K),
   the key **Ctrl+,** (`keymap.ts`) and a gear on the home screen. Same dialog on
   the desktop. macOS's native menu has no Settings item today, so nothing
   changes in main.
2. **Sections down a left list, the page on the right**; below 640 px one
   column with the list as a select. The last section is remembered in the
   `settings.section` preference.
3. **Sections:** General (theme, radial right-click menu, Customize Marking
   Menu…), View and navigation (mouse preset, projection, visual style, grid),
   Sketch (snap, the four display checkboxes, auto-project, auto-project face,
   Slice), 3D printing (materials with editable densities, filament diameter,
   walls, line width, infill, price per kg; reset per field and per section),
   Export (default format and resolution), Desktop (slicer paths; only where
   `platform.desktop` exists). `settings/inventory.ts` maps every preference key
   to a section or to an explicit "not in settings" list with a reason; a unit
   test scans the source for keys and fails on one that is in neither.
4. **Same state, not copies.** The gear menu, the sketch palette, the Print
   Info panel and the Export dialog keep their controls; the dialog reads and
   writes the same stores. The print settings move into one per-`Preferences`
   store (`print/materialStore.ts`, `useSyncExternalStore`) that Print Info and
   the dialog both use, so an edit in either shows in the other at once.
5. **Density overrides.** `print.material` gains an optional `densities`
   record: `{ pla: "1.3" }` holds **only** overrides (expressions, as the custom
   density is). A material without an entry follows the built-in value in
   `MATERIALS`, so a later change to a built-in reaches everyone who never
   touched it; writing the built-in value back removes the entry. Preferences
   written before still read: `densities` is optional, `density` stays the
   custom material's own. Custom's default density becomes `1.24` (a custom
   material starts from PLA).
6. **Print Info shows Density for every material** (it showed it for Custom
   only): editing it writes the material's override.
7. **Validation** is `checkPrintField`; every number is an `<ExpressionInput>`
   evaluated unitless (a density is g/cm³ whatever the document's units), with
   the open design's parameters available when there is one.

## Rejected

- **A separate route `#/settings`.** Settings are used from inside a design
  (turn off auto-project, then go back to the sketch); a route loses the
  viewport and needs the project to reload on return.
- **Moving the controls out of the gear, the palette and Print Info.** The
  quick checkboxes are where the person is working; removing them makes the
  common toggle two clicks longer.
- **Copying values into the dialog's own state and syncing on close.** Two
  sources of truth; the Print Info panel could show a different density from
  the dialog while both are open.
- **Storing the full density table.** A person who never touched PLA would
  keep a stale copy of 1.24 forever.
- **A per-document material.** The owner asked for a preference; a design's
  parameters already cover per-design numbers.
- **Auto-update on/off and zoom-to-pointer.** The updater has no such switch
  and zoom has no preference today; the task was to gather what exists, not
  add behaviour.
- **Custom export deviation/angle in the dialog.** They carry units and the
  Export dialog already owns them.

## Consequences

Adding a preference now means placing it in a section (or the exclusion list)
or `settings/inventory.test.ts` fails. Import/export of settings and document
settings (units, precision) stay out of scope; keyboard shortcut editing came with
the 2026-10-18 amendment below.

## Amendment, 2026-10-18 (a Keyboard section: your own keys)

User feedback asked for keys for the sketch constraints; the owner asked for a way to
change any command's keys, the way mainstream CAD does.

1. **The `keymap.overrides` preference** holds only what a person changed, like the
   density overrides: `{ horizontal: ["H"], trim: [] }`. An entry replaces the command's
   default keys (an empty list means no key); a command without one follows
   `DEFAULT_KEYMAP`, so a later change to a default reaches everyone who never touched
   it. Writing a command's default keys back removes the entry.
2. **One place resolves keys.** `keysFor(id)` in `commands/keymap.ts` returns the
   override, else the default; `defaultKeysFor(id)` is for what must not follow a
   person's browser (the generated tool pages, the native-menu accelerator test).
   `commands/keymapStore.ts` loads the preference once per `Preferences` (in `App`),
   writes it and tells subscribers; the shell's command, dialog-command and shortcut lists
   rebuild on a change, so the toolbar, menus, tooltips, search, the marking menu and the
   desktop's native menu show the new key at once.
3. **Settings › Keyboard.** Every command either mode offers (plus Search, Search at the
   pointer and Help), filtered by text and by All / Model / Sketch / Changed. Click a key
   (or "Add key") to record: the next key combination, or two in a row for a chord
   (`K H`); Enter keeps a single key, Esc cancels. Esc, Tab, Enter and the browser's own
   Ctrl+W/T/N/Tab can't be recorded. Each changed command has a Reset, the page a Reset
   all.
4. **Conflicts.** A key another command uses **in the same mode** (or a chord whose first
   key is someone's single key there) is not saved silently: the row says whose it is and
   offers Replace (the other command loses it) or Cancel. Sharing a key across modes
   (H for Hole on the model and Horizontal in a sketch) is allowed and shown as a note.
5. **In place.** Right-clicking a toolbar tile offers "Change shortcut…", and every row in
   Search has a key button; both open Settings › Keyboard recording that command.
6. **The native menu** gets an accelerator only for a key Electron understands; a chord
   shows in the label's tooltip and runs through the web handler, not the menu.

**Rejected.** Editing the keymap as JSON (no conflict check, easy to break); keys per
document (keys are about the person, not the design); importing another program's
keymap (out of scope, and not ours to copy).
