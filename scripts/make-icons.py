"""Draws the app's icons (public/icons/): an excavator on a dark ground, as an SVG and as the PNGs
the web manifest lists. Run it again after changing the drawing; the files are committed.

    python scripts/make-icons.py        (needs Pillow)
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
BG = (0x0F, 0x11, 0x16)
DIRT = (0x8A, 0x6A, 0x46)
PAINT = (0xF2, 0xB7, 0x05)
DARK = (0x3F, 0x45, 0x49)
TYRE = (0x2E, 0x32, 0x36)
HUB = (0xA7, 0xAD, 0xB3)
STEEL = (0x5C, 0x61, 0x66)

# The drawing, in a 512-unit square, as a list of (kind, colour, numbers): the same shapes make the
# SVG and the PNGs. Shapes stay inside the middle 80% (a 51-unit margin), so the maskable icon's
# rounded mask doesn't cut them.
SHAPES = [
    ("ellipse", DIRT, (70, 330, 442, 430)),  # the patch of ground
    ("polygon", PAINT, [(120, 290), (120, 232), (176, 232), (176, 212), (236, 212), (236, 232), (336, 232), (336, 290)]),  # body and cab
    ("rect", DARK, (112, 290, 344, 318)),  # undercarriage
    ("polygon", PAINT, [(284, 236), (304, 236), (390, 160), (402, 174)]),  # boom
    ("polygon", PAINT, [(390, 160), (402, 174), (416, 262), (400, 262)]),  # arm
    ("polygon", STEEL, [(370, 256), (420, 256), (430, 300), (378, 300)]),  # bucket
    ("circle", TYRE, (168, 334, 46)),  # wheels
    ("circle", TYRE, (300, 334, 46)),
    ("circle", HUB, (168, 334, 18)),
    ("circle", HUB, (300, 334, 18)),
]


def svg(size):
    parts = []
    for kind, colour, n in SHAPES:
        fill = "#%02x%02x%02x" % colour
        if kind == "ellipse":
            x0, y0, x1, y1 = n
            parts.append(f'<ellipse cx="{(x0 + x1) / 2}" cy="{(y0 + y1) / 2}" rx="{(x1 - x0) / 2}" ry="{(y1 - y0) / 2}" fill="{fill}"/>')
        elif kind == "rect":
            x0, y0, x1, y1 = n
            parts.append(f'<rect x="{x0}" y="{y0}" width="{x1 - x0}" height="{y1 - y0}" fill="{fill}"/>')
        elif kind == "polygon":
            parts.append(f'<polygon points="{" ".join(f"{x},{y}" for x, y in n)}" fill="{fill}"/>')
        elif kind == "circle":
            cx, cy, r = n
            parts.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{fill}"/>')
    bg = "#%02x%02x%02x" % BG
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 512 512">'
        f'<rect width="512" height="512" rx="96" fill="{bg}"/>' + "".join(parts) + "</svg>\n"
    )


def png(size, rounded):
    scale = 4  # drawn big and shrunk, for smooth edges
    s = 512 * scale
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if rounded:
        d.rounded_rectangle((0, 0, s - 1, s - 1), radius=96 * scale, fill=BG)
    else:
        d.rectangle((0, 0, s - 1, s - 1), fill=BG)
    for kind, colour, n in SHAPES:
        if kind == "ellipse" or kind == "rect":
            box = tuple(v * scale for v in n)
            (d.ellipse if kind == "ellipse" else d.rectangle)(box, fill=colour)
        elif kind == "polygon":
            d.polygon([(x * scale, y * scale) for x, y in n], fill=colour)
        elif kind == "circle":
            cx, cy, r = (v * scale for v in n)
            d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=colour)
    return im.resize((size, size), Image.LANCZOS)


OUT.mkdir(parents=True, exist_ok=True)
(OUT / "icon.svg").write_text(svg(512), encoding="utf-8", newline="\n")
for name, size, rounded in [("icon-192.png", 192, True), ("icon-512.png", 512, True), ("icon-maskable-512.png", 512, False), ("apple-touch-icon.png", 180, False)]:
    png(size, rounded).save(OUT / name)
    print(f"public/icons/{name}  {size}x{size}")
