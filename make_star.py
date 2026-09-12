#!/usr/bin/env python3
"""Write engine/public/star.png : the chunky shiny sparkle, drawn as pixels.

The fill is hand-plotted; the outline is derived from it, so the shape stays a
single source of truth.
"""
import pathlib
import struct
import zlib

ROOT = pathlib.Path(__file__).parent
OUT = ROOT / "engine/public/star.png"

FILL = (0xF8, 0xDE, 0x74)
CORE = (0xFF, 0xF4, 0xC0)
EDGE = (0xD8, 0x9C, 0x34)

SHAPE = [
    "....X....",
    "....X....",
    "...XXX...",
    "XXXXXXXXX",
    ".XXXXXXX.",
    "..XXXXX..",
    "..XX.XX..",
    ".XX...XX.",
    ".X.....X.",
]
W = H = len(SHAPE)
solid = [[c == "X" for c in row] for row in SHAPE]

px = [[(0, 0, 0, 0)] * W for _ in range(H)]
for y in range(H):
    for x in range(W):
        if solid[y][x]:
            px[y][x] = FILL + (255,)
# a lighter core reads as the glint
for y, x in ((3, 4), (4, 4), (3, 3), (2, 4)):
    if solid[y][x]:
        px[y][x] = CORE + (255,)
# outline: any empty pixel touching the shape
for y in range(H):
    for x in range(W):
        if solid[y][x]:
            continue
        if any(0 <= y + dy < H and 0 <= x + dx < W and solid[y + dy][x + dx]
               for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1))):
            px[y][x] = EDGE + (255,)

rows = [b"\x00" + bytes(v for p in row for v in p) for row in px]


def chunk(tag, data):
    body = tag + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


OUT.write_bytes(
    b"\x89PNG\r\n\x1a\n"
    + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
    + chunk(b"IEND", b"")
)
print(f"{OUT.name}: {W}x{H} RGBA, {OUT.stat().st_size} bytes")
