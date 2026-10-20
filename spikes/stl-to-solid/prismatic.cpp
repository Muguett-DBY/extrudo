// Mesh to Solid, prismatic (ADR-0095 §3, slice 3): the facade's own
// meshToSolid(1, tolerance) on the test matrix of the slice, natively in the
// pinned OCCT image. run.sh copies the facade with its private members made
// public into build/facade_public.cpp, which this file includes.
#include "build/facade_public.cpp"

#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepPrimAPI_MakeSphere.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <RWStl.hxx>
#include <StlAPI_Writer.hxx>
#include <BRepBuilderAPI_Copy.hxx>
#include <chrono>
#include <cstring>
#include <iomanip>
#include <iostream>

static double now() {
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

struct Mesh {
  std::vector<double> nodes;
  std::vector<uint32_t> triangles;
};

/** An OCCT shape meshed, written as binary STL and read back welded (as an import would be). */
static Mesh meshOf(const TopoDS_Shape& shape, double deflection, double angle) {
  BRepMesh_IncrementalMesh(shape, deflection, false, angle);
  StlAPI_Writer writer;
  writer.ASCIIMode() = false;
  writer.Write(shape, "/tmp/prismatic.stl");
  Handle(Poly_Triangulation) tri = RWStl::ReadFile("/tmp/prismatic.stl");
  Mesh m;
  for (int i = 1; i <= tri->NbNodes(); ++i) {
    const gp_Pnt p = tri->Node(i);
    m.nodes.insert(m.nodes.end(), {p.X(), p.Y(), p.Z()});
  }
  for (int i = 1; i <= tri->NbTriangles(); ++i) {
    int a, b, c;
    tri->Triangle(i).Get(a, b, c);
    m.triangles.insert(m.triangles.end(), {uint32_t(a - 1), uint32_t(b - 1), uint32_t(c - 1)});
  }
  return m;
}

static Mesh stlFile(const char* path) {
  Handle(Poly_Triangulation) tri = RWStl::ReadFile(path);
  Mesh m;
  for (int i = 1; i <= tri->NbNodes(); ++i) {
    const gp_Pnt p = tri->Node(i);
    m.nodes.insert(m.nodes.end(), {p.X(), p.Y(), p.Z()});
  }
  for (int i = 1; i <= tri->NbTriangles(); ++i) {
    int a, b, c;
    tri->Triangle(i).Get(a, b, c);
    m.triangles.insert(m.triangles.end(), {uint32_t(a - 1), uint32_t(b - 1), uint32_t(c - 1)});
  }
  return m;
}

/** A cylinder like manifold's: two rings, caps triangulated from their boundary only. `noise(ring, i)` moves a node radially. */
static Mesh cylinder(double r, double h, int segments, double (*noise)(int, int) = nullptr) {
  Mesh m;
  for (int ring = 0; ring < 2; ++ring) {
    for (int i = 0; i < segments; ++i) {
      const double a = 2 * M_PI * i / segments, rr = r + (noise ? noise(ring, i) : 0);
      m.nodes.insert(m.nodes.end(), {rr * std::cos(a), rr * std::sin(a), ring * h});
    }
  }
  auto bottom = [&](int i) { return uint32_t(i % segments); };
  auto top = [&](int i) { return uint32_t(segments + i % segments); };
  for (int i = 0; i < segments; ++i) {
    m.triangles.insert(m.triangles.end(), {bottom(i), bottom(i + 1), top(i + 1)});
    m.triangles.insert(m.triangles.end(), {bottom(i), top(i + 1), top(i)});
  }
  for (int i = 1; i + 1 < segments; ++i) {
    m.triangles.insert(m.triangles.end(), {bottom(0), bottom(i + 1), bottom(i)});
    m.triangles.insert(m.triangles.end(), {top(0), top(i), top(i + 1)});
  }
  return m;
}

/** A UV sphere with `rings` x `segments` quads. */
static Mesh sphere(double r, int rings, int segments) {
  Mesh m;
  m.nodes.insert(m.nodes.end(), {0, 0, -r});
  for (int j = 1; j < rings; ++j) {
    const double phi = -M_PI / 2 + M_PI * j / rings;
    for (int i = 0; i < segments; ++i) {
      const double a = 2 * M_PI * i / segments;
      m.nodes.insert(m.nodes.end(), {r * std::cos(phi) * std::cos(a), r * std::cos(phi) * std::sin(a), r * std::sin(phi)});
    }
  }
  m.nodes.insert(m.nodes.end(), {0, 0, r});
  const uint32_t northPole = uint32_t(m.nodes.size() / 3 - 1);
  auto at = [&](int j, int i) { return uint32_t(1 + (j - 1) * segments + i % segments); };
  for (int i = 0; i < segments; ++i) m.triangles.insert(m.triangles.end(), {0, at(1, i + 1), at(1, i)});
  for (int j = 1; j + 1 < rings; ++j) {
    for (int i = 0; i < segments; ++i) {
      m.triangles.insert(m.triangles.end(), {at(j, i), at(j, i + 1), at(j + 1, i + 1)});
      m.triangles.insert(m.triangles.end(), {at(j, i), at(j + 1, i + 1), at(j + 1, i)});
    }
  }
  for (int i = 0; i < segments; ++i) m.triangles.insert(m.triangles.end(), {at(rings - 1, i), at(rings - 1, i + 1), northPole});
  return m;
}

static std::string kinds(const TopoDS_Shape& s) {
  std::map<int, int> k;
  for (TopExp_Explorer e(s, TopAbs_FACE); e.More(); e.Next()) k[BRepAdaptor_Surface(TopoDS::Face(e.Current())).GetType()]++;
  std::string out;
  for (auto& [t, n] : k) out += " " + std::to_string(n) + (t == GeomAbs_Plane ? " plane" : t == GeomAbs_Cylinder ? " cyl" : " other");
  return out;
}

static int failures = 0;

/** Runs prismatic on `m`; prints the result; returns the handle (0 on refusal). */
static int run(ExtrudoFacade& f, const char* name, const Mesh& m, double tolerance, double expectVolume = 0) {
  const double t0 = now();
  f.meshNodes(int(m.nodes.size() / 3));
  // Float32, as Kernel.meshFrom keeps a mesh body's nodes (and STL stores them).
  double* nodes = reinterpret_cast<double*>(f.meshNodesPtr());
  for (size_t i = 0; i < m.nodes.size(); ++i) nodes[i] = static_cast<float>(m.nodes[i]);
  f.meshTriangles(int(m.triangles.size() / 3));
  std::memcpy(reinterpret_cast<void*>(f.meshTrianglesPtr()), m.triangles.data(), m.triangles.size() * sizeof(uint32_t));
  const int h = f.meshToSolid(1, tolerance);
  const double ms = now() - t0;
  std::cout << "== " << name << " (" << m.triangles.size() / 3 << " triangles, tol " << tolerance << "): " << ms << " ms\n";
  const auto& r = f.meshReport_;
  if (r.size() == 10) {
    std::cout << "   report: faces " << r[0] << ", planes " << r[1] << ", cylinders " << r[2] << ", unfit " << r[6] << " regions / "
              << r[7] << " triangles / " << r[8] << ", suggested " << r[9] << "\n";
  }
  if (!h) {
    std::cout << "   refused: " << f.lastError() << "\n";
    return 0;
  }
  const TopoDS_Shape& s = *f.find(h);
  const double v = ExtrudoFacade::volumeOf(s);
  std::cout << "   faces " << f.count(h, 0) << ":" << kinds(s) << ", valid " << BRepCheck_Analyzer(s).IsValid() << ", volume " << v;
  if (expectVolume > 0) std::cout << " (expect " << expectVolume << ", " << 100 * (v - expectVolume) / expectVolume << " %)";
  std::cout << "\n";
  for (TopExp_Explorer e(s, TopAbs_FACE); e.More(); e.Next()) {
    BRepAdaptor_Surface a(TopoDS::Face(e.Current()));
    if (a.GetType() == GeomAbs_Cylinder) std::cout << "   cylinder radius " << std::setprecision(12) << a.Cylinder().Radius() << std::setprecision(6) << "\n";
    if (getenv("FACES") && *getenv("FACES")) {
      GProp_GProps g;
      BRepGProp::SurfaceProperties(e.Current(), g);
      std::cout << "     face type " << a.GetType() << " area " << std::setprecision(10) << g.Mass() << std::setprecision(6);
      if (a.GetType() == GeomAbs_Plane) { gp_Pln pl = a.Plane(); std::cout << " n " << pl.Axis().Direction().X() << "," << pl.Axis().Direction().Y() << "," << pl.Axis().Direction().Z() << " d " << std::setprecision(12) << pl.Location().XYZ().Dot(pl.Axis().Direction().XYZ()) << std::setprecision(6); }
      if (a.GetType() == GeomAbs_Cylinder) { gp_Cylinder c = a.Cylinder(); std::cout << std::setprecision(12) << " axis " << c.Axis().Direction().X() << "," << c.Axis().Direction().Y() << "," << c.Axis().Direction().Z() << " at " << c.Location().X() << "," << c.Location().Y() << "," << c.Location().Z() << std::setprecision(6); }
      std::cout << "\n";
    }
  }
  return h;
}

static double noise32(int ring, int i) { return 0.005 * (ring == 0 ? std::sin(1.7 * i + 0.3) : std::cos(2.3 * i + 0.1)); }

int main(int argc, char** argv) {
  ExtrudoFacade f;
  const std::string only = argc > 1 ? argv[1] : "";
  auto want = [&](const char* id) { return only.empty() || only == id; };
  if (want("1")) {
    int h = run(f, "1 cube.stl", stlFile("/repo/fixtures/imports/cube.stl"), 0.01, 8000);
    if (h) f.release(h);
  }
  const double cylVolume = M_PI * 25 * 20;
  if (want("2")) { int h = run(f, "2 cylinder 32", cylinder(5, 20, 32), 0.01, cylVolume); if (h) f.release(h); }
  if (want("3")) { int h = run(f, "3 cylinder 360", cylinder(5, 20, 360), 0.01, cylVolume); if (h) f.release(h); }
  if (want("4")) { int h = run(f, "4 cylinder 16", cylinder(5, 20, 16), 0.01, cylVolume); if (h) f.release(h); }
  if (want("5") || want("11")) {
    TopoDS_Shape box = BRepPrimAPI_MakeBox(40, 30, 5).Shape();
    TopoDS_Shape drill = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(20, 15, -1), gp_Dir(0, 0, 1)), 3, 7).Shape();
    TopoDS_Shape plate = BRepAlgoAPI_Cut(box, drill).Shape();
    const double exact = 6000 - 45 * M_PI;
    if (want("5")) {
      int h = run(f, "5 plate with hole, fine", meshOf(plate, 0.001, 0.05), 0.01, exact);
      if (h) {
        // A 1 mm fillet on the hole's top edge (a circle at z = 5).
        const TopoDS_Shape& s = *f.find(h);
        BRepFilletAPI_MakeFillet fillet(s);
        int circles = 0;
        NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> edges;
        TopExp::MapShapes(s, TopAbs_EDGE, edges);
        for (int i = 1; i <= edges.Extent(); ++i) {
          BRepAdaptor_Curve c(TopoDS::Edge(edges(i)));
          if (c.GetType() == GeomAbs_Circle) {
            ++circles;
            if (c.Value(c.FirstParameter()).Z() > 4.9) fillet.Add(1.0, TopoDS::Edge(edges(i)));
          }
        }
        fillet.Build();
        std::cout << "   circle edges " << circles << ", fillet r1 on the top one: done " << fillet.IsDone();
        if (fillet.IsDone()) std::cout << ", valid " << BRepCheck_Analyzer(fillet.Shape()).IsValid() << ", faces " << kinds(fillet.Shape());
        std::cout << "\n";
        f.release(h);
      }
    }
    if (want("11")) {
      int h = run(f, "11a plate with hole, ~20k triangles", meshOf(plate, 0.0002, 0.01), 0.01, exact);
      if (h) f.release(h);
    }
  }
  if (want("6")) {
    TopoDS_Shape box = BRepPrimAPI_MakeBox(20, 20, 20).Shape();
    BRepFilletAPI_MakeFillet fillet(box);
    TopExp_Explorer e(box, TopAbs_EDGE);
    fillet.Add(2.0, TopoDS::Edge(e.Current()));
    TopoDS_Shape rounded = fillet.Shape();
    const double exact = ExtrudoFacade::volumeOf(rounded);
    int h = run(f, "6a filleted box, fine", meshOf(rounded, 0.001, 0.05), 0.01, exact);
    if (h) f.release(h);
    TopoDS_Shape again = BRepBuilderAPI_Copy(rounded).Shape();
    h = run(f, "6b filleted box, coarse (8 segments)", meshOf(again, 1, M_PI / 16 + 1e-3), 0.01, exact);
    if (h) f.release(h);
  }
  if (want("7")) { int h = run(f, "7 sphere r10", sphere(10, 24, 48), 0.01); if (h) f.release(h); }
  if (want("8")) {
    BRepBuilderAPI_MakePolygon polygon;
    const int steps = 299;
    polygon.Add(gp_Pnt(0, 0, 0));
    polygon.Add(gp_Pnt(steps, 0, 0));
    for (int i = 0; i < steps; ++i) {
      polygon.Add(gp_Pnt(steps - i, i + 1, 0));
      polygon.Add(gp_Pnt(steps - i - 1, i + 1, 0));
    }
    polygon.Close();
    TopoDS_Face face = BRepBuilderAPI_MakeFace(polygon.Wire()).Face();
    TopoDS_Shape stairs = BRepPrimAPI_MakePrism(face, gp_Vec(0, 0, 5)).Shape();
    NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> stairFaces;
    TopExp::MapShapes(stairs, TopAbs_FACE, stairFaces);
    std::cout << "   staircase: " << stairFaces.Extent() << " faces\n";
    int h = run(f, "8 staircase", meshOf(stairs, 0.1, 0.5), 0.01);
    if (h) f.release(h);
  }
  if (want("9")) {
    int h = run(f, "9a noisy 32-gon, tol 0.001", cylinder(5, 20, 32, noise32), 0.001, cylVolume);
    if (h) f.release(h);
    h = run(f, "9b noisy 32-gon, tol 0.02", cylinder(5, 20, 32, noise32), 0.02, cylVolume);
    if (h) f.release(h);
  }
  if (want("11")) {
    int h = run(f, "11b sphere, 500k triangles", sphere(10, 500, 500), 0.01);
    if (h) f.release(h);
  }
  if (want("x")) {
    // Extra shapes beyond the slice's matrix.
    auto exact = [](const TopoDS_Shape& s) { return ExtrudoFacade::volumeOf(s); };
    TopoDS_Shape bracket = BRepAlgoAPI_Cut(BRepPrimAPI_MakeBox(30, 20, 20).Shape(),
                                           BRepPrimAPI_MakeBox(gp_Pnt(5, -1, 5), 30, 22, 20).Shape()).Shape();
    int h = run(f, "x1 L-bracket", meshOf(bracket, 0.01, 0.1), 0.01, exact(bracket));
    if (h) f.release(h);
    for (int coarse = 0; coarse < 2; ++coarse) {
      TopoDS_Shape box = BRepPrimAPI_MakeBox(40, 30, 10).Shape();
      BRepFilletAPI_MakeFillet fillet(box);
      NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> edges;
      TopExp::MapShapes(box, TopAbs_EDGE, edges);
      for (int i = 1; i <= edges.Extent(); ++i) {
        BRepAdaptor_Curve c(TopoDS::Edge(edges(i)));
        gp_Vec d(c.Value(c.FirstParameter()), c.Value(c.LastParameter()));
        if (std::fabs(d.Z()) > 1) fillet.Add(3.0, TopoDS::Edge(edges(i)));
      }
      TopoDS_Shape rounded = fillet.Shape();
      h = run(f, coarse ? "x2b box, 4 vertical edges filleted r3, coarse" : "x2a box, 4 vertical edges filleted r3, fine",
              coarse ? meshOf(rounded, 1, M_PI / 16 + 1e-3) : meshOf(rounded, 0.001, 0.05), 0.01, exact(rounded));
      if (h) f.release(h);
    }
    {
      TopoDS_Shape top = BRepPrimAPI_MakeBox(40, 30, 10).Shape();
      BRepFilletAPI_MakeFillet fillet(top);
      NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> edges;
      TopExp::MapShapes(top, TopAbs_EDGE, edges);
      for (int i = 1; i <= edges.Extent(); ++i) {
        BRepAdaptor_Curve c(TopoDS::Edge(edges(i)));
        if (c.Value(c.FirstParameter()).Z() > 9.9 && c.Value(c.LastParameter()).Z() > 9.9) fillet.Add(2.0, TopoDS::Edge(edges(i)));
      }
      TopoDS_Shape rounded = fillet.Shape();
      h = run(f, "x3 box, 4 top edges filleted r2 (corners are not cylinders)", meshOf(rounded, 0.01, 0.2), 0.01, exact(rounded));
      if (h) f.release(h);
    }
    {
      TopoDS_Shape box = BRepPrimAPI_MakeBox(40, 30, 5).Shape();
      TopoDS_Shape drill = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(20, 15, -1), gp_Dir(0, 0, 1)), 3, 7).Shape();
      TopoDS_Shape plate = BRepAlgoAPI_Cut(box, drill).Shape();
      h = run(f, "x4 plate with a coarse hole (12-gon)", meshOf(plate, 1, M_PI / 6 - 1e-3), 0.01, exact(plate));
      if (h) f.release(h);
    }
    {
      // A slot: two half cylinders tangent to two parallel walls.
      TopoDS_Shape box = BRepPrimAPI_MakeBox(40, 30, 5).Shape();
      TopoDS_Shape a = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(12, 15, -1), gp_Dir(0, 0, 1)), 4, 7).Shape();
      TopoDS_Shape b = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(28, 15, -1), gp_Dir(0, 0, 1)), 4, 7).Shape();
      TopoDS_Shape mid = BRepPrimAPI_MakeBox(gp_Pnt(12, 11, -1), 16, 8, 7).Shape();
      TopoDS_Shape slot = BRepAlgoAPI_Fuse(BRepAlgoAPI_Fuse(a, b).Shape(), mid).Shape();
      ShapeUpgrade_UnifySameDomain u(slot, true, true, false); u.Build();
      TopoDS_Shape plate = BRepAlgoAPI_Cut(box, u.Shape()).Shape();
      h = run(f, "x5 plate with a slot", meshOf(plate, 0.01, 0.1), 0.01, exact(plate));
      if (h) f.release(h);
    }
    {
      TopoDS_Shape box = BRepPrimAPI_MakeBox(40, 30, 5).Shape();
      TopoDS_Shape boss = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(20, 15, 4), gp_Dir(0, 0, 1)), 6, 10).Shape();
      TopoDS_Shape part = BRepAlgoAPI_Fuse(box, boss).Shape();
      ShapeUpgrade_UnifySameDomain u(part, true, true, false); u.Build();
      h = run(f, "x6 plate with a boss", meshOf(u.Shape(), 0.01, 0.1), 0.01, exact(u.Shape()));
      if (h) f.release(h);
    }
    {
      // A tube: two coaxial cylinders.
      TopoDS_Shape outer = BRepPrimAPI_MakeCylinder(10, 20).Shape();
      TopoDS_Shape inner = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(0, 0, -1), gp_Dir(0, 0, 1)), 6, 22).Shape();
      TopoDS_Shape tube = BRepAlgoAPI_Cut(outer, inner).Shape();
      h = run(f, "x7 tube", meshOf(tube, 0.01, 0.1), 0.01, exact(tube));
      if (h) f.release(h);
    }
  }
  std::cout << "live shapes " << f.liveShapes() << "\n";
  return failures;
}
