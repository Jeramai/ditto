#!/usr/bin/env python3
"""Cut the dancing-Ditto favicon frames out of the original sprite strip.

STRIP is the 132x29 four-frame sheet that matias.me/nsfw draws its Ditto
from, embedded verbatim so this script needs no network. It is a 2-bit
paletted PNG, so decoding it means inflate, unfilter, then unpack the
indices. Each 33x29 frame is padded to a square and written as RGBA.
"""
import base64
import struct
import sys
import zlib

STRIP = (
    "iVBORw0KGgoAAAANSUhEUgAAAIQAAAAdAgMAAAAWQyy/AAAADFBMVEX///+4YOA4ODj4+PhASPNe"
    "AAAAAXRSTlMAQObYZgAAAStJREFUeF6l08FqhEAMBuBhbk6fYyj6Pgmul3pZEN9hWV8i9FgvC3X6"
    "PELpe2zP9Y/pyCLLFprLoP83STzo/lv+/ZEoGGwMw10RacmePmML4PfOjyqev6WGKDs/Kth40QiE"
    "XInxLPzxle+WHUS8kgoi6vU8zzaobIQB31R4QrU4T9RVKl5ngpheaBP1KlmWLlU4z0iCJioORKxC"
    "mzm5nDSJAOx0jxthdEBwzOLIkJyFIEGgQpvVqxSMhVRxQKCiEYhozQtbPV/Fmx6iJE5ErYkWgi8m"
    "lOYkEiVZxQRpglUojSZB9wJUTDoxkTeMN4J3ot0JT79CTMifRUmUEtV5803EJcD3+5ScS+MmML+f"
    "eHBhCcKSWOVvw9s07H+LTdwvL/1Fp9yvaggJUx/WD0e0wREEScedAAAAAElFTkSuQmCC"
)
FRAMES, PAD = 4, 2


def read_png(blob):
    pos, ch = 8, {}
    while pos < len(blob):
        ln, tag = struct.unpack(">I4s", blob[pos : pos + 8])
        ch[tag] = ch.get(tag, b"") + blob[pos + 8 : pos + 8 + ln]
        pos += 12 + ln
    w, h, depth, ctype = struct.unpack(">IIBBBBB", ch[b"IHDR"])[:4]
    assert (depth, ctype) == (2, 3), f"expected 2-bit paletted, got {depth}/{ctype}"
    plte = ch[b"PLTE"]
    palette = [tuple(plte[i * 3 : i * 3 + 3]) for i in range(len(plte) // 3)]
    clear = {i for i, a in enumerate(ch.get(b"tRNS", b"")) if a == 0}

    data = zlib.decompress(ch[b"IDAT"])
    stride = (w * depth + 7) // 8
    prev, rows, p = bytearray(stride), [], 0
    for _ in range(h):
        f = data[p]
        p += 1
        line = bytearray(data[p : p + stride])
        p += stride
        if f == 1:
            for i in range(1, stride):
                line[i] = (line[i] + line[i - 1]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - 1] if i else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - 1] if i else 0
                c = prev[i - 1] if i else 0
                b = prev[i]
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        elif f != 0:
            raise ValueError(f"unknown PNG filter {f}")
        prev = line
        rows.append([(line[i // 4] >> (6 - 2 * (i % 4))) & 3 for i in range(w)])
    return w, h, rows, palette, clear


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
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(blob)
    return len(blob)


sw, sh, rows, palette, clear = read_png(base64.b64decode(STRIP))
fw = sw // FRAMES
assert sw % FRAMES == 0, f"{sw} px does not divide into {FRAMES} frames"
side = max(fw, sh + PAD * 2)
top = (side - sh) // 2
left = (side - fw) // 2
CLEAR = (0, 0, 0, 0)

total = 0
for f in range(FRAMES):
    grid = [[CLEAR] * side for _ in range(side)]
    for y in range(sh):
        for x in range(fw):
            i = rows[y][f * fw + x]
            if i not in clear:
                grid[top + y][left + x] = (*palette[i], 255)
    total += png(f"assets/favicon-{f}.png", grid)
print(f"{FRAMES} frames of {side}x{side} from a {sw}x{sh} strip, {total} bytes")

if "--preview" in sys.argv:
    strip = [[CLEAR] * (side * FRAMES) for _ in range(side)]
    for f in range(FRAMES):
        for y in range(sh):
            for x in range(fw):
                i = rows[y][f * fw + x]
                if i not in clear:
                    strip[top + y][f * side + left + x] = (*palette[i], 255)
    png("favicon_preview.png", strip, scale=6)
    print("favicon_preview.png")
