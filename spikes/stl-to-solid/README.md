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
