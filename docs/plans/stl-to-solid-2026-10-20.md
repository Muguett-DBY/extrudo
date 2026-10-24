# STL → native solid: investigation (issue #95, with #78/#79)

Status: investigation, 2026-10-20. Nothing is implemented; the probe is in
`spikes/stl-to-solid/` (uncommitted). Decisions for the owner are numbered at
the end.

## The requests

- **#95 "STL to ready to edit"** (Fuwachiro, 2026-10-20): edit downloaded STLs
  without remodelling. The linked video (87 s, Fusion) shows: Insert Mesh →
  Mesh › Prepare › **Generate Face Groups** (Accurate, boundary tolerance; a
  preview colours every planar and cylindrical region) → Mesh › Modify ›
  **Convert Mesh** (Parametric, method **Prismatic**; a warning that >10,000
  triangles takes time) → the body is a solid with real faces: the top face is
  picked, a sketch drawn on it and extruded as a cut. That is exactly the
  owner's wish: a body that exists like a solid cylinder made today.
- **Reddit (That-Invite1616) = #78 Remove Faces, #79 Simplify for print.** One
  click to remove a fillet or a hole. Both are written for B-rep bodies
  (`BRepAlgoAPI_Defeaturing`). On a mesh body they can't work at all: a mesh
  has one face. So #95 is the gate for #78/#79 on STLs, and only recognised
  geometry (a cylinder face for a hole, a torus or cylinder chain for a round)
  can be defeatured; a faceted round is hundreds of small planes.

## Where we are (ADR-0066)

- A mesh file becomes a **manifold-3d body** (`MESH_HANDLE_BASE`): one face,
  no edges to pick, `EDGE_MESH` creases drawn only. Booleans, Move, Mirror,
  Scale, Split Body, patterns work; the result stays a mesh. Fillet, Chamfer,
  Shell, Hole, Rib, Place on Bed, sketch on face, Extrude to, Remove Faces,
  STEP export all refuse with `meshBodyMessage` (`Kernel.#solid`).
- ADR-0066 Deferred lists "faces of a mesh as references (planar regions), a
  mesh → B-rep conversion" and "mesh decimation". Its Context rejected turning
  100,000 triangles into 100,000 OCCT faces (booleans crawl, heap explodes).
  That is still true, measured below; the way round it is recognition, not
  triangles-as-faces.
- A STEP import is the model of what #95 wants: `evaluateImport`'s STEP branch
  gives a B-rep body with faces named `import:<feature>:face:<n>`, split by
  `splitSolids`, with no sketch and no history, and every feature works on it.

## What the pinned OCCT (8.0.1) gives us: the probe

`spikes/stl-to-solid/harness.cpp` (native build in the Docker image, `-O2`,
single thread, same as the WASM): STL round trip → `BRepBuilderAPI_MakeShapeOnMesh`
(in the image's headers; returns a **compound of faces that share their
edges**, no shell) → `BRep_Builder` shell → `BRepBuilderAPI_MakeSolid` +
`ShapeFix_Solid` → `ShapeUpgrade_UnifySameDomain` (linear 1e-3, angular 1e-3) →
`ShapeFix_Shape`; then a fillet r=1 on one edge and a Ø6 through-cut.

| Mesh | triangles | shape on mesh | solid | unify → faces | fillet | cut Ø6 through | heap |
|---|---|---|---|---|---|---|---|
| box 20×30×10 | 12 | 3 ms | 28 ms | 13 ms → **6 planes** | ok, 7 faces | 9 ms, 7 faces (6 planes + 1 cylinder), volume 5717.26 = exact-box control | 0.1 MB |
| cylinder r10 h10, deflection 0.1 | 124 | 9 ms | 65 ms | 31 ms → **34 planes** (32 facets + 2 caps) | – | 35 ms, 36 faces | 0.6 MB |
| plate with Ø8 hole, deflection 0.05 | 132 | 4 ms | 57 ms | 23 ms → 35 planes | – | 17 ms | 0.7 MB |
| sphere r10, deflection 0.01 | 10,106 | 0.3 s | 3.6 s | 1.8 s → 10,104 planes, invalid until `ShapeFix_Shape` (2.7 s) | – | 2.8 s, 9,499 faces | 80 MB |
| sphere r10, deflection 0.002 | 50,422 | 1.4 s | 21 s | not tried | – | – | – |

Facts from it:

1. **Planar geometry converts exactly and behaves natively.** A box-like STL
   becomes a valid solid with its 6 real planar faces; fillet and boolean on it
   give the same result as on an exact box. No new OCCT toolkit: `TKMesh`,
   `TKShHealing`, `TKBO`, `TKTopAlgo` are already linked (`BRepBuilderAPI_Sewing`,
   `ShapeFix_Solid`, `ShapeUpgrade_UnifySameDomain` are in the facade). WASM
   growth: one class, tens of kB at most.
2. **OCCT recognises nothing curved.** `UnifySameDomain` merges coplanar faces
   only; a meshed cylinder stays 32 facets, a hole a 32-gon. Fusion's
   "prismatic" step is its own segmentation and surface fitting; we have to
   write ours (the facade already fits B-splines with
   `GeomAPI_PointsToBSpline`; `GeomAPI_PointsToBSplineSurface`,
   `BRepLib_FindSurface`, `GeomPlate_BuildPlateSurface` and `BOPAlgo_MakerVolume`
   are in the image).
3. **Triangles-as-faces does not scale.** Cost is per face, not per triangle
   once unified: 10k faces cost ~8 s to build and **2.8 s per boolean after**,
   80 MB; 50k faces 21 s to build. A 200k-triangle organic STL (our import
   bench) is out of the question as facets; a 200k-triangle *prismatic* part
   (fine export of a bracket) is fine once its regions are recognised, because
   the result has a few dozen faces. So the size limit belongs on the **faces
   after conversion**, not the triangles.

## Design proposal

### A. New feature `meshToSolid` (Solid › Modify, "Mesh to Solid")

- **Inputs:** `body` (one mesh body; refused on a solid: "already a solid"),
  `method` choice `prismatic` (default) | `faceted`, `tolerance` (an
  `ExpressionInput`, mm, default from the mesh: median facet sagitta, shown
  as a hint), `.describe()`d for `pnpm api:generate`.
- **Output:** one B-rep body per piece (`splitSolids`), **replacing** the mesh
  body under the same `BodyId` (as Combine replaces its target), faces named
  `toSolid:<feature>:face:<n>` in the result's own face order (ADR-0005; the
  order is deterministic for the same file and tolerance, like a STEP import's
  `import:<id>:face:<n>`). Edges and vertices derived. No history into the
  mesh (it has none). Downstream references survive like STEP's: stable until
  the file or the tolerance changes.
- **Report** (`FeatureOutput.report`, shown in the dialog and the feature
  status): faces by kind (`12 planes, 4 cylinders`), triangles that no surface
  took (count and area %), time; `faceted` reports the face count and warns
  above a cap.
- **Refusals, in the house style:** "Mesh to Solid couldn't close the body:
  3 regions (12 % of the surface) fit no plane or cylinder. Raise the tolerance,
  or use Faceted." / "Faceted would give about 9,497 faces; Extrudo converts up to
  2,000. Use Prismatic, or simplify the mesh in your slicer."
- **Preview:** the dialog's live preview colours the mesh by recognised region
  kind (plane / cylinder / none) **before** the solid is built, like Fusion's
  face groups: `ModelState` gets a per-triangle region id and kind for the
  previewed body; cheap (the segmentation is linear) and it tells the user what
  the tolerance does. The solid build runs on OK.
- **Where else:** Delete-key style shortcut on a Mesh-tagged body's context
  menu ("Convert to solid…"), and later an "as solid" chip in the Import dialog
  that adds `import` + `meshToSolid` in one undo step through `commitWith`
  (the dialog framework already does that for the attachment). The feature
  stays separate so a boolean result or an OpenSCAD import can be converted
  too, and so a conversion can be suppressed to get the mesh back.
- **Export:** a converted body is a solid, so STEP export stops skipping it
  (closes ADR-0066's "STEP export of a mesh body" for the common case).
- **#78/#79 after it:** Remove Faces works on the recognised faces; a round
  shows as a cylinder (or torus, stage 3) chain, a hole as a closed cylinder
  wall: exactly what those issues pick.

### B. The kernel side, in stages

**Stage 1 — faceted (measured, small):** facade `meshToSolid(positions,
indices, method=faceted)`: arrays pushed through the existing `pushNumber`
path or a typed-array pointer (1M numbers ≈ 30 ms), `Poly_Triangulation` →
`MakeShapeOnMesh` → shell → `MakeSolid` + `ShapeFix_Solid` → `UnifySameDomain`
→ `ShapeFix_Shape` only when `BRepCheck_Analyzer` fails (the box didn't need
it, the sphere did) → the handle. Refuse above `FACETED_FACE_CAP` faces after
unify (proposal: 2,000; the 10k case above is the reason). Input comes from
manifold's `getMesh()`, already welded and oriented; its `faceID` groups
coplanar triangles for free and can seed the planes.

**Stage 2 — prismatic (the real feature):**

1. *Segment:* region growing over triangle adjacency (the `creasedEdges` map in
   `mesh-body.ts` is the same walk): planar regions where every triangle is
   within `tolerance` of the region's plane and within ~1° of its normal;
   the rest grouped by smooth adjacency (dihedral below the 30° `CREASE`).
2. *Fit:* each smooth region tried as a **cylinder**: the axis is the
   smallest-eigenvector of the facet-normal covariance (a cylinder's normals
   lie in one plane), radius and centre from a least-squares circle of the
   vertices projected along it; accept when the max vertex distance is within
   `tolerance`. Then cone (normals on a cone), sphere, torus (stage 3). A
   region that fits nothing is reported.
3. *Rebuild:* a face per surface, oversized (plane: the region's box grown by
   `tolerance`; cylinder: the full surface between the region's parameter
   bounds plus margin), then **`BOPAlgo_MakerVolume`** builds every closed
   volume the surfaces bound and we keep the volume(s) the mesh's triangle
   centroids classify inside (and whose volume is within 1 % of manifold's).
   This gives **exact** intersections (a 32-gon hole becomes a circle on the
   top face) without reconstructing wires by hand. Pairwise intersection cost
   is O(faces²), fine for a few hundred surfaces, the point of the cap.
   Fallback when a cell can't close (a round that fit nothing between two
   planes): `faceted` for the whole body with the warning, or in stage 3 a
   B-spline patch per unfit region (`GeomAPI_PointsToBSplineSurface` on the
   region's points) sewn in.
4. *Verify* before returning: `BRepCheck_Analyzer`, volume vs. manifold's,
   every triangle centroid within `tolerance` of the solid
   (`BRepExtrema_DistShapeShape` sampled); otherwise refuse with the counts.

**Stage 3 — more surfaces and UX:** torus and sphere fits (rounds), B-spline
patches for free-form regions (Fusion's "Organic" needs T-splines; not for
us), the Import dialog chip, a tooltip clip, the guide page.

### C. Rejected / alternatives

- **Faces of a mesh as references only** (ADR-0066's deferred "planar
  regions"): would allow sketch-on-face and extrude-to on meshes without any
  B-rep, but fillets, shell, holes, Remove Faces still refuse. Cheaper, but not
  what #95 asks; the preview of A reuses the same segmentation, so nothing is
  lost by going for the solid.
- **Triangles as faces without a cap** (ADR-0066's rejection, confirmed).
- **Decimate first** (`Manifold.setTolerance` / `simplify`): removes
  near-coplanar triangles only; curved surfaces keep their facets. Useful as a
  pre-step for Faceted, not a substitute for recognition.
- **Doing it in TypeScript** (own B-rep from fitted surfaces): no, the kernel
  rule is OCCT in the worker through the facade; MakerVolume does the hard part.
- **A separate "face groups" feature** (Fusion's two steps): one feature with a
  preview is simpler for the user and the timeline.

## Work split (the pipeline in CLAUDE.local.md)

| Slice | What | Worker |
|---|---|---|
| 0 | ADR (naming rules, caps, tolerance default, refusals), roadmap task, FR-IO-10 | coordinator |
| 1 | Facade `meshToSolid` faceted + native harness test (reuse `spikes/stl-to-solid`), `pnpm occt check`, CI WASM build | Opus 5.5 or DeepSeek (facade) |
| 2 | Feature `meshToSolid` (core + kernel + dialog + API + docs + e2e), faceted only, names, STEP export, Export dialog | Sonnet 5.5 / GLM |
| 3 | Prismatic: segmentation + plane/cylinder fit + MakerVolume + verification + report + refusals | Opus 5.5 |
| 4 | Region preview in the dialog, context-menu entry, cone/sphere/torus, tooltip clip, guide | Sonnet 5.5 / GLM |

Fixtures to add under `fixtures/imports/`: a box with two holes and a slot
(prismatic, from our own STL writer), a cylinder at two deflections, a
knob-like part with rounds (for the fallback path), and the sphere for the cap.

## Decisions for the owner

Decided 2026-10-20 (owner): **2.1** Solid › Modify tile "Mesh to Solid" plus
"Convert to solid…" on a Mesh body's context menu; **4.1** when prismatic
can't close the body, refuse with the counts (unfit regions stay highlighted
in the preview) and offer Faceted or a higher tolerance; **5.1** a Phase 4
task (next to P4-12, its own ID and FR-IO-10). Open:

1. **Scope of the first release:** 1.1 stages 1+2 together (faceted + prismatic,
   planes and cylinders) — recommended; 1.2 stage 1 only first (box-like parts
   convert, curved ones warn), ship, then 2.
3. **Caps:** 3.1 faceted ≤ 2,000 faces after unify, prismatic ≤ 500 recognised
   surfaces, input ≤ the existing 1,000,000 triangles — recommended; 3.2 other
   numbers.
