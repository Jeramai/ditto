#!/usr/bin/env python3
"""Write engine/public/sky.exr : a small equirectangular daylight probe.

It replaces the shipped 5.9 MB nursery-room HDR. The runtime derives the sun
direction from the brightest part of this image, so the disc sits at the same
elevation and azimuth the room probe happened to give, and the lit side and the
shadow stay where they were.
"""
import math
import pathlib
import struct
import zlib
import sys

ROOT = pathlib.Path(__file__).parent
OUT = ROOT / "engine/public/sky.exr"

W, H = 256, 128
# The direction the room probe resolved to, read straight off the running app,
# so the sun and the shadow do not move. Convention is the analyser's own:
# x = cos(lat)cos(lon), y = sin(lat), z = cos(lat)sin(lon).
SUN_DIR = (-0.5865, 0.6157, 0.5262)   # 38 deg up: mid morning
SUN_ANGLE, SUN_RADIANCE, SUN_GLOW = 3.4, 620.0, 3.0
SUN_TINT = (1.0, 0.955, 0.90)         # a white disc, only faintly warm
WARM = (0.10, 0.075, 0.050)           # the horizon behind the sun
ZENITH = (0.070, 0.175, 0.455)
HORIZON = (0.450, 0.550, 0.680)
GROUND = (0.150, 0.290, 0.215)   # the sheet's mint, so the horizon has no seam
GAIN = float(sys.argv[1]) if len(sys.argv) > 1 else 1.0
_n = math.sqrt(sum(c * c for c in SUN_DIR))
SUN = tuple(c / _n for c in SUN_DIR)


def direction(px, py):
    """Pixel centre to a unit direction. EXR scanline 0 is the top row, and the
    loader hands the analyser the rows bottom-up, so file row py is array row
    H-1-py -- and the analyser reads latitude off the array row."""
    lat = (((H - 1 - py) + 0.5) / H - 0.5) * math.pi
    lon = ((px + 0.5) / W - 0.5) * 2 * math.pi
    cl = math.cos(lat)
    return (cl * math.cos(lon), math.sin(lat), cl * math.sin(lon))


def radiance(d):
    if d[1] >= 0:
        t = d[1] ** 0.55
        col = [HORIZON[k] + (ZENITH[k] - HORIZON[k]) * t for k in range(3)]
    else:
        t = min(1.0, -d[1] * 1.6)
        col = [GROUND[k] * (1 - 0.45 * t) for k in range(3)]
    cos = sum(d[k] * SUN[k] for k in range(3))
    ang = math.degrees(math.acos(max(-1.0, min(1.0, cos))))
    # a wide warm wash along the horizon behind the sun, the way a low sun
    # stains the whole sky rather than lighting one spot
    bearing = math.degrees(math.acos(max(-1.0, min(1.0,
        (d[0] * SUN[0] + d[2] * SUN[2]) /
        (math.hypot(d[0], d[2]) * math.hypot(SUN[0], SUN[2]) + 1e-9)))))
    wash = math.exp(-((bearing / 55.0) ** 2)) * math.exp(-((max(0.0, d[1]) / 0.30) ** 2))
    col = [col[k] + WARM[k] * wash for k in range(3)]
    if ang <= SUN_ANGLE:
        col = [col[k] + SUN_RADIANCE * SUN_TINT[k] for k in range(3)]
    elif ang < 55:
        glow = SUN_GLOW * math.exp(-((ang - SUN_ANGLE) / 13.0) ** 2)
        col = [col[k] + glow * SUN_TINT[k] for k in range(3)]
    return [min(65000.0, c * GAIN) for c in col]


def attr(name, kind, payload):
    return name.encode() + b"\0" + kind.encode() + b"\0" + struct.pack("<I", len(payload)) + payload


def channels(names):
    out = b""
    for nm in names:
        out += nm.encode() + b"\0" + struct.pack("<IBBBBii", 1, 0, 0, 0, 0, 1, 1)
    return out + b"\0"


def zips(raw):
    """OpenEXR's scanline filter, then deflate: split odd/even bytes, delta the
    result, compress. Uncompressed EXR was the only asset Pages could not
    shrink on the wire."""
    n = len(raw)
    half = (n + 1) // 2
    tmp = bytearray(n)
    tmp[:half] = raw[0::2]
    tmp[half:] = raw[1::2]
    prev = tmp[0]
    for i in range(1, n):
        cur = tmp[i]
        tmp[i] = (cur - prev + 384) & 0xFF
        prev = cur
    return zlib.compress(bytes(tmp), 9)


rows = []
for py in range(H):
    r, g, b = [], [], []
    for px in range(W):
        c = radiance(direction(px, py))
        r.append(c[0]); g.append(c[1]); b.append(c[2])
    # channels are written in alphabetical order: A, B, G, R
    rows.append(zips(b"".join(struct.pack("<e", 1.0) for _ in range(W))
                     + b"".join(struct.pack("<e", v) for v in b)
                     + b"".join(struct.pack("<e", v) for v in g)
                     + b"".join(struct.pack("<e", v) for v in r)))

header = struct.pack("<II", 20000630, 2)
header += attr("channels", "chlist", channels(["A", "B", "G", "R"]))
header += attr("compression", "compression", bytes([2]))          # ZIPS
header += attr("dataWindow", "box2i", struct.pack("<4i", 0, 0, W - 1, H - 1))
header += attr("displayWindow", "box2i", struct.pack("<4i", 0, 0, W - 1, H - 1))
header += attr("lineOrder", "lineOrder", bytes([0]))              # INCREASING_Y
header += attr("pixelAspectRatio", "float", struct.pack("<f", 1.0))
header += attr("screenWindowCenter", "v2f", struct.pack("<2f", 0.0, 0.0))
header += attr("screenWindowWidth", "float", struct.pack("<f", 1.0))
header += b"\0"

offset = len(header) + 8 * H
table = b""
for py in range(H):
    table += struct.pack("<Q", offset)
    offset += 8 + len(rows[py])

body = b"".join(struct.pack("<iI", py, len(rows[py])) + rows[py] for py in range(H))
OUT.write_bytes(header + table + body)
print(f"{OUT.name}: {W}x{H} half RGBA, {OUT.stat().st_size / 1024:.0f} KB, sun {SUN}, gain {GAIN}")
