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
