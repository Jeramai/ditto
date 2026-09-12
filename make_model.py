#!/usr/bin/env python3
"""Bake the real Pokemon X/Y Ditto mesh into the soft-body asset.

The shipped asset is a tetrahedral cage with a render surface bound to it by
barycentric weights; the surface is rebuilt from the cage every frame. So the
mesh can be swapped without touching the solver: morph the cage onto Ditto's
volume (the slice field from make_shape.py), place the model mesh inside it,
bind every vertex to its containing tet, and regenerate the per-vertex arrays
the kernel reads. Writes assets/ditto-model.bin and ditto-model.json.
"""
import json
import math
import pathlib
import struct
from collections import Counter
import sys
import zlib

ROOT = pathlib.Path(__file__).parent
GLB_PATH = str(ROOT / "ditto2.glb")
SRC_BIN = ROOT / "original/jelly-baby.bin"
SRC_MANIFEST = ROOT / "original/manifest.json"
OUT_BIN = ROOT / "assets/ditto-model.bin"
OUT_MANIFEST = ROOT / "ditto-model.json"

SCALE = 0.58            # the whole animal
PAL_TONGUE, PAL_BODY, PAL_SHADE, PAL_MOUTH = 0, 1, 2, 3
SUBDIVIDE = 1           # Loop subdivision levels on the 3564-tri rip
MODEL_W, MODEL_D = 1.312, 0.982   # the model's own normalised extents, for the residual fix
def read_indexed_png(path):
    """Decode the model's own 2-bit palette texture. Only the format that file
    actually uses: 8-bit palette indices packed 4 to a byte, no interlace."""
    import zlib
    d = pathlib.Path(path).read_bytes()
    pos, idat, plte, ihdr = 8, b"", b"", None
    while pos < len(d):
        ln = struct.unpack(">I", d[pos:pos + 4])[0]
        tag = d[pos + 4:pos + 8]
        body = d[pos + 8:pos + 8 + ln]
        if tag == b"IHDR": ihdr = struct.unpack(">IIBBBBB", body)
        elif tag == b"IDAT": idat += body
        elif tag == b"PLTE": plte = body
        pos += 12 + ln
    w, h, bit, ctype, _, _, interlace = ihdr
    assert ctype == 3 and interlace == 0, (ctype, interlace)
    raw = zlib.decompress(idat)
    per = 8 // bit
    stride = (w + per - 1) // per
    mask = (1 << bit) - 1
    rows, o, prev = [], 0, bytearray(stride)
    for _y in range(h):
        f = raw[o]; o += 1
        line = bytearray(raw[o:o + stride]); o += stride
        if f == 1:
            for i in range(1, stride): line[i] = (line[i] + line[i - 1]) & 255
        elif f == 2:
            for i in range(stride): line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - 1] if i else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - 1] if i else 0
                b2 = prev[i]; c = prev[i - 1] if i else 0
                pp = a + b2 - c
                pa, pb, pc = abs(pp - a), abs(pp - b2), abs(pp - c)
                pr = a if (pa <= pb and pa <= pc) else (b2 if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        rows.append([(line[x // per] >> (8 - bit * (x % per + 1))) & mask for x in range(w)])
        prev = line
    pal = [tuple(plte[i * 3:i * 3 + 3]) for i in range(len(plte) // 3)]
    return w, h, pal, rows


def glb_load(path, mesh_index, want_uv=False):
    """Return triangles [(pos[,uv]),...] for one mesh of a .glb (y-up)."""
    b = pathlib.Path(path).read_bytes()
    off = 12
    clen, _ = struct.unpack("<I4s", b[off:off + 8])
    js = json.loads(b[off + 8:off + 8 + clen])
    binc = b[off + 8 + clen + 8:]
    acc = js["accessors"]; bv = js["bufferViews"]

    def ra(i):
        a = acc[i]; view = bv[a["bufferView"]]
        o = view.get("byteOffset", 0) + a.get("byteOffset", 0)
        ct = {5126: "f", 5123: "H", 5125: "I"}[a["componentType"]]
        nc = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]]
        stride = view.get("byteStride") or (struct.calcsize(ct) * nc)
        return [struct.unpack_from("<" + ct * nc, binc, o + k * stride) for k in range(a["count"])]

    m = js["meshes"][mesh_index]["primitives"][0]
    pos = ra(m["attributes"]["POSITION"])
    uv = ra(m["attributes"]["TEXCOORD_0"]) if want_uv and "TEXCOORD_0" in m["attributes"] else None
    idx = [v[0] for v in ra(m["indices"])] if "indices" in m else list(range(len(pos)))
    tris = []
    for t in range(0, len(idx), 3):
        if want_uv:
            tris.append([(pos[idx[t + j]], uv[idx[t + j]] if uv else (0.0, 0.0)) for j in range(3)])
        else:
            tris.append([pos[idx[t + j]] for j in range(3)])
    return tris

def weld(tris, tol=1e-3, payload=None, kept=None):
    index, verts, faces = {}, [], []
    for ti, tri in enumerate(tris):
        f = []
        for p in tri:
            key = tuple(round(c / tol) for c in p)
            if key not in index:
                index[key] = len(verts)
                verts.append(list(p))
            f.append(index[key])
        if len(set(f)) == 3:
            faces.append(f)
            if kept is not None and payload is not None:
                kept.append(payload[ti])
    return verts, faces


def fill_holes(verts, faces):
    """Cap boundary loops. The X/Y body mesh has the mouth cut out of it (a
    24-edge hole on the front); baked alone that reads as a dark pocket. Chain
    the once-used edges into loops and fan each from a centroid pushed out
    along the loop's mean normal, so the cap matches the surrounding bulge."""
    import collections
    count = collections.Counter()
    for a, b, c in faces:
        for u, v in ((a, b), (b, c), (c, a)):
            count[(min(u, v), max(u, v))] += 1
    # Directed boundary edges, oriented as the face used them (once).
    nxt = {}
    for a, b, c in faces:
        for u, v in ((a, b), (b, c), (c, a)):
            if count[(min(u, v), max(u, v))] == 1:
                nxt[u] = v
    loops, seen = [], set()
    for start in list(nxt):
        if start in seen:
            continue
        loop, u = [], start
        while u in nxt and u not in seen:
            seen.add(u); loop.append(u); u = nxt[u]
        if len(loop) >= 3:
            loops.append(loop)
    def cross(a, b):
        return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

    for loop in loops:
        # Ear-clip in the loop's best-fit plane. No centroid apex vertex, so the
        # later Taubin smoothing has no high-valence singularity to fight -- that
        # apex was what left a ridge around the filled mouth cutout.
        nrm = [0.0, 0.0, 0.0]                       # Newell normal
        for i in range(len(loop)):
            a, b = verts[loop[i]], verts[loop[(i + 1) % len(loop)]]
            nrm[0] += (a[1] - b[1]) * (a[2] + b[2])
            nrm[1] += (a[2] - b[2]) * (a[0] + b[0])
            nrm[2] += (a[0] - b[0]) * (a[1] + b[1])
        nl = math.sqrt(sum(c * c for c in nrm)) or 1.0
        nrm = [c / nl for c in nrm]
        # Two in-plane axes.
        ref = [1.0, 0.0, 0.0] if abs(nrm[0]) < 0.9 else [0.0, 1.0, 0.0]
        u = cross(nrm, ref)
        ul = math.sqrt(sum(c * c for c in u)) or 1.0
        u = [c / ul for c in u]
        w = cross(nrm, u)
        p2 = {i: (sum(verts[i][k] * u[k] for k in range(3)),
                  sum(verts[i][k] * w[k] for k in range(3))) for i in loop}
        # Ensure counter-clockwise in 2D.
        area = sum(p2[loop[i]][0] * p2[loop[(i + 1) % len(loop)]][1]
                   - p2[loop[(i + 1) % len(loop)]][0] * p2[loop[i]][1]
                   for i in range(len(loop)))
        poly = loop[:] if area > 0 else loop[::-1]

        def tri_area2(a, b, c):
            return (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])

        def in_tri(pt, a, b, c):
            d1 = tri_area2(pt, a, b); d2 = tri_area2(pt, b, c); d3 = tri_area2(pt, c, a)
            return not ((d1 < 0 or d2 < 0 or d3 < 0) and (d1 > 0 or d2 > 0 or d3 > 0))

        idx = poly[:]
        guard = 0
        while len(idx) > 3 and guard < 10000:
            guard += 1
            for j in range(len(idx)):
                a, b, c = idx[j - 1], idx[j], idx[(j + 1) % len(idx)]
                if tri_area2(p2[a], p2[b], p2[c]) <= 0:
                    continue                       # reflex
                if any(in_tri(p2[k], p2[a], p2[b], p2[c])
                       for k in idx if k not in (a, b, c)):
                    continue                       # not an ear
                faces.append([a, b, c])
                del idx[j]
                break
            else:
                faces.append([idx[0], idx[1], idx[2]])   # degenerate fallback
                del idx[1]
        if len(idx) == 3:
            faces.append([idx[0], idx[1], idx[2]])
    print(f"filled {len(loops)} hole(s) by ear-clipping: {[len(l) for l in loops]} edges")
    return verts, faces, loops


def loop_subdivide(verts, faces, payload=None):
    """One level of Loop subdivision: smooths the low-poly rip as it refines it."""
    edge_faces, adjacency = {}, {}
    for fi, (a, b, c) in enumerate(faces):
        for u, v in ((a, b), (b, c), (c, a)):
            edge_faces.setdefault((min(u, v), max(u, v)), []).append(fi)
            adjacency.setdefault(u, set()).add(v)
            adjacency.setdefault(v, set()).add(u)
    new_verts = []
    for vi, p in enumerate(verts):
        nb = adjacency.get(vi, ())
        n = len(nb)
        if n < 3:
            new_verts.append(list(p)); continue
        beta = (5 / 8 - (3 / 8 + math.cos(2 * math.pi / n) / 4) ** 2) / n
        q = [p[k] * (1 - n * beta) for k in range(3)]
        for u in nb:
            for k in range(3):
                q[k] += verts[u][k] * beta
        new_verts.append(q)
    mid = {}
    for (u, v), fs in edge_faces.items():
        opp = []
        for fi in fs:
            opp += [w for w in faces[fi] if w not in (u, v)]
        if len(fs) == 2 and len(opp) == 2:
            q = [(verts[u][k] + verts[v][k]) * 3 / 8 + (verts[opp[0]][k] + verts[opp[1]][k]) / 8 for k in range(3)]
        else:
            q = [(verts[u][k] + verts[v][k]) / 2 for k in range(3)]
        mid[(u, v)] = len(new_verts)
        new_verts.append(q)
    new_faces, new_pay = [], []
    for fi, (a, b, c) in enumerate(faces):
        ab, bc, ca = mid[(min(a, b), max(a, b))], mid[(min(b, c), max(b, c))], mid[(min(c, a), max(c, a))]
        new_faces += [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]]
        if payload is not None:
            new_pay += [payload[fi]] * 4
    return (new_verts, new_faces, new_pay) if payload is not None else (new_verts, new_faces)


def vertex_normals(verts, faces):
    acc = [[0.0, 0.0, 0.0] for _ in verts]
    for a, b, c in faces:
        pa, pb, pc = verts[a], verts[b], verts[c]
        u = [pb[k] - pa[k] for k in range(3)]
        v = [pc[k] - pa[k] for k in range(3)]
        nrm = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
        for i in (a, b, c):
            for k in range(3):
                acc[i][k] += nrm[k]
    out = []
    for nrm in acc:
        l = math.sqrt(sum(c * c for c in nrm)) or 1.0
        out.append([c / l for c in nrm])
    return out


# --- the slice morph, exactly as the runtime applies it -----------------------
SHAPE = json.loads((ROOT / "shape_table.json").read_text())
NT, NH = SHAPE["ntheta"], SHAPE["nheight"]
RATIO = [SHAPE["ratio"][a * NT:(a + 1) * NT] for a in range(NH)]
CX, CY, CZ = SHAPE["origin"]
H = SHAPE["height"]
NW, NHGT, ND = SHAPE["norm"]
SX, SY, SZ = MODEL_W / (NW / NHGT), 1.0 / NHGT, MODEL_D / (ND / NHGT)


def catmull(p0, p1, p2, p3, t):
    return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)))


def sample(t, x, z):
    fa = t * NH - 0.5
    fb = (math.atan2(z, x) + math.pi) / (2 * math.pi) * NT - 0.5
    a1, b1 = math.floor(fa), math.floor(fb)
    ta, tb = fa - a1, fb - b1

    def row(a):
        g = RATIO[min(NH - 1, max(0, a))]
        return catmull(*(g[(b1 + i) % NT] for i in (-1, 0, 1, 2)), tb)

    return catmull(row(a1 - 1), row(a1), row(a1 + 1), row(a1 + 2), ta)


import os as _os2
# The cage is a smoothed radius field, so its arm bulges are softer than the
# model's. Inflate it horizontally (never vertically, or Ditto hovers) so the
# cage fully contains the arms: every surface vertex then binds inside a tet.
CAGE_INFLATE = float(_os2.environ.get("CAGE_INFLATE", "1.0"))


TOP_LIFT = float(_os2.environ.get("TOP_LIFT", "0.0"))


def morph(x, y, z):
    dx, dy, dz = x - CX, y - CY, z - CZ
    f = sample(dy / H, dx, dz) * CAGE_INFLATE
    # Lift only the cage roof: Ditto's top bumps sit above the smoothed cage, so
    # their verts fall outside every tet. The bottom stays put, or he hovers.
    fy = 1.0
    if dy > 0:
        fy = 1.0 + TOP_LIFT * min(1.0, dy / (H * 0.5))
    return (CX + dx * f * SX * SCALE, CY + dy * fy * SY * SCALE, CZ + dz * f * SZ * SCALE)


MODEL_FIT = float(_os2.environ.get("MODEL_FIT", "1.0"))


def place(nx, ny, nz):
    """A point in the model's normalised frame, into the morphed cage's metres."""
    # Shrink toward the base and the axis, so the model sits inside the cage
    # without lifting off the floor.
    nx, ny, nz = nx * MODEL_FIT, ny * MODEL_FIT, nz * MODEL_FIT
    return (CX + nx * H * SX * SCALE, CY + ny * H * SY * SCALE, CZ + nz * H * SZ * SCALE)


# --- load the shipped asset ---------------------------------------------------
man = json.loads(SRC_MANIFEST.read_text())
blob = SRC_BIN.read_bytes()
TYPES = {"Float32Array": ("f", 4), "Float64Array": ("d", 8),
         "Uint32Array": ("I", 4), "Uint16Array": ("H", 2)}


def arr(name):
    lay = man["layout"][name]
    code, size = TYPES[lay["type"]]
    return list(struct.unpack_from(f"<{lay['length']}{code}", blob, lay["offset"]))


particles = arr("particles")
tets = arr("tets")
volumes = arr("volumes")

# Morph the cage and rescale each tet's rest volume by its Jacobian ratio.
def det(p, t):
    i, j, k, l = (t[q] * 3 for q in range(4))
    a = [p[j + q] - p[i + q] for q in range(3)]
    b = [p[k + q] - p[i + q] for q in range(3)]
    c = [p[l + q] - p[i + q] for q in range(3)]
    return a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])


tet_list = [tets[i:i + 4] for i in range(0, len(tets), 4)]
before = [det(particles, t) for t in tet_list]
cage = []
for i in range(0, len(particles), 3):
    cage += morph(*particles[i:i + 3])
new_volumes = []
for t, v, b in zip(tet_list, volumes, before):
    r = det(cage, t) / b
    if r <= 1e-6:
        sys.exit("the morph inverted a tetrahedron")
    new_volumes.append(v * r)
# --- the model mesh, placed inside the morphed cage ----------------------------
_uv_tris = glb_load(GLB_PATH, 2, want_uv=True)            # Object_2 = body, y-up
_tw, _th, PALETTE, _rows = read_indexed_png(str(ROOT / "assets/ditto-skin.png"))

def _palette_at(uv):
    # glTF puts v=0 at the top of the image, so no flip here. With the flip the
    # lip and the tongue swap: dark red sits on rows 0-3 and pink on rows 59-61.
    x = min(_tw - 1, max(0, int(uv[0] * _tw)))
    y = min(_th - 1, max(0, int(uv[1] * _th)))
    return _rows[y][x]

# The skin is a 64x64 colour-ID table, not a picture: one texel per triangle,
# picking one of four flat colours. So the colour is an exact per-face property,
# and carrying it through the mesh pipeline beats resampling UVs, which cannot
# survive the weld.
_face_pal = [Counter(_palette_at(c[1]) for c in t).most_common(1)[0][0] for t in _uv_tris]
tris = [[c[0] for c in t] for t in _uv_tris]
face_pal = []
verts, faces = weld(tris, payload=_face_pal, kept=face_pal)
verts, faces, HOLE_LOOPS = fill_holes(verts, faces)      # the two eye sockets
face_pal += [PAL_BODY] * (len(faces) - len(face_pal))
lo = [min(v[i] for v in verts) for i in range(3)]
hi = [max(v[i] for v in verts) for i in range(3)]
mh = hi[1] - lo[1]
mcx, mcz = (lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2

def _nrm(p):
    return [(p[0] - mcx) / mh, (p[1] - lo[1]) / mh, (p[2] - mcz) / mh]

verts = [_nrm(v) for v in verts]
for _ in range(SUBDIVIDE):
    verts, faces, face_pal = loop_subdivide(verts, faces, face_pal)

# Smooth the two filled eye sockets so no crease shows around the eye discs.
# Keep it to the cap and its first two rings: a whole front-face band also
# covers the mouth, and eight Taubin passes round the lip overhang off until it
# closes over the tongue.
_adj = {}
for _a, _b, _c in faces:
    for _u, _v in ((_a, _b), (_b, _c), (_c, _a)):
        _adj.setdefault(_u, set()).add(_v); _adj.setdefault(_v, set()).add(_u)
_band = {i for loop in HOLE_LOOPS for i in loop}
for _ in range(2):
    _band |= {k for i in list(_band) for k in _adj.get(i, ())}
_band = sorted(_band)
for _ in range(8):
    for fac in (0.5, -0.53):
        mv = {}
        for i in _band:
            nb = _adj.get(i, ())
            if nb:
                av = [sum(verts[k][d] for k in nb)/len(nb) for d in range(3)]
                mv[i] = [verts[i][d] + fac*(av[d]-verts[i][d]) for d in range(3)]
        for i, q in mv.items(): verts[i] = q

# Light whole-body Taubin so sharp nub tips are rounded enough to sit inside
# the cage tets (a too-sharp tip pokes into a concave dip and binds badly).
_gadj = {}
for _a, _b, _c in faces:
    for _u, _v in ((_a, _b), (_b, _c), (_c, _a)):
        _gadj.setdefault(_u, set()).add(_v); _gadj.setdefault(_v, set()).add(_u)
for _ in range(2):
    for _fac in (0.5, -0.53):
        _mv = {}
        for i in range(len(verts)):
            nb = _gadj.get(i, ())
            if nb:
                av = [sum(verts[k][d] for k in nb)/len(nb) for d in range(3)]
                _mv[i] = [verts[i][d] + _fac*(av[d]-verts[i][d]) for d in range(3)]
        for i, q in _mv.items(): verts[i] = q

norm_pts = verts
verts = [list(place(*v)) for v in verts]

# Bake the model's OWN eye meshes (Object_0, Object_1) into the surface, bound
# to the cage. faceTag marks them so the material paints them dark.
faceTag = [0.0] * len(verts)

# One colour per vertex, so a vertex on a boundary is duplicated per colour and
# shares the original's cage binding. Undivided it would bleed a half edge into
# the body around the whole mouth.
_RANK = {PAL_BODY: 0, PAL_SHADE: 0, PAL_TONGUE: 1, PAL_MOUTH: 2}
_face_tag = [_RANK[p] for p in face_pal]

mouthTag = [0.0] * len(verts)
normal_twin = []
_owner = {}
for _fi, _tri in enumerate(faces):
    _r = _face_tag[_fi]
    for _k, _v in enumerate(_tri):
        _m = _owner.setdefault(_v, {})
        if _r not in _m:
            if not _m:
                _m[_r] = _v
            else:
                verts.append(list(verts[_v])); norm_pts.append(list(norm_pts[_v]))
                faceTag.append(faceTag[_v]); mouthTag.append(0.0)
                normal_twin += [len(verts) - 1, _v]
                _m[_r] = len(verts) - 1
        _tri[_k] = _m[_r]
        mouthTag[_m[_r]] = float(_r)
print(f"mouth: {mouthTag.count(2.0)} lip + {mouthTag.count(1.0)} tongue verts, "
      f"{len(normal_twin) // 2} split for crisp edges")
for _mi in (0, 1):
    for tri in glb_load(GLB_PATH, _mi):
        base = len(verts)
        for pos in tri:
            verts.append(list(place(*_nrm(pos))))
            faceTag.append(1.0); mouthTag.append(0.0)
        faces.append([base, base + 1, base + 2])
print(f"model face: {faceTag.count(1.0)} eye verts baked")

import os as _os
# Shrink horizontally toward the vertical axis so the model's pointy arm tips
# sit inside the smoother cage; otherwise they poke out, get clamped sideways
# and pinch into a spike (and grab wrong).
FIT_XZ = float(_os.environ.get("FIT_XZ", "1.0"))
_axc = sum(v[0] for v in verts) / len(verts)
_azc = sum(v[2] for v in verts) / len(verts)
if FIT_XZ != 1.0:
    verts = [[_axc + (v[0]-_axc)*FIT_XZ, v[1], _azc + (v[2]-_azc)*FIT_XZ] for v in verts]

CAGE_FROM_MODEL = _os2.environ.get("CAGE_FROM_MODEL", "1") == "1"
# Tet count scales as 1/cell^3 and the solver cost scales with it. 5.6mm keeps
# every surface vertex bound with zero movement while halving the tets, which
# is what made this playable on a phone.
CAGE_CELL = float(_os2.environ.get("CAGE_CELL", "0.0056"))
CAGE_GROW = float(_os2.environ.get("CAGE_GROW", "1.08"))


def build_model_cage(surf_verts, surf_faces):
    """A lattice tet cage of the model's own (slightly grown) volume."""
    cxx = (min(v[0] for v in surf_verts) + max(v[0] for v in surf_verts)) / 2
    czz = (min(v[2] for v in surf_verts) + max(v[2] for v in surf_verts)) / 2
    ybase = min(v[1] for v in surf_verts)
    grown = [[cxx + (v[0]-cxx)*CAGE_GROW, ybase + (v[1]-ybase)*CAGE_GROW,
              czz + (v[2]-czz)*CAGE_GROW] for v in surf_verts]
    tris = [(grown[a], grown[b], grown[c]) for a, b, c in surf_faces]

    # bucket triangles by their y-z box so a +x ray tests only a few
    buck = {}
    bs = CAGE_CELL * 2
    for ti, (A, B, C) in enumerate(tris):
        y0 = min(A[1], B[1], C[1]); y1 = max(A[1], B[1], C[1])
        z0 = min(A[2], B[2], C[2]); z1 = max(A[2], B[2], C[2])
        for gy in range(int(math.floor(y0/bs)), int(math.floor(y1/bs))+1):
            for gz in range(int(math.floor(z0/bs)), int(math.floor(z1/bs))+1):
                buck.setdefault((gy, gz), []).append(ti)

    def inside(p):
        hits = 0
        for ti in buck.get((int(math.floor(p[1]/bs)), int(math.floor(p[2]/bs))), ()):
            A, B, C = tris[ti]
            # ray along +x from p, in the y-z plane use barycentric of the
            # projected triangle
            d1 = (B[1]-A[1], B[2]-A[2]); d2 = (C[1]-A[1], C[2]-A[2])
            den = d1[0]*d2[1] - d1[1]*d2[0]
            if abs(den) < 1e-18:
                continue
            r = (p[1]-A[1], p[2]-A[2])
            u = (r[0]*d2[1] - r[1]*d2[0]) / den
            v = (d1[0]*r[1] - d1[1]*r[0]) / den
            if u < 0 or v < 0 or u + v > 1:
                continue
            if A[0] + u*(B[0]-A[0]) + v*(C[0]-A[0]) > p[0]:
                hits += 1
        return hits % 2 == 1

    lo = [min(v[i] for v in grown) for i in range(3)]
    hi = [max(v[i] for v in grown) for i in range(3)]
    n = [int(math.ceil((hi[i]-lo[i])/CAGE_CELL)) + 1 for i in range(3)]
    org = [lo[i] - CAGE_CELL*0.5 for i in range(3)]

    def node_pos(g):
        return [org[i] + g[i]*CAGE_CELL for i in range(3)]

    ins = {}
    for gx in range(n[0]+1):
        for gy in range(n[1]+1):
            for gz in range(n[2]+1):
                g = (gx, gy, gz)
                ins[g] = inside(node_pos(g))

    CORN = [(0,0,0),(1,0,0),(1,1,0),(0,1,0),(0,0,1),(1,0,1),(1,1,1),(0,1,1)]
    KUHN = [(0,1,2,6),(0,2,3,6),(0,3,7,6),(0,7,4,6),(0,4,5,6),(0,5,1,6)]
    idx, pts, tets = {}, [], []
    for gx in range(n[0]):
        for gy in range(n[1]):
            for gz in range(n[2]):
                corners = [(gx+c[0], gy+c[1], gz+c[2]) for c in CORN]
                if not any(ins[c] for c in corners):
                    ctr = [org[i] + ((gx, gy, gz)[i]+0.5)*CAGE_CELL for i in range(3)]
                    if not inside(ctr):
                        continue
                ids = []
                for c in corners:
                    if c not in idx:
                        idx[c] = len(pts); pts.append(node_pos(c))
                    ids.append(idx[c])
                for t in KUHN:
                    tets.append([ids[t[0]], ids[t[1]], ids[t[2]], ids[t[3]]])
    flat = [c for p in pts for c in p]
    for t in tets:
        if det(flat, t) < 0:
            t[1], t[2] = t[2], t[1]
    vols = [abs(det(flat, t)) / 6 for t in tets]
    print(f"model cage: {len(pts)} nodes, {len(tets)} tets, cell {CAGE_CELL*1000:.1f} mm, "
          f"grow {CAGE_GROW}")
    return flat, tets, vols


if CAGE_FROM_MODEL:
    cage, tet_list, new_volumes = build_model_cage(verts, faces)

# --- bind every vertex to a tet of the morphed cage -----------------------------
def bary(p, t):
    i, j, k, l = (t[q] * 3 for q in range(4))
    a = [cage[i], cage[i + 1], cage[i + 2]]
    m = [[cage[j + q] - a[q], cage[k + q] - a[q], cage[l + q] - a[q]] for q in range(3)]
    d = [p[q] - a[q] for q in range(3)]
    D = (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
         - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
         + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]))
    if abs(D) < 1e-18:
        return None
    def solve(col):
        mm = [row[:] for row in m]
        for q in range(3):
            mm[q][col] = d[q]
        return (mm[0][0] * (mm[1][1] * mm[2][2] - mm[1][2] * mm[2][1])
                - mm[0][1] * (mm[1][0] * mm[2][2] - mm[1][2] * mm[2][0])
                + mm[0][2] * (mm[1][0] * mm[2][1] - mm[1][1] * mm[2][0])) / D
    w1, w2, w3 = solve(0), solve(1), solve(2)
    return [1 - w1 - w2 - w3, w1, w2, w3]


# Grid of tet bounding boxes for candidate lookup.
cell = 0.004
tet_bbox = []
grid = {}
for ti, t in enumerate(tet_list):
    xs = [cage[t[q] * 3] for q in range(4)]
    ys = [cage[t[q] * 3 + 1] for q in range(4)]
    zs = [cage[t[q] * 3 + 2] for q in range(4)]
    bb = (min(xs), min(ys), min(zs), max(xs), max(ys), max(zs))
    tet_bbox.append(bb)
    for gx in range(int(math.floor(bb[0] / cell)), int(math.floor(bb[3] / cell)) + 1):
        for gy in range(int(math.floor(bb[1] / cell)), int(math.floor(bb[4] / cell)) + 1):
            for gz in range(int(math.floor(bb[2] / cell)), int(math.floor(bb[5] / cell)) + 1):
                grid.setdefault((gx, gy, gz), []).append(ti)

binding_ids, binding_w = [], []
outside, worst, moved = 0, 0.0, 0.0
clamped = set()
vi_counter = [0]
tet_centres = [[sum(cage[t[q] * 3 + k] for q in range(4)) / 4 for k in range(3)] for t in tet_list]
for vi_counter[0], p in enumerate(list(verts)):
    key = tuple(int(math.floor(p[k] / cell)) for k in range(3))
    cands = set()
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                cands.update(grid.get((key[0] + dx, key[1] + dy, key[2] + dz), ()))
    if not cands:
        cands = range(len(tet_list))
    best = None
    for ti in cands:
        w = bary(p, tet_list[ti])
        if w is None:
            continue
        score = min(w)
        if best is None or score > best[0]:
            best = (score, ti, w)
    if best is None or best[0] < -0.5:
        # Far outside every candidate: fall back to the nearest tet centre.
        ti = min(range(len(tet_list)), key=lambda q: sum((tet_centres[q][k] - p[k]) ** 2 for k in range(3)))
        best = (min(bary(p, tet_list[ti])), ti, bary(p, tet_list[ti]))
    score, ti, w = best
    # A vertex outside its tet gets extrapolated (negative) weights. The kernel
    # and the grab-consistency check treat those differently, so under
    # deformation they drift apart and the grab throws. Clamp to convex weights
    # inside the tet and snap the vertex onto that point, so every binding is a
    # true interpolation that both sides reconstruct identically.
    if score < 1e-4:
        outside += 1
        worst = min(worst, score)
        # Convex weights keep the vertex a true interpolation, so it stays
        # stable when the cage deforms; extrapolated weights shoot outward into
        # a blade. Pick the tet whose clamped point is nearest the vertex, so
        # the shape moves as little as possible.
        search = set(cands)
        for rad in (2, 3):
            if len(search) > 400:
                break
            for dx in range(-rad, rad + 1):
                for dy in range(-rad, rad + 1):
                    for dz in range(-rad, rad + 1):
                        search.update(grid.get((key[0] + dx, key[1] + dy, key[2] + dz), ()))
        pick = None
        for ti2 in search:
            w2 = bary(p, tet_list[ti2])
            if w2 is None:
                continue
            wc = [max(0.0, x) for x in w2]
            tot = sum(wc)
            if tot <= 0:
                continue
            wc = [x / tot for x in wc]
            t2 = tet_list[ti2]
            q = [sum(cage[t2[k] * 3 + d] * wc[k] for k in range(4)) for d in range(3)]
            dist = sum((q[d] - p[d]) ** 2 for d in range(3))
            if pick is None or dist < pick[0]:
                pick = (dist, ti2, wc, q)
        if pick is not None:
            _, ti, w, q = pick
            verts[vi_counter[0]] = q
            moved = max(moved, pick[0] ** 0.5)
        clamped.add(vi_counter[0])
    binding_ids += tet_list[ti]
    binding_w += w
print(f"binding: {len(verts)} vertices, {outside} clamped (worst weight {worst:.3f}, max move {moved*1000:.2f} mm)")
_cl=sorted(clamped)
_y0=min(v[1] for v in verts); _hh=max(v[1] for v in verts)-_y0
_xc=sum(v[0] for v in verts)/len(verts); _zc=sum(v[2] for v in verts)/len(verts)
import math as _m
_bands={}
for i in _cl:
    v=verts[i]; h=(v[1]-_y0)/_hh
    ang=_m.degrees(_m.atan2(v[2]-_zc, v[0]-_xc))%360
    r=_m.hypot(v[0]-_xc, v[2]-_zc)
    _bands.setdefault(round(h*10)/10, []).append((round(ang), round(r*1000,1), 1 if faceTag[i]>0 else 0))
for k in sorted(_bands):
    lst=_bands[k]; eyes=sum(1 for e in lst if e[2])
    angs=sorted(set(e[0]//30*30 for e in lst))
    print(f"  height {k:.1f}: {len(lst)} clamped, eyeverts={eyes}, angle-sectors={angs}")

# A few clamped verts moved, so recompute normals after binding.
touched = clamped
normals = vertex_normals(verts, faces)
_adj = {}
for a, b, c in faces:
    for u, v in ((a, b), (b, c), (c, a)):
        _adj.setdefault(u, set()).add(v)
        _adj.setdefault(v, set()).add(u)
_ring = set(touched)
for _ in range(2):
    _ring |= {k for i in list(_ring) for k in _adj.get(i, set())}
for _ in range(14):
    upd = {}
    for i in _ring:
        nb = _adj.get(i, ())
        if not nb:
            continue
        acc = [normals[i][d] + sum(normals[k][d] for k in nb) for d in range(3)]
        ln = math.sqrt(sum(c * c for c in acc)) or 1.0
        upd[i] = [c / ln for c in acc]
    for i, q in upd.items():
        normals[i] = q
print(f"smoothed normals over {len(_ring)} verts around the seam")

# --- contacts, and the inert thickness lookup ---------------------------------
# The solver only keeps the vertices in this list above the floor, so a
# bottom-band list lets Ditto sink through the ground whenever he lands on his
# top. Sample the whole surface on a fixed grid instead: every side gets
# contacts, at about the density the shipped bottom band had.
CONTACT_CELL = 0.0022
_buckets = {}
for i, v in enumerate(verts):
    key = tuple(int(math.floor(v[k] / CONTACT_CELL)) for k in range(3))
    _buckets.setdefault(key, i)
contacts = sorted(_buckets.values())
print(f"contacts: {len(contacts)} vertices over the whole surface "
      f"({CONTACT_CELL * 1000:.1f} mm grid)")
# --- write the asset ---------------------------------------------------------
# Every index here addresses either a cage node (728) or a surface vertex
# (8194), so Uint16 covers all of them with room to spare. The solver reads the
# binding weights but never writes them, and single precision is inside the
# noise of a barycentric weight.
#
# indices stays 32 bit against that rule: three.js r169 rewrites every
# non-normalized Uint16 attribute to a fresh Uint32 copy when it uploads it, so
# a narrow index buys a 185 KB conversion on top of the 92 KB it saves.
sections = [
    ("positions", "Float32Array", [c for v in verts for c in v]),
    ("normals", "Float32Array", [c for v in normals for c in v]),
    ("mouthTag", "Float32Array", mouthTag),
    ("normalTwin", "Uint16Array", normal_twin),
    ("indices", "Uint32Array", [i for f in faces for i in f]),
    ("particles", "Float64Array", cage),
    ("tets", "Uint16Array", [i for t in tet_list for i in t]),
    ("volumes", "Float64Array", new_volumes),
    ("bindingIds", "Uint16Array", binding_ids),
    ("bindingWeights", "Float32Array", binding_w),
    ("contacts", "Uint16Array", contacts),
    ("faceTag", "Float32Array", faceTag),
]
_cap = max(max(d) for n, t, d in sections if t.startswith("Uint"))
if _cap > 65535:
    sys.exit(f"an index reached {_cap}: Uint16 no longer covers the model")
out, layout = bytearray(), {}
for name, typ, data in sections:
    while len(out) % 8:
        out += b"\0"
    code, _ = TYPES[typ]
    layout[name] = {"offset": len(out), "length": len(data), "type": typ}
    out += struct.pack(f"<{len(data)}{code}", *data)
OUT_BIN.write_bytes(out)

xs = [v[0] for v in verts]; ys = [v[1] for v in verts]; zs = [v[2] for v in verts]
extents = {"half_width": (max(xs) - min(xs)) / 2, "height": max(ys) - min(ys),
           "depth": max(zs) - min(zs), "y0": min(ys)}
manifest = {**man, "layout": layout, "volume": sum(new_volumes), "extents": extents}
OUT_MANIFEST.write_text(json.dumps(manifest))
print(f"wrote {OUT_BIN.name} ({len(out)} bytes) and {OUT_MANIFEST.name}")
print(f"body: {extents['half_width']*200:.1f} cm wide, {extents['height']*100:.1f} cm tall, "
      f"{extents['depth']*100:.1f} cm deep   w/h {2*extents['half_width']/extents['height']:.2f}  "
      f"d/w {extents['depth']/(2*extents['half_width']):.2f}")
