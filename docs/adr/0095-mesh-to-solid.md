# ADR-0095: Mesh to Solid: an imported mesh becomes a B-rep body

- **Status:** Accepted, 2026-10-20 (the owner's decisions 1.1, 2.1, 3.1, 4.1
  and 5.1 of `docs/plans/stl-to-solid-2026-10-20.md`; issue #95, with #78
  and #79 behind it). Lives on the branch
  `claude/stl-import-native-solid-e60e8c` until the whole feature lands in
  one pull request; releases go on without it meanwhile.
- **Task:** P4-13 (Phase 4), FR-IO-10.
- **Builds on:** ADR-0066 (imports, mesh bodies as manifold-3d handles),
  ADR-0034 (meshing and STEP), ADR-0005 (topological naming), ADR-0024 (the
  shape cache and scopes), ADR-0037 (the C++ facade: ints, doubles and
  pointers, never an OCCT type), ADR-0030 (`splitSolids`).

## Context

A mesh file (STL, 3MF, OBJ, an OpenSCAD compile) is one manifold-3d body with
one face: booleans and transforms work on it, everything that needs a B-rep
face or edge refuses (`Kernel.#solid`, `meshBodyMessage`): Fillet, Chamfer,
Shell, Hole, Rib, Place on Bed, sketch on face, Extrude to, Remove Faces,
STEP export. People download STLs and want to edit them like a part they
made (#95; the video shows Fusion's Face Groups + Convert Mesh), and want to
remove a hole or a round from such a part (#78, #79), which needs real faces.

Measured in the pinned image (OCCT 8.0.1, `spikes/stl-to-solid/`):
`BRepBuilderAPI_MakeShapeOnMesh` turns a welded triangulation into a compound
of faces that share their edges; a shell, `BRepBuilderAPI_MakeSolid`,
`ShapeFix_Solid` and `ShapeUpgrade_UnifySameDomain` give a valid solid whose
coplanar triangles are merged into real planar faces: a 12-triangle box STL
becomes the 6-face box, and a fillet and a through-cut on it equal the ones
on an exact box. OCCT recognises nothing curved: a meshed cylinder stays 32
facets. The cost is per face after the merge: 10,104 faces take ~8 s to
build and 2.8 s per boolean afterwards (80 MB); 50k faces 21 s. So the size
limit goes on the faces of the result, and curved parts need recognition.

## Decision

### 1. Feature `meshToSolid` ("Mesh to Solid"), Solid › Modify

| Input | Type | Default | Notes |
|---|---|---|---|
| `body` | body reference | – | One body. A solid is refused: "Mesh to Solid needs a mesh body: this body is already a solid." |
| `method` | choice `prismatic`, `faceted` | `prismatic` | §3 |
| `tolerance` | number (mm, an `ExpressionInput`) | `0.01` | How far a triangle's vertices may sit from a fitted surface (prismatic). Faceted ignores it. |

`bodyAccess: 'write'`. The output **replaces the mesh body under its own
`BodyId`** (as Combine replaces its target), so the body keeps its name, its
colour and its place in the browser; `splitSolids` runs on the result as a
guard (a mesh body is one connected piece already, ADR-0066 §3). Suppressing
the feature gives the mesh back. Not patternable (its tool is the body).

Every input gets a `.describe()` and `pnpm api:generate` runs (ADR-0068); the
feature needs no face roles (it makes no faces of its own kind: §2).

### 2. Names (ADR-0005)

The result's faces are named `toSolid:<feature>:face:<n>`, `n` the face's
position in the result shape, edges and vertices derived (`deriveNames`), as
a STEP import's `import:<feature>:face:<n>` are: deterministic for the same
mesh, method and tolerance, with no history into the mesh (it has none).
A later feature's reference to such a face survives recomputes until the
mesh, the method or the tolerance changes; then it may become a
`LostReferenceError`, which the UI shows as it does for an edited import.

### 3. The kernel: two methods, one facade entry

`Kernel.meshToSolid(shape, { method, tolerance })` → `{ shape, report }`,
B-rep handle out; a mesh handle in (anything else throws `KernelError`). The
triangles come from the body's `Manifold.getMesh()` (welded, outward), and
go into the facade through two facade-owned buffers written in place
(`meshNodes(count)`/`meshNodesPtr()` as doubles, `meshTriangles(count)`/
`meshTrianglesPtr()` as uint32; the TypeScript side writes right after
reading each pointer, since memory growth moves the heap, ADR-0037) — no
per-number embind calls for a million-triangle mesh.

**`faceted`** (slice 1): `Poly_Triangulation` → `BRepBuilderAPI_MakeShapeOnMesh`
→ one shell of all its faces (`BRep_Builder`; the faces share their edges)
→ `BRepBuilderAPI_MakeSolid` → `ShapeFix_Solid` →
`ShapeUpgrade_UnifySameDomain` (unify edges and faces, linear and angular
tolerance 1e-3, concave faces allowed) → `ShapeFix_Shape` only if
`BRepCheck_Analyzer` says invalid (the sphere needed it, the box didn't) →
`store`. Refused when the unified result has more than `FACETED_FACE_CAP`
= 2,000 faces: "Faceted would give 9,497 faces; Extrudo converts up to
2,000. Use Prismatic, or simplify the mesh in your slicer." (The count is
read after unify and before the heavy fix, so the refusal is quick.)

**`prismatic`** (slice 3): segmentation and fitting in the facade, then an
exact rebuild:

1. *Segment:* region growing over triangle adjacency. Planar regions: every
   vertex within `tolerance` of the region's plane and the normal within
   1° of it (manifold's `faceID` may seed them). The remaining triangles are
   grouped by smooth adjacency (dihedral under 30°, `CREASE` of ADR-0066).
2. *Fit* each smooth region as a cylinder: axis = the smallest-eigenvector of
   the facet normals' covariance, centre and radius by least squares on the
   vertices projected along it; accepted when every vertex is within
   `tolerance`. Then cone and sphere; torus in slice 4. A region that fits
   nothing is **unfit**.
3. *Rebuild:* one oversized face per surface (a plane's region box grown by
   10 × `tolerance`; a cylinder's full round between its parameter bounds
   plus the same margin), `BOPAlgo_MakerVolume` over all of them, and the
   volume(s) kept are those whose volume is within 1 % of manifold's and
   that contain the mesh's triangle centroids. Exact intersections fall out
   of it: a 32-gon hole is a circle on its face.
4. *Verify:* `BRepCheck_Analyzer` valid, the volume within 1 %, and sampled
   triangle centroids within `tolerance` of the solid
   (`BRepExtrema_DistShapeShape`); else refuse.

Refused when there are unfit regions (owner's 4.1): "Mesh to Solid couldn't
close the body: 3 regions (12 % of the surface) fit no plane or cylinder.
Raise the tolerance to 0.05 mm, or use Faceted." — the suggested tolerance
is the smallest that would have fit the largest unfit region, when one was
found under 10 × `tolerance`; the unfit regions stay highlighted in the
preview (§5). Refused above `PRISMATIC_SURFACE_CAP` = 500 recognised
surfaces (MakerVolume's pairwise intersections grow with the square): "This
mesh has 812 surfaces; Extrudo rebuilds up to 500. Use Faceted, or
simplify the mesh in your slicer." The input cap stays ADR-0066's
`MAX_MESH_TRIANGLES` (1,000,000); segmentation is linear in triangles.

The facade never falls back from one method to the other on its own
(owner's 4.1 against a silent faceted fallback): what the user chose is what
runs, and a refusal says what to choose instead.

#### Amendment, 2026-10-21: prismatic as built (slice 3)

Measured natively first (`bash spikes/stl-to-solid/run.sh prismatic`: the
facade itself, nodes rounded to float32 as `Kernel.meshFrom` keeps them),
then in Vitest (`packages/kernel/src/mesh-to-solid.test.ts`). What changed
from the plan above, and why:

- **Segmentation.** Planar regions grow from the largest unassigned
  triangle over shared edges; a neighbour joins when its corners are within
  `tolerance` of the *seed's* plane and its normal within 1° of the seed's
  (a sliver narrower than `tolerance` / 100 has no reliable normal, so its
  corners decide alone). The region's plane is its facets' area-weighted
  normal through their area-weighted centroid (else least squares, else the
  seed's): a least-squares plane over the nodes let a fine fillet's slivers
  tilt the plane next to it (−0.011 % volume on the fine filleted box).
  Regions whose normals are under 30° apart are *smooth* neighbours, and a
  smooth cluster of regions is fitted whole (one plane, else one cylinder).
  **The fine-tessellation rule:** when a cluster fits nothing whole, its
  regions of 4 × the cluster's median region area or more are planes of
  their own (the planes a fillet's facets lean on: 46 × on the 20 mm box
  with an 8-segment r 2 fillet), and the rest is fitted again, component by
  component. A finely tessellated cylinder's facets are thin regions of one
  size, so none is large and they stay one cylinder (360 segments, facets
  1° apart: one cylinder); a 16-gon's strips the same. A component of fewer
  than 4 regions that fits nothing is kept as planes (a draft or a shallow
  bevel, not a cylinder); a larger one is unfit.
- **Fits** as planned: the cylinder's axis is the smallest eigenvector of the
  facet normals' area-weighted covariance, the circle an algebraic fit of
  the nodes projected along it plus Gauss–Newton; accepted when every node
  is within `tolerance`. The chord error of a cylinder is
  `r (1 − cos(θ/2))`, θ its largest facet-to-facet angle.
- **Rebuild: MakerVolume, with snapping; no sewing.** Before the faces are
  made, each cylinder is snapped to its neighbouring planes: to a plane it
  is tangent to (axis parallel within 1°, distance within `tolerance` of the
  radius) its axis is made parallel and its distance exactly the radius; to
  two non-parallel tangent planes (a fillet) its axis is their offset
  planes' intersection; between two opposite tangent walls (a slot's end)
  its radius is half the gap; else to a plane it is square to (an end cap,
  a hole's plate) its axis is that plane's normal. Without the snap the
  coarse box with four r 3 vertical fillets and the plate with a slot fail
  (MakerVolume leaves the nearly tangent faces apart); with it all shapes
  measured close. The faces are grown by 10 × `tolerance` **plus twice the
  largest chord error** (a 12-gon hole's true circle leaves the polygon's
  box by its sag). `BOPAlgo_MakerVolume` runs with `SetAvoidInternalShapes`
  (a margin that bounds nothing, such as a flap past a tangent line or a
  boss's cylinder inside the plate, otherwise stays in its cell as an
  internal face). The cells kept are decided by sample points: about 3,000
  triangle centroids (plus each region's largest), each moved inside and
  outside along its normal by 3 × `tolerance` + twice its surface's chord
  error, counted for the cell that holds it; a cell keeps when more inside
  points than outside fell in it, and a cell no point reached asks the mesh
  about its centre (ray parity, three rays). The kept cells are merged by
  dropping the faces two of them share, and `ShapeUpgrade_UnifySameDomain`
  **is** needed after all: the cells split a surface where another face's
  margin crossed it (an L-bracket's faces, a boss's wall), and unify makes
  it one face again. `ShapeFix_Shape` only when the result is invalid.
- **Verification:** valid; every n-th mesh node (up to 2,000) within
  `tolerance` of the solid (projected on each nearby face's plane or
  cylinder and classified in the face, `BRepExtrema_DistShapeShape` for a
  node no face takes); and **the volume rule**: |V − V_mesh| at most the
  larger of 1 % of the mesh's volume and Σ (area × chord error) over the
  cylinders + `tolerance` × the mesh's area (a 16-gon cylinder is 2.5 %
  under its circle: 1 % alone refuses it).
- **The report** on success counts the result's faces by kind (planes,
  cylinders); on a refusal after segmentation it holds the recognised counts
  and the unfit regions, triangles and area fraction (0–1), for slice 4's
  preview; the kernel reads it on success only for now.
- The suggested tolerance is the largest unfit region's best plane or
  cylinder deviation × 1.1, rounded up to 0.001 mm, when under 10 ×
  `tolerance`.

Measured, native (ms in the pinned image under node). In Vitest (CI's
WASM, this machine) the 20,124-triangle plate converts in 248 ms, the
500,000-triangle manifold sphere is refused in 306 ms and the staircase in
1 ms (case 11 and 8 print them); every case of the matrix passes:

| Mesh | Triangles | Result | ms |
|---|---|---|---|
| `cube.stl` | 12 | 6 planes, 8,000 mm³ exact | 141 |
| cylinder r 5 h 20, 32 / 360 / 16 segments | 124 / 1,436 / 60 | 2 planes + cylinder r 5 (±1e-8), volume ±2e-7 % | 49 / 90 / 13 |
| plate 40 × 30 × 5, hole r 3, fine / ~5k | 1,024 / 5,044 | 6 planes + 1 cylinder, ±2e-8 %; r 1 fillet on the hole's circle valid | 146 / 341 |
| box 20³, edge filleted r 2, fine / 8 segments | 264 / 76 | 6 planes + cylinder r 2, −3e-4 % / −5e-9 % | 53 / 36 |
| sphere r 10 / 499k triangles | 2,208 / 499,000 | refused, 1 region (100 %) | 2 / 292 |
| staircase, 602 faces | 2,396 | refused, 602 surfaces | 1 |
| 32-gon, nodes ±0.005 mm, tolerance 0.001 / 0.02 | 124 | refused, "Raise the tolerance to 0.006 mm" / 2 planes + cylinder | 0.1 / 8 |
| L-bracket | 20 | 8 planes, exact | 16 |
| box, 4 vertical edges r 3, fine / 8 segments | 1,020 / 268 | 6 planes + 4 cylinders, ±3e-5 % | 279 / 102 |
| box, 4 top edges r 2 (spherical corners) | 196 | refused, 1 region (11 %): the corners are slice 4's | 0.2 |
| plate, 12-gon hole / slot / boss | 116 / 528 / 516 | 7 / 10 / 8 faces, ±3e-7 % | 21 / 280 / 33 |
| tube r 10 / r 6 | 1,008 | 2 planes + 2 cylinders | 48 |

### 4. The report

`FeatureOutput.report` of kind `meshToSolid`: `{ method, faces, planes,
cylinders, cones, spheres, tori, unfit: { regions, triangles, fraction },
suggestedTolerance? }`, read from the facade's `meshReportPtr()` (doubles).
The dialog shows it as one line ("12 planes, 4 cylinders · 0 unfit") and the
feature status keeps it; the MCP `get_feature` tool returns it unchanged.

### 5. Preview (slice 4)

While the dialog is open, the view colours the picked mesh body by region
kind before any solid is built: plane, cylinder/cone/sphere/torus, unfit.
The kernel's preview path runs the segmentation only
(`Kernel.meshRegions(shape, tolerance)` → one region id per triangle and a
kind per region, in `ModelState.regions` for that body), which is linear and
fast on a million triangles; OK runs the build. The colours come from the
brand tokens (`docs/05-brand.md`), with a legend line in the dialog.

#### Amendment, 2026-10-22: preview and report as built (slice 4b)

- **One segmentation, two callers.** The facade's `segmentMesh(tolerance,
  MeshSegmentation&)` (private) holds what `prismaticFromMesh` did up to its
  refusals: the checks (tolerance, empty mesh, a node index out of range),
  normals, adjacency, planar regions, smooth clusters, `fitComponent`, the
  fine-tessellation rule, the report counts and the suggested tolerance.
  `prismaticFromMesh` runs it and then refuses or rebuilds as before (the
  same messages and counts: the slice-3 matrix prints the same natively);
  the new public `meshRegions(tolerance)` runs it and stops. It fills
  `meshReport_` as a refusal would (faces 0), a surface index per triangle
  (`meshRegionsPtr()`, int32, `meshRegionTriangles()` long, in the staged
  triangle order) and a kind per surface (`meshRegionKindsPtr()`, int32,
  `meshRegionCount()` long: 0 plane, 1 cylinder, 2–4 reserved for cone,
  sphere and torus, −1 unfit; core's `MESH_REGION_KIND`), and frees the input
  buffers. The region buffers live until `clearMeshRegions()` (the kernel
  calls it after copying), the next `meshNodes` or the next `meshRegions`.
- **Per-triangle mapping.** `Kernel.meshRegions(shape, tolerance)` stages the
  body's `Manifold.getMesh()` exactly as `meshToSolid` does (one
  `#stageMesh`), and the view's `BodyMesh` of a mesh body is built from the
  same `getMesh()` triangle order (`displayMesh` keeps it), so
  `surfaceOf[t]` is triangle `t` of `BodyMesh.indices` / 3. `MeshRegions` =
  `{ surfaceOf: Int32Array, kinds: Int32Array }` plus the report's counts
  (`planes`, `cylinders`, `cones`, `spheres`, `tori`, `unfit`,
  `suggestedTolerance?`). Through the worker: `KernelApi.meshRegions(body,
  tolerance, base?)` (the body as the last recompute has it, or with `base`
  the last preview's base: editing the feature that replaced the mesh),
  transferring the two arrays, and `Recomputer.meshRegions`, `undefined` on
  any error (a solid, a bad tolerance, a body that is gone).
- **The preview decision: the draft still evaluates, the view shows the
  regions.** Measured (native harness, case `r`; and Vitest on CI's WASM):

  | Mesh | Triangles | `meshRegions` | full conversion |
  |---|---|---|---|
  | `cube.stl` | 12 | 0.03 ms | 93 ms |
  | plate with a hole | 5,044 | 1.8–4.3 ms | 346–422 ms |
  | sphere (refused) | 499,000 | 278–330 ms | 274–289 ms (refused after the same segmentation) |
  | staircase, 302 planes | 1,196 | 0.46 ms | 3,080 ms |

  In Vitest (CI's WASM, the Ubuntu machine; `describe('Kernel.meshRegions')`
  prints them): the 500,000-triangle manifold sphere segments in 274 ms
  (refused by the conversion in 293 ms), the 20,124-triangle plate in 7 ms
  (converted in 236 ms), the 302-surface staircase in 1 ms (converted in
  2,774 ms). The unfit fraction is clamped to 1 in the kernel (the area sums
  round a whole sphere to 1.0000000000000027).

  A refused mesh costs the segmentation either way, but a part that
  converts costs seconds per draft as its surfaces grow (MakerVolume's
  pairwise intersections: 3.1 s at 302 surfaces). Skipping the draft's
  evaluation for prismatic would leave the dialog without its status (OK
  enabled on a mesh that fails to rebuild, the refusal only after OK), and
  editing without its base (the mesh is only in the preview's base once the
  feature replaced it). So the draft is still previewed as for every
  feature, which gives the status, the OK button, the base and the report;
  but while the method is prismatic the view draws **the regions in place
  of the drawing and of the body's own faces**, from the first answer
  (milliseconds) to the end, and never the solid: the colours say more than
  a solid drawn like the mesh. The region request goes out before the
  preview, so the worker answers it first. Faceted draws its solid as before.
- **The dialog hook.** `FeatureDialogSpec.regions?(values, ctx) →
  { body, tolerance } | undefined`; the controller (`syncRegions` in
  `dialog.ts`) asks `DialogKernel.meshRegions` (optional, like
  `tangentChain`) when the request or the body's mesh changed, debounced
  with the spec's `previewDelay`, drops late answers by generation and a
  sequence, keeps the answer in `DialogPreview.regions` /
  `DialogContext.draftRegions` (kept while a request for the same body is
  out; a half-typed value leaves them), clears them when the hook gives
  undefined (faceted, no body) or the dialog closes, and in edit mode waits
  for the first preview's base. Nothing in `dialog.ts` names Mesh to Solid.
- **The dialog.** An info field `summary` ("Result"): the regions'
  counts while prismatic, else the draft's report (`Preview.meshToSolid`,
  `DialogPreview.meshToSolid`, `DialogContext.draftMeshToSolid`, the `thread`
  pattern): "6 planes, 1 cylinder · 0 unfit" (kinds with a count, unfit
  always; core's `meshSurfaceSummary` / `meshToSolidSummary`), "6 faces" for
  faceted. Its legend is real swatches: `InfoField.legend?(values, ctx)` →
  `{ tone: 'create' | 'sketch' | 'error', label }[]`, rendered under the line
  by `FeatureDialog.tsx` from the same tokens the view reads ("Planes",
  "Cylinders", "Fits nothing"); the hint (the label's tooltip) says what to do
  about a red region. The dialog region carries `data-regions="6 planes,
  0 cylinders, 0 unfit"` and the viewport `data-preview-regions="<body>"`.
- **The view.** `ViewPreview.regions` (`{ body, surfaceOf, kinds }`, filled
  by `previewOf`; `previewInputs` makes an empty drawing so the regions show
  while the draft is refused) goes from `Viewport.tsx` to `Bodies` and the
  `Body` it names. `regionGeometry` (`viewport/regionGeometry.ts`, unit
  tested) builds a de-indexed copy of the body's positions and normals with a
  colour per corner (nodes are shared between triangles of different
  surfaces), memoised on (mesh, regions, colours) and built only while
  regions exist; `Body` draws it with its pose and clipping planes **in place
  of** its faces mesh (picking reads the `BodyMesh`, not the scene, so it is
  unchanged). Colours: planes `--x-cat-create`, cylinders and every curved
  kind `--x-cat-sketch`, unfit `--x-error` (`SceneColors.regionPlane`,
  `regionCurved`, `regionUnfit`), so both themes follow. Regions for another
  triangle count draw nothing.
- **Status and MCP.** The recompute attaches each Mesh to Solid report,
  without its `kind`, to its feature's status (`FeatureStatus.meshToSolid`,
  core's `MeshToSolidReport`, which the kernel's type re-exports);
  `sameStatuses` compares it. The timeline chip's tooltip adds the summary
  ("Mesh to Solid · 6 planes · 0 unfit"), and `get_feature` returns
  `meshToSolid` as the status has it. A refused conversion has no report on
  its status (the error says it); the dialog's regions carry the counts.

### 6. Where it is

A tile "Mesh to Solid" at the end of Solid › Modify (with a tooltip clip,
`pnpm demos`, ADR-0052), a "Convert to solid…" entry in the context menu of
a body the browser tags "Mesh" (`data-body-mesh`), and the command in the
palette. Later, not now: an "as solid" chip in the Import dialog that adds
`import` and `meshToSolid` in one undo step through the dialog framework's
`commitWith`.

### 7. After it

A converted body is a solid, so every feature works on it and the Export
dialog's STEP export includes it (its skip is keyed on `BodyMesh.mesh`).
Remove Faces (#78) and Simplify for print (#79) find a hole as a closed
cylinder wall and a round as a cylinder or torus chain on it.

## Rejected

- **Faces of a mesh as references only** (ADR-0066's deferred "planar
  regions"): sketch-on-face without a solid; fillets, shell, holes, Remove
  Faces still refuse. The preview of §5 reuses that segmentation anyway.
- **Triangles as faces with no cap**: ADR-0066's rejection, measured again.
- **Decimating first** (`Manifold.setTolerance`): removes near-coplanar
  triangles only; curved surfaces keep their facets.
- **Converting inside `import`** (an `as` input): one timeline step, but a
  boolean's or OpenSCAD's mesh couldn't be converted and nothing could be
  suppressed to get the mesh back. The Import-dialog chip of §6 gives the
  one-step feel later.
- **Two features, "face groups" then "convert"** (Fusion's split): one
  feature with a preview is one thing to learn and one timeline step.
- **A silent fallback to faceted** when prismatic fails (owner's 4.2): the
  body appears but with thousands of faces, every later cut takes seconds,
  Remove Faces finds no hole, and nothing says why.

## Consequences

- A new feature type in the document schema: `docs/file-format.md` gets its
  section (`meshToSolid`: `body`, `method`, `tolerance`), the schema test
  enforces it.
- Facade growth: `BRepBuilderAPI_MakeShapeOnMesh`, `BOPAlgo_MakerVolume`
  (TKBO, already linked), the fitting code; tens of kB of WASM.
- The 1,000,000-triangle cap holds; the new caps (2,000 faces, 500
  surfaces) are constants in `packages/kernel/src/features/mesh-to-solid.ts`
  and `extrudo_facade.cpp`, named in the refusal messages.
- A long-lived branch: it is synced with main as releases go out, and its
  ADR number is re-checked against main at pull-request time.

## Slices

1. Facade `faceted` + `Kernel.meshToSolid` + Vitest on `cube.stl` and a
   cylinder STL (planes and faces counted, fillet and cut on the result).
2. Feature, dialog, context menu, API, file format, docs, e2e (faceted).
3. Facade `prismatic`: segmentation, fits, MakerVolume, verification, report,
   refusals; Vitest with a bracket fixture.
4. Region preview, cone/sphere/torus, tooltip clip, guide page, Import chip.
