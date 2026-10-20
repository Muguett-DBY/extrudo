# Spike: STL triangles → B-rep solid (issue #95)

Probe for `docs/plans/stl-to-solid-2026-10-20.md`. Built and run in the pinned
OCCT image (OCCT 8.0.1), 2026-10-20:

```sh
bash spikes/stl-to-solid/run.sh        # about 2 minutes: em++ link + node
```

`harness.cpp` makes a box, a cylinder, a plate with a hole and two spheres
with OCCT, writes each as binary STL, reads it back (`RWStl`, welded nodes,
as our importer's `Mesh.merge()` does), then:
`BRepBuilderAPI_MakeShapeOnMesh` → shell (`BRep_Builder`, the faces share
their edges) → `BRepBuilderAPI_MakeSolid` + `ShapeFix_Solid` →
`ShapeUpgrade_UnifySameDomain` → `ShapeFix_Shape`, and tries a fillet and a
through-cut on the result against an exact-box control. Numbers are in the
plan.

## Prismatic (slice 3, 2026-10-21)

```sh
bash spikes/stl-to-solid/run.sh prismatic      # all cases, about 5 minutes: em++ link + node
bash spikes/stl-to-solid/run.sh prismatic 6    # one case: 1-9, 11, or x (extra shapes)
FACES=1 bash spikes/stl-to-solid/run.sh prismatic 6   # with every face's plane or axis
```

`prismatic.cpp` includes the facade itself (`run.sh` copies it with its
private members public into `build/`), stages each mesh through
`meshNodes`/`meshTriangles` with the nodes rounded to float32 (as
`Kernel.meshFrom` keeps a mesh body), and runs `meshToSolid(1, tolerance)`.
The meshes: `fixtures/imports/cube.stl`; cylinders r 5 h 20 at 32, 360 and
16 segments built like manifold's (caps triangulated from their boundary
only); OCCT solids meshed fine or coarse and read back welded through STL (a
plate with a hole, a box with a filleted edge, a 299-step staircase); a UV
sphere (2,208 and 499,000 triangles); the 32-gon with its nodes moved
radially by up to ±0.005 mm. `x` adds an L-bracket, boxes with four
filleted vertical or top edges, a plate with a 12-gon hole, a slot and a
boss, and a tube. It prints the time, the report, the faces by kind, the
validity and the volume against the exact one. The numbers are in
ADR-0095's amendment of 2026-10-21; disabling the cylinder snap (an edit
of the copy) makes the coarse four-fillet box and the slot fail.
