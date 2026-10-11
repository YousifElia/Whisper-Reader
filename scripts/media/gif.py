"""
README GIF from the demo video's frames.

GitHub will not play a video committed to a repository inline, but it will
play a GIF, so the README gets this: the reading part of the demo at 10 fps,
800 px wide, on one shared palette (per-frame palettes shimmer, and a shared
one compresses far better because unchanged pixels stay byte-identical).

    python scripts/media/gif.py <frames dir> <timeline.json> <out.gif>
"""

import json
import sys

from PIL import Image

frames_dir, timeline_path, out = sys.argv[1:4]
with open(timeline_path, encoding="utf-8") as f:
    timeline = json.load(f)

FPS = timeline["fps"]
STEP = 3  # 30 fps -> 10 fps
WIDTH, HEIGHT = 800, 450

events = timeline["events"]
start = int((events["titleEnd"] + 0.2) * FPS)
end = int(events["keysEnd"] * FPS)
indices = list(range(start, end, STEP))


def load(i):
    image = Image.open(f"{frames_dir}/{i:05d}.jpg").convert("RGB")
    return image.resize((WIDTH, HEIGHT), Image.LANCZOS)


frames = [load(i) for i in indices]

# One palette for every frame, built from frames spread across the clip so
# both the light and dark panel, and the shortcuts card, get colours.
picks = [frames[round(k * (len(frames) - 1) / 5)] for k in range(6)]
montage = Image.new("RGB", (WIDTH, HEIGHT * len(picks)))
for k, image in enumerate(picks):
    montage.paste(image, (0, HEIGHT * k))
palette = montage.quantize(colors=256, method=Image.Quantize.MEDIANCUT)

# No dithering: flat interface colours stay flat, and dither noise that
# changes between frames would defeat the frame-to-frame compression.
quantized = [im.quantize(palette=palette, dither=Image.Dither.NONE) for im in frames]
quantized[0].save(
    out,
    save_all=True,
    append_images=quantized[1:],
    duration=int(1000 * STEP / FPS),
    loop=0,
    disposal=1,
)

with open(out, "rb") as f:
    size = len(f.read())
print(f"  {out}  {len(quantized)} frames, {size / 1e6:.1f} MB")
