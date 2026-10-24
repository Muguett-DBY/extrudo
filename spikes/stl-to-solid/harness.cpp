// Mesh → B-rep probe (issue #95): can OCCT turn an STL's triangles into a
// solid with real faces? Box, cylinder, sphere: STL round trip, then
// BRepBuilderAPI_MakeShapeOnMesh, ShapeUpgrade_UnifySameDomain, MakeSolid.
#include <BRepBuilderAPI_MakeShapeOnMesh.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepGProp.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRepPrimAPI_MakeSphere.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <GProp_GProps.hxx>
#include <Poly_Triangulation.hxx>
#include <RWStl.hxx>
#include <ShapeFix_Solid.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <StlAPI_Writer.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Shell.hxx>
#include <GeomAdaptor_Surface.hxx>
#include <BRep_Tool.hxx>
#include <chrono>
#include <BRep_Builder.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <ShapeAnalysis_FreeBounds.hxx>
#include <malloc.h>
#include <ShapeFix_Shape.hxx>
#include <BRepLib.hxx>
#include <BRepTools.hxx>
#include <iostream>
#include <map>

static double heapMB() { return mallinfo().uordblks / 1048576.0; }
static double now() {
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();
}
static int count(const TopoDS_Shape& s, TopAbs_ShapeEnum t) {
  TopTools_IndexedMapOfShape m; TopExp::MapShapes(s, t, m); return m.Extent();
}
static double volume(const TopoDS_Shape& s) {
  GProp_GProps g; BRepGProp::VolumeProperties(s, g); return g.Mass();
}
static std::string kinds(const TopoDS_Shape& s) {
  std::map<int,int> k;
  for (TopExp_Explorer e(s, TopAbs_FACE); e.More(); e.Next()) {
    GeomAdaptor_Surface a(BRep_Tool::Surface(TopoDS::Face(e.Current())));
    k[a.GetType()]++;
  }
  std::string out;
  for (auto& [t, n] : k) out += " " + std::to_string(n) + "x" + (t == GeomAbs_Plane ? "plane" : t == GeomAbs_Cylinder ? "cyl" : t == GeomAbs_Sphere ? "sph" : "other" + std::to_string(t));
  return out;
}

static void probe(const char* name, const TopoDS_Shape& exact, double deflection, bool unify = true) {
  BRepMesh_IncrementalMesh(exact, deflection, false, 0.5);
  StlAPI_Writer w; w.ASCIIMode() = false;
  w.Write(exact, "/tmp/probe.stl");
  double t0 = now();
  Handle(Poly_Triangulation) tri = RWStl::ReadFile("/tmp/probe.stl");
  double t1 = now();
  std::cout << "== " << name << ": " << tri->NbTriangles() << " triangles, " << tri->NbNodes() << " nodes (read " << (t1 - t0) << " ms)\n";
  BRepBuilderAPI_MakeShapeOnMesh maker(tri);
  maker.Build();
  double t2 = now();
  TopoDS_Shape shape = maker.Shape();
  std::cout << "   MakeShapeOnMesh: " << (t2 - t1) << " ms, faces " << count(shape, TopAbs_FACE) << ", type " << shape.ShapeType() << "\n";
  TopoDS_Shape solidIn;
  {
    // 1. The faces share their edges? Then a shell is just a container.
    BRep_Builder b; TopoDS_Shell sh; b.MakeShell(sh);
    for (TopExp_Explorer e(shape, TopAbs_FACE); e.More(); e.Next()) b.Add(sh, e.Current());
    sh.Closed(BRep_Tool::IsClosed(sh));
    BRepBuilderAPI_MakeSolid ms(sh); TopoDS_Shape sol = ms.Solid();
    ShapeFix_Solid fix(TopoDS::Solid(sol)); fix.Perform(); sol = fix.Solid();
    const bool ok = BRepCheck_Analyzer(sol).IsValid();
    std::cout << "   shell by BRep_Builder: edges " << count(shape, TopAbs_EDGE) << " (triangles*3 = " << tri->NbTriangles() * 3 << "), closed " << BRep_Tool::IsClosed(sh) << ", solid valid " << ok << ", volume " << volume(sol) << "\n";
    if (ok) solidIn = sol;
  }
  if (solidIn.IsNull()) {
    double s0 = now();
    BRepBuilderAPI_Sewing sewing(1e-6);
    for (TopExp_Explorer e(shape, TopAbs_FACE); e.More(); e.Next()) sewing.Add(e.Current());
    sewing.Perform();
    TopoDS_Shell sh;
    for (TopExp_Explorer e(sewing.SewedShape(), TopAbs_SHELL); e.More() && sh.IsNull(); e.Next()) sh = TopoDS::Shell(e.Current());
    std::cout << "   sewing: " << (now() - s0) << " ms, free edges " << sewing.NbFreeEdges() << ", shell null " << sh.IsNull() << "\n";
    if (sh.IsNull()) return;
    BRepBuilderAPI_MakeSolid ms(sh); solidIn = ms.Solid();
    ShapeFix_Solid fix(TopoDS::Solid(solidIn)); fix.Perform(); solidIn = fix.Solid();
  }
  double t3 = now();
  std::cout << "   solid: " << (t3 - t2) << " ms, solids " << count(solidIn, TopAbs_SOLID) << ", valid " << BRepCheck_Analyzer(solidIn).IsValid() << ", volume " << volume(solidIn) << " (exact " << volume(exact) << ")\n";
  if (!unify) return;
  ShapeUpgrade_UnifySameDomain u(solidIn, true, true, false);
  u.SetLinearTolerance(1e-3);
  u.SetAngularTolerance(1e-3);
  u.Build();
  double t4 = now();
  TopoDS_Shape out = u.Shape();
  std::cout << "   Unify: " << (t4 - t3) << " ms, faces " << count(out, TopAbs_FACE) << ", edges " << count(out, TopAbs_EDGE)
            << ", solids " << count(out, TopAbs_SOLID) << ", valid " << BRepCheck_Analyzer(out).IsValid() << ", volume " << volume(out) << ", kinds" << kinds(out) << "\n";
  // Heal: p-curves, orientation, tolerances (what the facade would do).
  double h0 = now();
  ShapeFix_Shape healer(out); healer.Perform(); TopoDS_Shape healed = healer.Shape();
  BRepLib::BuildCurves3d(healed);
  std::cout << "   ShapeFix: " << (now() - h0) << " ms, valid " << BRepCheck_Analyzer(healed).IsValid() << ", faces " << count(healed, TopAbs_FACE) << ", heap " << heapMB() << " MB\n";
  for (int pass = 0; pass < 2; pass++) {
    const TopoDS_Shape& body = pass == 0 ? out : healed;
    const char* label = pass == 0 ? "unified" : "healed ";
    if (count(body, TopAbs_EDGE) <= 40) {
      try {
        BRepFilletAPI_MakeFillet f(body);
        TopExp_Explorer e(body, TopAbs_EDGE);
        f.Add(1.0, TopoDS::Edge(e.Current()));
        f.Build();
        std::cout << "   " << label << " fillet r=1: done " << f.IsDone() << ", null " << f.Shape().IsNull()
                  << (f.IsDone() && !f.Shape().IsNull() ? ", faces " + std::to_string(count(f.Shape(), TopAbs_FACE)) + ", valid " + std::to_string(BRepCheck_Analyzer(f.Shape()).IsValid()) + ", volume " + std::to_string(volume(f.Shape())) : "") << "\n";
      } catch (Standard_Failure& ex) { std::cout << "   " << label << " fillet threw: " << ex.what() << "\n"; }
    }
    try {
      double b0 = now();
      TopoDS_Shape drill = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(5, 5, -50), gp_Dir(0, 0, 1)), 3, 100).Shape();
      BRepAlgoAPI_Cut cut(body, drill);
      cut.Build();
      std::cout << "   " << label << " cut Ø6 through: " << (now() - b0) << " ms, done " << cut.IsDone() << ", faces " << count(cut.Shape(), TopAbs_FACE)
                << ", solids " << count(cut.Shape(), TopAbs_SOLID) << ", valid " << BRepCheck_Analyzer(cut.Shape()).IsValid() << ", volume " << volume(cut.Shape()) << ", kinds" << kinds(cut.Shape()) << "\n";
    } catch (Standard_Failure& ex) { std::cout << "   " << label << " cut threw: " << ex.what() << "\n"; }
  }
  std::cout << "   heap after: " << heapMB() << " MB\n";
}

int main() {
  std::cout << "heap at start " << heapMB() << " MB\n";
  TopoDS_Shape box = BRepPrimAPI_MakeBox(20, 30, 10).Shape();
  {
    TopoDS_Shape drill = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(5, 5, -50), gp_Dir(0, 0, 1)), 3, 100).Shape();
    BRepAlgoAPI_Cut cut(box, drill); cut.Build();
    std::cout << "== control: exact box cut Ø6: faces " << count(cut.Shape(), TopAbs_FACE) << ", volume " << volume(cut.Shape()) << "\n";
  }
  probe("box 20x30x10", box, 0.5);
  TopoDS_Shape cyl = BRepPrimAPI_MakeCylinder(10, 10).Shape();
  probe("cylinder r10 h10, deflection 0.1", cyl, 0.1);
  // A box with a hole and a round: what a typical printable part looks like.
  TopoDS_Shape drill = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(10, 15, -1), gp_Dir(0, 0, 1)), 4, 12).Shape();
  TopoDS_Shape plate = BRepAlgoAPI_Cut(box, drill).Shape();
  probe("plate with hole, deflection 0.05", plate, 0.05);
  TopoDS_Shape sph = BRepPrimAPI_MakeSphere(10).Shape();
  probe("sphere r10, deflection 0.01", sph, 0.01);
  probe("sphere r10, deflection 0.002 (no unify)", sph, 0.002, false);
  return 0;
}
