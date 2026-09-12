#!/usr/bin/env python3
"""Morph the soft-body cage onto the real Pokemon X/Y Ditto model.

The site's blob is not a mesh, it is a baked soft-body asset: an 980-node
tetrahedral cage with a 72234-vertex render surface bound to it by barycentric
weights. The surface is rebuilt from the cage every frame, so the cage decides
the shape and the baked arrays never have to be touched.

So instead of swapping the mesh in, this measures both shapes as a radius
field over direction, r(theta, phi), and emits the ratio target/current.
`dittoSculpt` in the runtime scales every cage node along its own direction by
that ratio, which pulls the jelly onto Ditto's silhouette.

Reads MODEL_SMD (mesh_0 is the body) and the shipped CAGE_BIN. Writes
shape_table.json for patch.py to inline.
"""
import json
import math
import pathlib
import struct
import sys
import zipfile

ROOT = pathlib.Path(__file__).parent
# The ripped Pokemon X/Y model, read straight out of the archive. Override the
# path with argv[1] if it lives somewhere else. shape_table.json is checked in,
# so the project builds without it; this only has to run to re-derive.
MODEL_ZIP = pathlib.Path(
    sys.argv[1]
    if len(sys.argv) > 1 and sys.argv[1].endswith(".zip")
    else "/Users/jeramai.faber/Downloads/ditto/source/"
    "3DS - Pokemon X Y - 132 Ditto.zip"
)
BODY_SMD = "Ditto/mesh_0_pm0132_00_Skin.smd"
EYES_SMD = "Ditto/mesh_1_pm0132_00_Skin.smd"
MOUTH_SMD = "Ditto/mesh_2_pm0132_00_Skin.smd"
CAGE_BIN = ROOT / "original/jelly-baby.bin"
SURFACE_OFFSET, SURFACE_LEN = 0, 216702

# The field is indexed by height and compass angle, not by 3D direction. A
# radial field measured from one centre has a blind spot at the poles: a single
# ratio per direction cannot widen a narrow spire into a flat plateau, and the
# model's top is a plateau (half width 0.550 against the jelly's 0.221). Slices
# have no such blind spot, and heights map one-to-one so the flat base stays
# flat and the height is exact.
NTHETA, NHEIGHT = 96, 48
# Barycentric samples per model triangle, so every bin gets hit.
TRI_SAMPLES = 10
# Gaussian blur of the field, in bins. Only enough to kill the per-bin
# sampling noise -- the runtime samples with Catmull-Rom, which is already C1,
# so the blur is not what keeps the surface smooth.
SMOOTH_SIGMA = 0.35
# Slices at the very top and bottom are tiny, so their ratio is ill-conditioned.
RATIO_MIN, RATIO_MAX = 0.5, 3.2
# The real model is a wedge: its top runs 0.98 of its height on one side and
# 0.79 on the other, which reads as triangular from a three-quarter camera.
# 0 keeps that exactly; 1 mirrors it into a symmetric blob.
SYMMETRY = 0.7

def smd_triangles(name):
    with zipfile.ZipFile(MODEL_ZIP) as z:
        lines = z.read(name).decode().replace("\r", "").split("\n")
    k = lines.index("triangles") + 1
    tris = []
    while k < len(lines) and lines[k].strip() != "end":
        vs = []
        for j in range(3):
            f = lines[k + 1 + j].split()
            # 3DS model is z-up with the face on -y; the site is y-up, face +z.
            x, y, z = (float(v) for v in f[1:4])
            vs.append((x, z, -y))
        tris.append(vs)
        k += 4
    return tris


def normalise(points):
    """Bottom to y=0, centred in x and z, scaled so the height is 1."""
    lo = [min(p[i] for p in points) for i in range(3)]
    hi = [max(p[i] for p in points) for i in range(3)]
    h = hi[1] - lo[1]
    cx, cz = (lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2
    frame = (cx, lo[1], cz, h)
    return lambda p: ((p[0] - cx) / h, (p[1] - lo[1]) / h, (p[2] - cz) / h), frame


def catmull(p0, p1, p2, p3, t):
    return p1 + 0.5 * t * (
        p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0))
    )


def sample(grid, y, x, z):
    """Bicubic lookup at height y and compass angle atan2(z, x).

    Matches the runtime exactly. Bilinear leaves the slope discontinuous at
    every bin edge, and the shading turns each one into a visible crease.
    """
    fa = y * NHEIGHT - 0.5
    fb = (math.atan2(z, x) + math.pi) / (2 * math.pi) * NTHETA - 0.5
    a1, b1 = math.floor(fa), math.floor(fb)
    ta, tb = fa - a1, fb - b1

    def row(a):
        g = grid[min(NHEIGHT - 1, max(0, a))]
        return catmull(*(g[(b1 + i) % NTHETA] for i in (-1, 0, 1, 2)), tb)

    return catmull(row(a1 - 1), row(a1), row(a1 + 1), row(a1 + 2), ta)


def gaussian(grid):
    """Separable blur, wrapping in theta and clamping in height."""
    radius = max(1, int(SMOOTH_SIGMA * 3))
    kernel = [math.exp(-(i * i) / (2 * SMOOTH_SIGMA ** 2)) for i in range(-radius, radius + 1)]
    total = sum(kernel)
    kernel = [k / total for k in kernel]

    mid = [[0.0] * NTHETA for _ in range(NHEIGHT)]
    for a in range(NHEIGHT):
        for b in range(NTHETA):
            mid[a][b] = sum(
                grid[a][(b + i) % NTHETA] * k
                for i, k in zip(range(-radius, radius + 1), kernel)
            )
    out = [[0.0] * NTHETA for _ in range(NHEIGHT)]
    for a in range(NHEIGHT):
        for b in range(NTHETA):
            out[a][b] = sum(
                mid[min(NHEIGHT - 1, max(0, a + i))][b] * k
                for i, k in zip(range(-radius, radius + 1), kernel)
            )
    return out


def bins_from_points(points):
    """Max horizontal radius per (height, compass angle) bin."""
    grid = [[0.0] * NTHETA for _ in range(NHEIGHT)]
    for x, y, z in points:
        r = math.hypot(x, z)
        if r < 1e-9:
            continue
        hi = min(NHEIGHT - 1, max(0, int(y * NHEIGHT)))
        ti = int((math.atan2(z, x) + math.pi) / (2 * math.pi) * NTHETA) % NTHETA
        if r > grid[hi][ti]:
            grid[hi][ti] = r
    for _ in range(8):
        holes = 0
        for a in range(NHEIGHT):
            for b in range(NTHETA):
                if grid[a][b] > 0:
                    continue
                vals = [
                    grid[a2][b2 % NTHETA]
                    for a2, b2 in ((a - 1, b), (a + 1, b), (a, b - 1), (a, b + 1))
                    if 0 <= a2 < NHEIGHT and grid[a2][b2 % NTHETA] > 0
                ]
                if vals:
                    grid[a][b] = sum(vals) / len(vals)
                else:
                    holes += 1
        if not holes:
            break
    assert all(v > 0 for row in grid for v in row), "radius field still has holes"
    return gaussian(grid)


model_tris = smd_triangles(BODY_SMD)
model_pts = [v for t in model_tris for v in t]
to_model, model_frame = normalise(model_pts)

# Subsample each triangle so the bins fill evenly, not just at the corners.
dense = []
for tri in model_tris:
    a, b, c = (to_model(v) for v in tri)
    for i in range(TRI_SAMPLES + 1):
        for j in range(TRI_SAMPLES + 1 - i):
            u, v = i / TRI_SAMPLES, j / TRI_SAMPLES
            w = 1 - u - v
            dense.append(tuple(a[k] * w + b[k] * u + c[k] * v for k in range(3)))

blob = CAGE_BIN.read_bytes()
surf = struct.unpack_from(f"<{SURFACE_LEN}f", blob, SURFACE_OFFSET)
jelly_pts = [(surf[i], surf[i + 1], surf[i + 2]) for i in range(0, len(surf), 3)]
to_jelly, jelly_frame = normalise(jelly_pts)
jelly_norm = [to_jelly(p) for p in jelly_pts]

target = bins_from_points(dense)
current = bins_from_points(jelly_norm)
ratio = [
    [
        min(RATIO_MAX, max(RATIO_MIN, target[a][b] / current[a][b]))
        for b in range(NTHETA)
    ]
    for a in range(NHEIGHT)
]

# Mirror in x is theta -> pi - theta, which in bins is b -> NTHETA/2 - b - 1.
if SYMMETRY:
    mirrored = [
        [ratio[a][(NTHETA // 2 - b - 1) % NTHETA] for b in range(NTHETA)]
        for a in range(NHEIGHT)
    ]
    ratio = [
        [
            ratio[a][b] * (1 - SYMMETRY) + 0.5 * (ratio[a][b] + mirrored[a][b]) * SYMMETRY
            for b in range(NTHETA)
        ]
        for a in range(NHEIGHT)
    ]

flat = [v for row in ratio for v in row]
print(f"model  {len(model_tris)} tris, height {model_frame[3]:.2f} units")
print(f"jelly  {len(jelly_pts)} surface vertices, height {jelly_frame[3]:.4f} m")
print(f"ratio  min {min(flat):.3f}  max {max(flat):.3f}  mean {sum(flat)/len(flat):.3f}")

# Warp the jelly surface and compare it to the model, slice by slice.
warped = [(nx * sample(ratio, ny, nx, nz), ny, nz * sample(ratio, ny, nx, nz))
          for nx, ny, nz in jelly_norm]


def profile(pts):
    out = []
    for k in range(11):
        t = k / 10
        band = [abs(q[0]) for q in pts if abs(q[1] - t) < 0.05 and abs(q[2]) < 0.18]
        out.append(max(band) if band else 0.0)
    return out


mp = profile(dense)
wp = profile(warped)
print("half width by height   model / warped")
for k in range(11):
    print(f"  h {k/10:.1f}   {mp[k]:.3f} / {wp[k]:.3f}   {'#' * int(wp[k] * 50)}")
err = max(abs(mp[k] - wp[k]) for k in range(1, 10))
print(f"worst slice error away from the poles: {err:.3f}")

lo = [min(q[i] for q in warped) for i in range(3)]
hi = [max(q[i] for q in warped) for i in range(3)]
norm = [round(hi[0] - lo[0], 6), round(hi[1] - lo[1], 6), round(hi[2] - lo[2], 6)]
print(f"post-warp normalised extents {norm}   w/h {norm[0]/norm[1]:.2f}  d/w {norm[2]/norm[0]:.2f}")

# Where the model puts its own face, as fractions of the body.
eyes = smd_triangles(EYES_SMD)
mouth = smd_triangles(MOUTH_SMD)
for nm, tris in (("eyes", eyes), ("mouth", mouth)):
    q = [to_model(v) for t in tris for v in t]
    print(f"  {nm:5} centre_y {sum(a[1] for a in q)/len(q):.3f} of height   "
          f"one side centred {sum(a[0] for a in q if a[0] > 0)/max(1, len([a for a in q if a[0] > 0])):.3f}")

(ROOT / "shape_table.json").write_text(
    json.dumps(
        {
            "ntheta": NTHETA,
            "nheight": NHEIGHT,
            "origin": [round(v, 8) for v in jelly_frame[:3]],
            "height": round(jelly_frame[3], 8),
            "norm": norm,
            "ratio": [round(v, 4) for v in flat],
        }
    )
)
print(f"shape_table.json  {NTHETA}x{NHEIGHT} = {len(flat)} entries")
