# ADR-0097: Mesh to Solid: an imported mesh becomes a B-rep body

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
`store`. Refused when the estimated result has more than `FACETED_FACE_CAP`
= 2,000 faces: "Faceted would give about 9,497 faces; Extrudo converts up to
2,000. Use Prismatic, or simplify the mesh in your slicer." The count is
estimated from the triangle buffers **before** anything is built (2026-10-22
amendment); the exact count after unify stays a backstop, and its message has
no "about".

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
| sphere r 10 / 499k triangles | 2,208 / 499,000 | 1 sphere face (slice 4a1: was refused) | 103 / 731 |
| staircase, 602 faces | 2,396 | refused, 602 surfaces | 1 |
| 32-gon, nodes ±0.005 mm, tolerance 0.001 / 0.02 | 124 | refused, "Raise the tolerance to 0.003 mm" (slice 4a1: was 0.006) / 2 planes + cylinder | 0.1 / 8 |
| L-bracket | 20 | 8 planes, exact | 16 |
| box, 4 vertical edges r 3, fine / 8 segments | 1,020 / 268 | 6 planes + 4 cylinders, ±3e-5 % | 279 / 102 |
| box, 4 top edges r 2 | 196 | refused, 1 region (11 %): one smooth cluster of four cylinders (slice 4a2: converts, 6 planes + 4 cylinders, +7e-7 %; OCCT mitres the corners, no sphere) | 0.2 |
| plate, 12-gon hole / slot / boss | 116 / 528 / 516 | 7 / 10 / 8 faces, ±3e-7 % | 21 / 280 / 33 |
| tube r 10 / r 6 | 1,008 | 2 planes + 2 cylinders | 48 |

#### Amendment, 2026-10-21: spheres and cones (slice 4a1)

The two remaining primitives (tori and splitting a smooth cluster into
several primitives are the next slice), measured natively
(`bash spikes/stl-to-solid/run.sh prismatic c`) and in Vitest.

- **Fits** (`fitMeshSphere` / `fitMeshCone`, after plane and cylinder). A
  **sphere**: the centre an algebraic fit (the linear system `2 Σ q qᵀ c' =
  Σ q |q|²` over the centroid `m`, `c = m + c'`) refined by Gauss–Newton on
  the residual `|p − c| − r` (three unknowns, `solve3`), the radius the mean
  distance; refused when the nodes are nearly coplanar (the covariance's
  smallest eigenvalue under 1e-6 × its largest). A **cone**: the axis the
  facet normals' area-weighted covariance's smallest eigenvector (refused
  when `values[1] ≤ 1e-6 × trace`, as for the cylinder), the half-angle
  `asin|mean(n·a)|` (refused outside 1°–89°), the apex the facet tangent
  planes' least-squares meeting point (`Σ a_t n_t n_tᵀ x = Σ a_t n_t (n_t ·
  centroid_t)`), the half-angle then the nodes' mean `atan2(ρ_i, h_i)`, and
  the deviation `max |ρ_i cos α − h_i sin α|` (the distance from the
  generating line in the meridian plane). `origin` is the apex, `direction`
  points from it to the nodes, `semiAngle` is α. The order is **plane →
  cylinder → cone → sphere**: a frustum meshed with only its two end rings
  (manifold's `cylinder`) has all its nodes on a sphere too — measured, a
  r 10 → 4, h 20 cone's rings lie on a r 12.74 sphere — so the facet normals
  are the only thing that tells them apart, and the cone must come first
  (a full sphere's cone fit is refused: its normals' mean along the axis is
  zero, α < 1°). An unfit region takes the min deviation of the fits that
  were ok, so the cone and sphere fits can lower a suggested tolerance (the
  noisy 32-gon's falls from 0.006 to 0.003: a sphere also nearly fits its two
  rings). The chord error is the brief's: sphere `r (1 − cos(θ/2))`, cone
  `(ρmax / cos α)(1 − cos(θ/2))`, θ the largest facet-to-facet angle
  (`largestAngle`, shared with the cylinder).
- **Three changes the brief's rules needed, and why.** (1) *A pointed cone.*
  The facet tangent planes' least-squares apex sits a chord error **behind**
  the mesh tip (19.9897 for an apex at 20), so `min h < −1e-6 × max h`
  refused the whole cone. The fit refuses only a genuine double cone (`min h
  < −0.5 × max h`, nodes on both sides in comparable amount) and takes the
  half-angle over the nodes **in front of** the apex (the tip's `atan2(0, 0)`
  otherwise drags it); the cone then fits and the refusal moves to the
  rebuild — `MakerVolume` can't use the cone face's singular apex (`v1 = 0`)
  — so the user gets the usual *rebuild* message, no crash, no invalid
  solid. (2) *A dome.* A cylinder fused with a hemisphere is one smooth
  cluster whose cylinder facets are coarser (larger) than the sphere's; the
  slice-3 peel rule took each large region as a plane and gave 64 planes + a
  sphere. The peel now groups the peeled regions into smooth components too
  (`components(large)`) and fits each, which gives the cylinder back; a plain
  sphere has no such split and is one sphere face. (3) *The volume
  allowance.* `max(1 %, Σ area × sag + tolerance × area)` was 0.5 % short for
  manifold's 48-meridian sphere: its inscribed polyhedron is 41.9 mm³ under
  the true 4188.8 (1.0 %), while the sagitta sum is 28.9 and the 1 % floor
  41.5. The sagitta sum is doubled (`2 × Σ area × sag`), still tight (a
  fine mesh's sag → 0) but covering the measured deficit.
- **Snaps.** After the cylinders' snap loop, a **sphere** next to cylinders
  it shares its radius with (a dome) takes their mean radius and the point
  nearest their axes (normal equations `Σ (I − a_k a_kᵀ) c = Σ (I − a_k a_kᵀ)
  o_k`, `solve3`; with one cylinder, the centre projected onto its axis); a
  **cone** next to a cylinder within 1° (`|a · a_cyl| > cos 1°`) takes that
  cylinder's axis line (apex projected onto it), else next to a plane it is
  square to (`|a · n| > cos 1°`), that plane's normal. The dome's sphere
  radius equals the cylinder's to 1e-11 and sits on its axis (x, y ≈ 1e-16);
  the countersink's cone axis is the through hole's.
- **Faces and verification.** A cone is `gp_Cone(gp_Ax3(apex, a), α, 0)`
  between `v1 = max(0, min h_i / cos α − margin)` and `v2 = max h_i / cos α +
  margin` (v the distance along a generatrix from the apex); a sphere the
  full `gp_Sphere(gp_Ax3(centre, mean outward normal), r)`. The frame's **Z
  along the mean outward normal worked** for the dome — the brief's
  perpendicular fallback wasn't needed (a full sphere is rotation-invariant;
  the frame only moves its poles and seam); for a full sphere the mean normal
  cancels to ~0, so the frame falls back to world Z. Verification reads
  `GeomAbs_Cone`/`GeomAbs_Sphere` and projects nodes with
  `ElSLib::Parameters`/`Value` as for planes and cylinders; cones and spheres
  count into the report's slots 3 and 4, and the surface cap covers all four
  kinds.

Measured, native (ms under node; the same matrix passes in Vitest):

| Mesh | Triangles | Result | ms |
|---|---|---|---|
| sphere r 10 (UV) | 2,208 | 1 sphere face, r 10 (±2e-8), ±7e-7 % | 103 |
| dome (cylinder + hemisphere), fine / coarse | 5,472 / 254 | 1 plane + 1 cylinder + 1 sphere, sphere r = cylinder r (±1e-11), ±3e-6 % | 435 / 25 |
| truncated cone r 10 → 4, h 20 | 1,600 | 2 planes + 1 cone, half-angle 16.716° (atan(6/20) is 16.699°), +0.025 % | 81 |
| countersunk plate (box, hole r 3, sink r 6 → 3) | 754 | 6 planes + 1 cylinder + 1 cone, −7e-4 % | 120 |
| pointed cone r 10, h 20 | 1,476 | refused at the rebuild (MakerVolume can't do the OCCT cone's singular apex; manifold's mesh of the same cone converts to a plane + a cone; slice 4a2: converts, 1 plane + 1 cone, +2e-6 %) | 61 |
| ellipsoid (sphere × 0.6 in z) | 2,208 | refused, 1 region (100 %) | 1 |

The plain sphere and the 499k-triangle sphere, refused in slice 3's table,
now convert to one sphere face (the table above notes the change).

#### Amendment, 2026-10-21: tori and split clusters (slice 4a2)

The last primitive and the split of a smooth cluster that fits nothing
whole, measured natively (`bash spikes/stl-to-solid/run.sh prismatic t`, then
the full matrix) and in Vitest.

- **The torus fit** (`fitMeshTorus`, kind 4, after the sphere: the order is
  plane → cylinder → cone → sphere → torus). Every normal line of a torus
  meets its spine circle, so for the signed tube radius ρ the points
  `centroid_t − ρ n_t` lie on one circle and are coplanar (ρ > 0 when the
  normals point away from the spine: a donut, a fillet on an outside edge
  or on a hole's edge; ρ < 0 on the concave side). ρ minimises `f(ρ)`, the
  smallest eigenvalue over the trace of those points' area-weighted
  covariance (`Sgg − ρ (Sgn + Sng) + ρ² Snn` from moments taken once, so
  each `f` is a 3 × 3 eigenproblem), over `±[tolerance, D]` (D the bounding
  box diagonal): 32 geometric samples a side, golden section between the
  best one's neighbours (40 iterations), refused above 1e-3. The axis is that
  covariance's smallest eigenvector; the spine an area-weighted algebraic
  (Kåsa) circle fit in its plane (`solve3`); the tube radius the nodes' mean
  distance from the spine; then Gauss–Newton on all seven parameters (centre,
  two tilts of the axis, R, r) over `sqrt((ρ_i − R)² + h_i²) − r`, a
  central-difference Jacobian, `solveN` (Gaussian elimination, partial
  pivoting, n ≤ 8), up to 12 iterations, the step halved while the residual
  sum grows. The axis is oriented with its largest component positive. The
  chord error is `(R + r)(1 − cos(θ/2))`. The donut R 10 r 3 fits to 1e-8
  fine and coarse.
- **The split** (`splitComponent`). `settle` sends an unfit result of 4 or
  more regions to it; each piece it returns is settled by the old rule (unfit
  under 4 regions → planes). Seeds go by area, largest first. **A large seed
  (4 × the component's median region area) is a plane** at once (the flat
  face between fillets); else its **patch** adds the unassigned smooth
  neighbour sharing the **longest border** with it (region border lengths are
  kept beside `regionNeighbours`), one at a time, until it has 16 nodes, and
  `bestFit` (the five fits in order, factored out of `fitComponent`) tries
  it, dropping the last region added while 16 nodes are left; a seed whose
  patch fits nothing is skipped and may join a later piece. A piece grows in
  rounds: every frontier region whose every node is within the tolerance of
  the surface (`distanceToSurface`) joins, the same kind is refitted over the
  piece (`fitOfKind`), and a refit outside the tolerance undoes the round.
  Then a region on a border goes to the neighbouring piece whose surface is
  nearer its nodes, and the pieces that changed are refitted. What no piece
  took becomes unfit pieces, one per smooth component — and **when one of
  them has 4 regions or more, the split is dropped and the component stays
  one unfit region**: a freeform surface fits small primitives here and there.
  The first version (no such rule, no 16-node floor) split the ellipsoid into
  299 pieces (256 cylinders, 37 spheres, 6 planes) and the rebuild took 273 s
  to refuse; now the ellipsoid is refused in 42 ms as 1 region (100 %), as
  before.
- **What changed from the brief, and why.** (1) *Patches by border, not by
  breadth-first layers, and no prefix under 16 nodes.* A fillet strip's
  first layer holds the corner sphere's facets at its two ends, so every layer
  mixed two kinds and fell back to the seed alone; and a patch of two strips
  fits a cylinder exactly (six nodes), so with prefixes under 16 nodes a big
  plane plus one strip "fitted" a cylinder (the twelve-fillet box came out
  with no plane at all). (2) *A large seed is a plane* at once, instead of
  `planeOf` after a failed patch (the same 4 × median rule as the peel): a
  16-node patch of the box's top face and its first strips still fitted a
  sphere of r 72. (3) *A plane's fit is the
  largest region's own plane* when it holds every node, else the facets'
  area-weighted plane, else least squares: a disc whose edge took a fillet's
  near-tangent facets tilted by 6e-5 rad under least squares, and the torus
  next to it no longer touched it (MakerVolume kept no cell). (4) *Own-node
  refits*: after the clusters, each curved surface is refitted (up to 4
  passes) without the nodes that are off it by more than twice its median node
  and much nearer a neighbouring surface: a fillet strip's planar region can
  carry the end of a corner sphere's facets (within 1° and the tolerance),
  and those few nodes put the box's cylinders at r 2.00055, off their axes by
  1e-3; after the passes r is 2 to 1e-6. (5) *One rolling radius*: in the
  rebuild, adjacent cylinders, spheres and tori whose radii (a torus's tube)
  agree within the tolerance take their area-weighted mean, before the snaps,
  so fillets meeting at a corner are exactly tangent. (6) *Trimmed curved
  faces*: a cylinder's u, a sphere's latitude and longitude (its frame's Z is
  the mean outward normal) and a torus's tube angle v cover the nodes' range
  past their largest gap, grown by the margin; the full turn when that gap is
  under twice the margin **plus twice the facet angle** (the brief's
  `2 margin / r` alone left the donut's tube an open band, fine and coarse:
  MakerVolume failed). With full spheres and full cylinders the twelve-fillet
  box gave 53 cells and a unified result of 58 faces, or an invalid one once
  its radii were exact; trimmed, 1 cell and 26 faces. (7) The verification
  moves a curved face's u (and a torus's v) by whole turns into the face's
  own range before classifying a node in it (`ElSLib` gives [0, 2π); a node
  the face misses falls back to `BRepExtrema`, slow), and the cell
  classification tries the last cell hit first.
- **Snaps** (after the sphere and cone snaps). A torus next to a cylinder
  within 1° takes the cylinder's axis line (centre projected onto it) and, when
  `|R + r − r_cyl|` or `|R − r − r_cyl|` is within 10 × the tolerance,
  `R = r_cyl − r` (a cylinder's end) or `R = r_cyl + r` (a hole's edge); else
  next to a plane it is square to, `±n`. Either way a plane square to it whose
  distance from the spine plane is within 10 × the tolerance of r moves the
  centre along the axis to make it exactly r (the brief gated nothing; an
  ungated move would drag a torus onto a plane it only crosses).
- **The face and the report.** `gp_Torus(gp_Ax3(centre, axis), R, r)`, u the
  full turn, v as above; the verification reads `GeomAbs_Torus` (kind 4,
  `ElSLib` on `gp_Torus`); tori count into the report's slot 5 and the
  surface cap; the unfit message says "fits no plane, cylinder, sphere, cone
  or torus".

Measured, native (ms under node, this machine):

| Mesh | Triangles | Result | ms |
|---|---|---|---|
| donut R 10 r 3, fine / coarse | 14,364 / 1,352 | 1 torus face, R and r ±1e-8, −6e-7 % / +4e-7 % | 381 / 66 |
| box 40 × 30 × 10, 4 top edges r 2 | 196 | 6 planes + 4 cylinders (OCCT mitres the corners: no sphere), +7e-7 % | 113 |
| cylinder r 5 h 20, top edge r 2 | 3,436 | 2 planes + 1 cylinder + 1 torus R 3 r 2 on the axis, +3e-7 % | 246 |
| plate, hole r 3, top edge r 1 | 2,284 | 6 planes + 1 cylinder + 1 torus R 4 r 1 on the hole's axis, −8e-8 % | 236 |
| box 20³, all 12 edges r 2 | 2,796 | 6 planes + 12 cylinders + 8 spheres (26 faces), −9e-7 % | 1,490 |
| ellipsoid (sphere × 0.6 in z) | 2,208 | refused, 1 region (100 %) | 45 |

The full matrix keeps every result but three rows, all for the better: the
box with four top fillets (slice 3's table) converts; the OCCT pointed cone
(slice 4a1's table) converts to 1 plane + 1 cone, +2e-6 %; the truncated cone
fits 16.69995° (atan(6/20) is 16.6992°; was 16.716°), +0.0014 % (was
+0.025 %). Refusals cost the split's attempts: the noisy 32-gon at 0.001 mm
21 ms (was 0.1), the ellipsoid 42 ms (was 1.3).

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

#### Amendment, 2026-10-21: preview and report as built (slice 4b)

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

#### Amendment, 2026-10-22: hardening slice A (memory safety, rebuild budget, rebuilds that failed)

The owner ran the kernel over 41 real STLs on 2026-10-21 (36 import as closed
bodies; prismatic converted 6 at 0.01 mm). Three problems are fixed here;
measured with the harness's new `f`/`F` cases (`spikes/stl-to-solid/README.md`)
and `packages/kernel/src/mesh-to-solid-files.test.ts`.

- **The trap.** `splitComponent` moves border regions to the nearer piece,
  then refitted only the pieces whose region count had changed. A piece can
  lose one region and gain another and keep its count: its region list then
  still named the region it lost (now on two surfaces) and missed the one it
  gained (on none). `rebuildPrismatic` indexed `adjacent[surfaceOf[r]]` with
  -1, a read 12 bytes before the vector of vectors (AddressSanitizer, `SAN=1`);
  in the app's O3 build that read garbage pointers and trapped with `memory
  access out of bounds` or `unreachable`, or corrupted the heap for every
  later call (`table index is out of bounds`, garbage error text). The
  harness's O2 build read the garbage without trapping, so the bug was
  reproduced through the kernel and the harness fed the kernel's mesh order
  (`MESH_OUT`). Over the test files, 1 to 59 regions per file were lost at
  0.01 to 0.2 mm (desk-organizer, puzzle-insert-circle, hot-wheels-connector,
  micro-sd-keyring-inner, vented-funnel, trashcan-spacer at 0.1 and 0.2 …).
  **Fix:** a piece that lost or gained any region is refitted (or keeps its
  surface with its new region list). **Guard:** the rebuild refuses
  ("couldn't rebuild … within") when a region is on no surface, instead of
  indexing with -1. The fixture test checks that `meshRegions` maps every
  triangle of trashcan-spacer at 0.1 and 0.2 mm (it mapped 1 and 9 to -1).
- **The budget.** The rebuild (everything after `segmentMesh`) gets
  `PRISMATIC_REBUILD_BUDGET_MS = 30000` of wall-clock time: a
  `Message_ProgressIndicator` (`MeshDeadline`, `UserBreak()` past the
  deadline) is passed as a `Message_ProgressRange` into
  `BOPAlgo_MakerVolume::Perform`, `ShapeFix_Solid`/`ShapeFix_Shape::Perform`
  and `BRepExtrema_DistShapeShape`, and the rebuild checks the deadline
  between its own loops (cells, nodes). Past it, `meshToSolid` refuses with
  "Mesh to Solid gave up after 30 s: this mesh has too many surfaces to
  rebuild exactly. Use Faceted, or simplify the mesh in your slicer." The
  report is filled before, as for every refusal. `prismaticBudgetMs_` lowers
  it for the harness only (`BUDGET`).
- **Why it was slow, and two fixes.** Stage times (`TIMES=1`) showed the
  cell classification as often the larger half: every sample point was
  classified against every cell whose box held it, and a torus's or
  sphere's cell is slow to classify. A cell whose votes agree (16 or more,
  90 % one way) is now **decided** and later samples skip it.
  numbers-base-top (471 planes) at 0.01 mm: classification 12.4 s → 0.2 s,
  the whole rebuild 16.5 s → 1.6–2.7 s on the Ubuntu machine (10 s on the
  owner's laptop before). **The faces' extent changed slightly:** a face's
  margin is 10 × tolerance + twice the largest chord error of *it and its
  neighbours*, no longer of the whole mesh (one coarse torus grew every
  face, so MakerVolume intersected more pairs). desk-organizer at 0.01 mm
  (374 surfaces, 389 cells): MakerVolume 20 s, classification 19 s, unify
  3 s, then "invalid after healing" at 44 s with no budget; with it, a
  refusal after 30 s. The rebuild of the slice-3/4 matrix (`run.sh
  prismatic`, all cases) gives the same faces, kinds, validity and volumes
  as before, mostly faster (sphere r10 156 → 16 ms, all-edges-filleted box
  1.45 → 0.43 s, 302-surface staircase 3.7 → 2.5 s).
- **Rebuilds that failed although every region fit**, by the check that
  refused (now named by `TIMES=1`):
  - *hole-filler-35mm*, a node 0.053 mm off the solid: the torus snap
    (within 10 × tolerance of tangent to a cylinder) moved R by 0.054 mm,
    but the torus meets that cylinder at a crease. **A snap only takes when
    the surface still holds its own nodes within the tolerance**; else the
    surface keeps its fit.
  - *trashcan-repair-foot*, MakerVolume made no cell: one r 9.80 cylinder
    came out as four surfaces (between chamfer facets), the snaps moved two
    of them 0.008 mm apart, and near-coincident cylinders leave no closed
    cell. **Surfaces that are one surface are merged** before the snaps: a
    surface joins a larger one of its kind with a parallel normal or axis
    (and a radius within the tolerance) when every node of it is within
    the tolerance of that one, or of one fit over both (free, or about
    either piece's axis).
  - *wyze-garage-bracket* (volume 451 against 7,873 mm³: cells missing) and
    *micro-sd-keyring-inner* (volume 7 against 945 mm³) still fail at
    0.01 mm. wyze: a cylinder tangent to one plane kept its fit's tilted
    axis although a square end plane was there; the single-tangent snap now
    takes that plane's normal as the axis, which keeps 1,532 mm³ instead of
    451 but doesn't close the body (MakerVolume warns `NotSplittableEdge` and
    `FaceBuilderUnusedEdges` on the nearly tangent top plane). micro-sd: the
    segmentation fits two slot ends (two r 0.6 arcs joined by a 0.15 mm
    flat) with a sphere r 1.385 whose nodes are only the end rings, and an
    r 0.853 cylinder over flat and arc ends; slice C's.
  - Tried and **rejected**: a cylinder–cylinder tangency snap (a fillet
    tangent to a larger parallel cylinder, moved along its tangent plane):
    it broke micro-sd-keyring-outer at 0.01 mm (41 faces, volume 1.0000 →
    29 faces, 1.0066) and drill-block at 0.05 mm (converted → refused) and
    fixed none of these files; a refit of a snapped cylinder's circle about
    its new axis (no measurable change); a check that a curved fit holds the
    facet centroids within the tolerance plus twice the chord error (it
    tells a two-ring cylinder from a sphere, but refused manifold's
    geodesic sphere, whose triangles sit deeper than twice the edge-based
    chord error).
  - The chord-error case (a 0.01 mm check on a coarser mesh) didn't occur
    among these files: every refusal that remains fails a cell or validity
    check, not the node distances.

The ten files whose rebuild failed with every region fitting, and
drill-block (the reverse case), before (head 4188a505, the owner's runs)
and after (this amendment, the kernel over `STL_DIR`):

Prismatic, kernel over the files (Ubuntu machine, others' jobs running);
"rebuild" is "couldn't rebuild … within", "trap" a WASM trap or the heap
it corrupted, faces planes/cylinders/cones/spheres/tori, volume against the
mesh's:

| file | 0.01 mm before → after | 0.05 mm before → after | 0.1 mm before → after |
|---|---|---|---|
| own/battery-holder | rebuild → rebuild (1.0 s) | rebuild → rebuild (1.0 s) | rebuild → budget (30 s) |
| own/hole-filler-35mm | rebuild → **6 (3/2/0/0/1), 1.0013** (0.4 s) | rebuild → **same** (16 s) | rebuild → **same** (14 s) |
| own/trashcan-repair-foot | rebuild → **16 (12/4/0/0/0), 0.9989** (0.1 s) | unfit → unfit 1 (34 %) | unfit → unfit 1 (38 %) |
| door-stopper-top | rebuild (24 s) → rebuild (6.3 s) | rebuild → rebuild (4.2 s) | rebuild → rebuild (15 s) |
| gardena-end | rebuild (2.2 s) → rebuild (3.0 s) | rebuild → rebuild (0.2 s) | rebuild → rebuild (0.2 s) |
| micro-sd-keyring-inner | rebuild → rebuild (2.2 s) | trap → **97 (91/6/0/0/0), 1.0006** (0.8 s) | 84 faces (4.5 s) → **84 (78/6/0/0/0), 1.0007** (1.2 s) |
| mms-flat-stand | rebuild → **44 (37/6/1/0/0), 1.0000** (0.3 s) | trap → **same** (0.4 s) | rebuild → rebuild (0.3 s) |
| sock-clips-6x | rebuild (43 s) → budget (30 s) | trap → rebuild (1.0 s) | rebuild → budget (30 s) |
| spaghetti-measure | rebuild → rebuild (0.9 s) | trap → rebuild (0.3 s) | rebuild → rebuild (1.2 s) |
| wyze-garage-bracket | rebuild → rebuild (0.5 s) | trap → **84 (55/27/2/0/0), 1.0002** (9.1 s) | rebuild → **88 (58/28/2/0/0), 0.9987** (5.1 s) |
| own/drill-block | unfit 3 → unfit 3 (0 %) | 168 faces (9.6 s) → **168 (137/30/0/1/0), 1.0003** (3.4 s) | rebuild → rebuild (2.4 s) |

Over all 41 files, prismatic converts 9 at 0.01 mm (6 before), 11 at 0.05 and
9 at 0.1, with no trap in one process per tolerance; hole-filler's 14–16 s
at 0.05 and 0.1 mm is a fourth cell (three kept) that no sample falls in: it
stays undecided, and every sample is classified against it. **The budget overruns inside MakerVolume**: it
asks the indicator between its own steps only, and one step of
hot-wheels-connector at 0.1 mm ran to 56 s before the refusal; stopping
inside a step would need the rebuild on its own thread.

### 6. Where it is

A tile "Mesh to Solid" at the end of Solid › Modify (with a tooltip clip,
`pnpm demos`, ADR-0052), a "Convert to solid…" entry in the context menu of
a body the browser tags "Mesh" (`data-body-mesh`), and the command in the
palette. Done (2026-10-21): the Import dialog's `solid` toggle ("As solid")
adds `meshToSolid` (Prismatic, default tolerance) right after the import
through `commitWith` — one undo step, mesh files only, create mode only.

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

### Amendment, 2026-10-22: hardening slice B

The owner ran 41 real STLs through `Kernel.meshToSolid` on 2026-10-21
(`~/Development/extrudo-stl-solid-test/baseline-2026-10-21-tol0.01.md`) and
found two faceted problems. This slice fixes exactly those two.

**The cap refusal was slow.** On every over-cap mesh the facade built the
whole solid (unify included) and only then counted faces: 3–15 s per file
(`own/kuglbahn-pillar-base.stl` 12.8 s for 19,883 faces,
`own/spool-screw-v4.1.stl` 10.4 s, `third-party/vented-funnel.stl` 9.8 s).
Now a private `facetedMeshCounts()` runs first, from the triangle buffers
alone: adjacent triangles (sharing a node-index edge) whose unit normals
agree within 1e-3 rad and whose planes agree within 1e-3 mm — the tolerances
`ShapeUpgrade_UnifySameDomain` gets — are one face, with a union-find over
the triangles; a zero-area triangle joins a neighbour; the number of groups
is the estimate. A circle of `uses` sorted by edge key is linear-ish and
costs single-digit ms on these files (every refusal is now under 25 ms).
Over `FACETED_FACE_CAP` the facade refuses at once with "Faceted would give
about N faces; …" (the word "about" is new: the estimate can be off by a few
faces). The old after-unify count stays a backstop; its message is unchanged
(no "about"). The estimate matched the exact count for 12 of the 18
non-capped files measured and was within 5 % for 17;
`own/trashcan-repair-foot.stl` was the outlier (387 estimated vs 275 exact,
+41 %; `UnifySameDomain` merges more than the edge rule sees).

**Six meshes the importer accepted as closed were refused** with "Mesh to
Solid couldn't make a closed solid from this mesh …". The stage was the
`BRepCheck_Analyzer` on the solid, before unify, and its shell status was
`BRepCheck_NotConnected`: every one of the six is a body of **several
disjoint closed shells** (a multi-part STL), and putting all their faces in
one `TopoDS_Shell` is not a connected shell. `wyze-garage-bracket` has 2
shells, `mirna-doodle-1` 5, `battery-power-adapter` 2, `phone-stand-foldable`
2, `whiteboard-tray-v5` 7, `gear-bearing-5` 7. **Fix:** the facade groups the
faces by shared edge (a union-find over the OCCT edges) and builds one shell,
`BRepBuilderAPI_MakeSolid`, `ShapeFix_Solid` and `ShapeUpgrade_UnifySameDomain`
per shell; one shell gives the solid as before, several give a compound
(`splitSolids` splits it into bodies, ADR-0030). `mirna-doodle-1` (198 faces)
and `wyze-garage-bracket` (945 faces) now convert, valid, volume unchanged to
the mesh; the other four were always over the face cap (8,152 / 7,851 /
7,938 / 16,987 estimated) and are now refused at the pre-count, quickly. No
mesh with one shell changes (same face counts, validity and volume).

**A truly non-manifold mesh still refuses, and now names the reason.**
`facetedMeshCounts()` also counts edges shared by more than two triangles,
edges used by one (open), and pinched vertices (a vertex whose triangles
belong to more than one edge-connected shell). Each has a message: "Mesh to
Solid couldn't make a closed solid from this mesh: 3 edges are shared by more
than two triangles. Repair it in your slicer or a mesh tool and try again."
(and "1 edge has only one triangle." / "1 vertex joins shells that only touch
at a point."; the counts pluralise). The generic message stays for anything
else. The importer rejects open and non-manifold-edge meshes before this, so
only a direct `Kernel.meshToSolid` call, or a pinched-vertex mesh
(`checkManifold` counts edges, not vertices), reaches those clauses.

The fast loop is harness case `g` (`STL_DIR=… FILE=… bash
spikes/stl-to-solid/run.sh prismatic g`): faceted on one corpus file. Tests
in the faceted `describe` of `packages/kernel/src/mesh-to-solid.test.ts`: a
two-cube mesh converts into a compound of two solids; a mesh whose two cubes
touch at a single vertex is refused with "vertex joins shells that only touch
at a point"; the cap-refusal test asserts the refusal takes under 1 s.

### Amendment, 2026-10-22: hardening slice D

The pre-count refused whenever the estimate was over `FACETED_FACE_CAP`, but
the estimate over-counts by up to about 40 % on real meshes (387 estimated
against 275 exact on `own/trashcan-repair-foot.stl`), so a mesh whose exact
count is just under 2,000 could be refused without ever building. The
pre-count now refuses only past `FACETED_FACE_CAP * FACETED_ESTIMATE_MARGIN`
(`FACETED_ESTIMATE_MARGIN` = 1.5); between the cap and 3,000 estimated faces
the build runs and the exact count decides, as before slice B. For the user:
refusals of meshes with 2,000–3,000 faces take the build's time again
(2–4 s); estimates over 3,000 are still refused at once.
