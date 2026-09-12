#!/usr/bin/env python3
"""Cut the conga loop down from 4 MB to half a megabyte.

The gag only needs a groove, so the track is trimmed to a whole number of bars
starting on the measured downbeat, folded to mono and re-encoded. Because the
cut starts on the downbeat, the runtime needs no offset to stay on the beat.
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / "original/konga-source.mp3"
OUT = ROOT / "engine/public/konga.mp3"

DOWNBEAT, BEAT, BEATS = 0.380, 0.4902, 128     # measured by onset autocorrelation
BITRATE = "72k"

if not SRC.exists():
    sys.exit(f"missing {SRC}")

subprocess.run(
    ["ffmpeg", "-y", "-v", "error", "-ss", f"{DOWNBEAT}", "-t", f"{BEAT * BEATS:.4f}",
     "-i", str(SRC), "-ac", "1", "-b:a", BITRATE, "-ar", "44100", str(OUT)],
    check=True,
)
print(f"{OUT.name}: {OUT.stat().st_size / 1024:.0f} KB, "
      f"{BEATS} beats ({BEAT * BEATS:.2f}s), mono {BITRATE}")
