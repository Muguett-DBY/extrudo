---
title: Mesh to Solid
section: Tools
category: Modify
order: 45
---

# Mesh to Solid

Turn an imported mesh into a solid with real faces, so it fillets, shells and takes sketches like any body.

| Where | Shortcut |
|---|---|
| Modify › Modify | None |

<video src="demo:meshToSolid" muted loop autoplay playsinline aria-label="Mesh to Solid demo"></video>

<!-- notes -->
Use **Faceted** for a part made of flat faces: it keeps every flat facet as a face and is exact. Use **Prismatic** for a part with holes and rounds: it finds the planes, cylinders, cones, spheres and tori within a tolerance and rebuilds them as exact surfaces. The conversion is refused above 2,000 faces (Faceted) or 500 surfaces (Prismatic), and the message names the count.
<!-- /notes -->
