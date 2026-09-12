#!/usr/bin/env python3
"""Assemble dist/ : exactly the files the page fetches, nothing else.

The favicon PNGs are inlined into the JS, so they are build inputs only, and
every served path is relative, so dist/ works at any base (jeramai.github.io/ditto).
"""
import pathlib
import shutil

ROOT = pathlib.Path(__file__).parent
DIST = ROOT / "dist"
ROOT_FILES = ["index.html", "favicon.svg", "og_image.jpg"]
ASSETS = [
    "index-B_rmCXFl.js", "index-NajdQ5bO.css", "runtime-BfiCajl-.js",
    "transport.worker-BWQVwIa1.js", "ditto-model.bin", "grass_tiles.webp",
    "grass_tuft.webp", "konga.mp3", "sky.exr",
]

if DIST.exists():
    shutil.rmtree(DIST)
(DIST / "assets").mkdir(parents=True)
(DIST / ".nojekyll").write_text("")

total = 0
for name in ROOT_FILES:
    src = ROOT / name
    if not src.exists():
        print(f"  ! missing {name}")
        continue
    shutil.copy2(src, DIST / name)
    total += src.stat().st_size
for name in ASSETS:
    src = ROOT / "assets" / name
    if not src.exists():
        raise SystemExit(f"missing asset: {name}")
    shutil.copy2(src, DIST / "assets" / name)
    total += src.stat().st_size

print(f"dist/ ready: {len(ROOT_FILES) + len(ASSETS)} files, {total / 1048576:.1f} MB")
for f in sorted(DIST.rglob("*")):
    if f.is_file():
        print(f"  {f.stat().st_size / 1024:8.0f} KB  {f.relative_to(DIST)}")
