#!/usr/bin/env python3
"""Draw the Gen-3 route tilesheet the floor samples.

128x128 px = 8x8 tiles of 16 px. One 16 px tile covers TILE_UNITS of world,
so the sheet repeats every 8 * TILE_UNITS. LAYOUT says which tiles carry a
tall-grass rosette; the rest is open ground with speckles. Every motif fits
inside its own tile, so the sheet repeats seamlessly and neighbouring
rosettes read as one field.
"""
import json
import pathlib
import struct
import subprocess
import sys
import zlib

TILES, TILE = 64, 16
SIZE = TILES * TILE

# BASE, BASE_DOT and GRASS_DARK are read straight out of the reference crop:
# they are the only values that survive in its flat runs, so they are the only
# ones its blur did not corrupt. The other two are interpolated from them.
# The exact tier ramp sampled from the reference crop: a mint base through five
# greens to a dark olive, and NO bright white -- the crop's "highlights" are
# just the base showing through. Using the full ramp is what makes the tufts
# read as soft and rounded instead of muddy blobs.
# The grass tuft is the user's own 16x16 sprite, extracted pixel-for-pixel from
# a clean (nearest-neighbour) source -- every colour and cell is verbatim. Each
# 6-hex token is one pixel; ".." is transparent (the mint ground shows through).
BASE = (0x84, 0xBE, 0xA2)          # reference mint ground
SPECK = (0x70, 0xC8, 0xA0)         # faint tuft-green fleck on open ground
SPECK2 = (0x6a, 0xb0, 0x90)        # a second, cooler fleck so bare ground is not flat
BLADE = (0x38, 0x90, 0x30)         # a stray blade tip on open ground
TUFT = [
    "..........................................40b088389030..........................................",
    "....................................40b088389030a0e0c0389030....................................",
    "............38903038903038903040b08840b088a0e0c0a0e0c038903040b088385810389030385810............",
    "......18a068a0e0c0a0e0c0a0e0c0389030389030a0e0c070c8a0389030385810a0e0c0a0e0c0a0e0c038581040b088",
    "............18a068a0e0c0a0e0c0a0e0c038903070c8a070c8a038581040b08870c8a0a0e0c038581038903040b088",
    "..................18a06870c8a070c8a070c8a038903040b08838581040b08840b08838903038903040b088......",
    "......18a06818a06818a06838903038903070c8a038903038903038903040b088385810385810385810385810......",
    "389030a0e0c0a0e0c0a0e0c070c8a038903038903070c8a038581040b08838581040b08870c8a070c8a070c8a0385810",
    "40b088389030a0e0c070c8a070c8a040b08838903038903038581038581040b08840b08840b08840b08838581040b088",
    "......40b08838903040b08840b08840b08840b088385810385810389030389030389030385810385810389030389030",
    "............40b08838903038903038581038581038581038581038581038581038581038581038903038903040b088",
    "......40b08838903070c8a070c8a040b08838581038903038581038581038903040b08840b08838581040b088......",
    "......38903070c8a070c8a040b08838903038903038903038903038581038903038903038903040b08838581040b088",
    "40b08838903038581038581038581038581040b08840b08840b088389030385810385810385810385810385810389030",
    "40b08840b08838903038903038903038903038581040b088389030385810389030389030389030389030389030389030",
    "............40b08840b08838903038903038903038581038581038903038903038903040b08840b088............",
]

assert len(TUFT) == TILE and all(len(r) == TILE * 6 for r in TUFT), "tuft must be 16x16 of 6-hex"

# Tuft tiles come from a tiling value-noise field, so the field clumps like a
# real route instead of showing an 8x8 stamp. THRESHOLD sets how dense it is.
NOISE_SEED, COVERAGE = 20260907, 0.52


def _h(ix, iy):
    n = (ix * 374761393 + iy * 668265263 + NOISE_SEED * 144665) & 0xFFFFFFFF
    n = (n ^ (n >> 13)) * 1274126177 & 0xFFFFFFFF
    return ((n ^ (n >> 16)) & 0xFFFFFF) / 0xFFFFFF


def _noise(x, y, period):
    """Value noise that wraps on `period`, so the sheet still tiles."""
    ix, iy = int(x) % period, int(y) % period
    fx, fy = x - int(x), y - int(y)
    sx, sy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    x1, y1 = (ix + 1) % period, (iy + 1) % period
    a, b = _h(ix, iy), _h(x1, iy)
    c, d = _h(ix, y1), _h(x1, y1)
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy


def _fbm(tx, ty):
    v = 0.0
    for oct_, amp in ((16, 0.42), (32, 0.34), (64, 0.24)):
        v += _fbm_oct(tx, ty, oct_) * amp
    return v


def _fbm_oct(tx, ty, cells):
    return _noise(tx / TILES * cells, ty / TILES * cells, cells)


_field = [[_fbm(tx, ty) for tx in range(TILES)] for ty in range(TILES)]
_flat = sorted(v for row in _field for v in row)
_cut = _flat[max(0, int(len(_flat) * (1 - COVERAGE)) - 1)]
LAYOUT = ["".join("g" if v > _cut else "." for v in row) for row in _field]
for _row in LAYOUT:
    assert len(_row) == TILES

MOTIF = [[None] * TILE for _ in range(TILE)]
for y in range(TILE):
    for x in range(TILE):
        tok = TUFT[y][x * 6:x * 6 + 6]
        if tok != "......":
            MOTIF[y][x] = (int(tok[0:2], 16), int(tok[2:4], 16), int(tok[4:6], 16))


class Rng:
    """xorshift32, so the sheet is identical on every run."""

    def __init__(self, seed):
        self.s = seed & 0xFFFFFFFF or 1

    def next(self, n):
        s = self.s
        s ^= (s << 13) & 0xFFFFFFFF
        s ^= s >> 17
        s ^= (s << 5) & 0xFFFFFFFF
        self.s = s
        return s % n


px = [[BASE] * SIZE for _ in range(SIZE)]
rng = Rng(0x51D0)

for ty in range(SIZE // TILE):
    for tx in range(SIZE // TILE):
        ox, oy = tx * TILE, ty * TILE
        for _ in range(14):
            px[oy + rng.next(TILE)][ox + rng.next(TILE)] = SPECK
        for _ in range(7):
            px[oy + rng.next(TILE)][ox + rng.next(TILE)] = SPECK2
        for _ in range(3):
            bx, by = ox + 2 + rng.next(TILE - 4), oy + 2 + rng.next(TILE - 4)
            px[by][bx] = BLADE
            px[by - 1][bx] = BLADE


def png(path, grid, scale=1):
    rows = []
    for row in grid:
        line = b"".join(bytes(c) * scale for c in row)
        rows += [b"\x00" + line] * scale
    w, h = len(grid[0]) * scale, len(grid) * scale

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    blob = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(blob)
    print(f"{path} {w}x{h}")


png("assets/grass_tiles.png", px)
if "--preview" in sys.argv:
    png("grass_preview.png", px, scale=4)
    png("tile_preview.png", [[c or BASE for c in row] for row in MOTIF], scale=14)


# A standalone RGBA tuft, for the upright sprites that give the field its
# 2.5D depth. Transparent where the sheet would show open ground.
def tuft_png(path):
    rows = []
    for y in range(TILE):
        row = bytearray(b"\x00")
        for x in range(TILE):
            c = MOTIF[y][x]
            row += bytes(c + (255,)) if c else b"\x00\x00\x00\x00"
        rows.append(bytes(row))

    def chunk(tag, data):
        b = tag + data
        return struct.pack(">I", len(data)) + b + struct.pack(">I", zlib.crc32(b) & 0xFFFFFFFF)

    pathlib.Path(path).write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", TILE, TILE, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b""))
    print(f"{path} ({TILE}x{TILE} RGBA tuft)")


import pathlib
tuft_png("assets/grass_tuft.png")


json.dump({"tiles": TILES, "rows": LAYOUT}, open("grass_layout.json", "w"))
print(f"grass_layout.json ({TILES}x{TILES}, "
      f"{sum(r.count('g') for r in LAYOUT) / (TILES * TILES) * 100:.0f}% tufts)")


def webp(src):
    """Lossless webp: the pixel art must survive exactly, and it still wins."""
    out = pathlib.Path(src).with_suffix(".webp")
    subprocess.run(["cwebp", "-quiet", "-lossless", "-exact", str(src), "-o", str(out)],
                   check=True)
    print(f"{out.name}: {out.stat().st_size / 1024:.1f} KB "
          f"(png was {pathlib.Path(src).stat().st_size / 1024:.1f} KB)")


webp("assets/grass_tiles.png")
webp("assets/grass_tuft.png")
