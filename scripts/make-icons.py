"""Builds every app icon from assets/icon/artwork.png (a full-bleed square).

Outputs:
  assets/icon/AppIcon.png        1024 master on Apple's macOS grid (824 squircle, 100 margin, shadow)
  assets/icon/AppIcon.icns       for the .app bundle (Contents/Resources, CFBundleIconFile=AppIcon)
  web/public/favicon.ico         16 + 32, squircle filling the canvas
  web/public/favicon.png         32
  web/public/apple-touch-icon.png 180, full-bleed (iOS/Safari round it themselves)

Run from anywhere: python3 scripts/make-icons.py  (needs Pillow and macOS iconutil)
"""
import math
import os
import shutil
import subprocess
import tempfile

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON = os.path.join(ROOT, "assets", "icon")
PUBLIC = os.path.join(ROOT, "web", "public")

CANVAS, BODY = 1024, 824   # Apple macOS icon grid
CROP = 0.78                # keep the centre of the artwork so the glyph stays big at 16 px
SS = 4                     # supersampling for smooth mask edges


def squircle_mask(size, n=5.0):
    """Superellipse |x|^n + |y|^n = 1: close to Apple's continuous-corner rounded square."""
    big = size * SS
    mask = Image.new("L", (big, big), 0)
    r = big / 2
    pts = []
    steps = 720
    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        x = r + r * math.copysign(abs(c) ** (2 / n), c)
        y = r + r * math.copysign(abs(s) ** (2 / n), s)
        pts.append((x, y))
    ImageDraw.Draw(mask).polygon(pts, fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def artwork(size):
    art = Image.open(os.path.join(ICON, "artwork.png")).convert("RGBA")
    w, h = art.size
    side = int(min(w, h) * CROP)
    left, top = (w - side) // 2, (h - side) // 2
    return art.crop((left, top, left + side, top + side)).resize((size, size), Image.LANCZOS)


def rounded(size):
    """The artwork cut to a squircle that fills a size×size canvas."""
    img = artwork(size)
    img.putalpha(ImageChops.multiply(img.getchannel("A"), squircle_mask(size)))
    return img


def master():
    """1024 canvas: 824 squircle centred, with a soft drop shadow in the transparent margin."""
    off = (CANVAS - BODY) // 2
    body = rounded(BODY)
    shadow = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    sh = Image.new("RGBA", (BODY, BODY), (0, 0, 0, 90))
    sh.putalpha(ImageChops.multiply(sh.getchannel("A"), squircle_mask(BODY)))
    shadow.alpha_composite(sh, (off, off + 12))
    shadow = shadow.filter(ImageFilter.GaussianBlur(14))
    out = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    out.alpha_composite(shadow)
    out.alpha_composite(body, (off, off))
    return out


def main():
    os.makedirs(PUBLIC, exist_ok=True)
    m = master()
    m.save(os.path.join(ICON, "AppIcon.png"))

    tmp = tempfile.mkdtemp()
    iconset = os.path.join(tmp, "AppIcon.iconset")
    os.makedirs(iconset)
    for pt in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            px = pt * scale
            name = f"icon_{pt}x{pt}{'@2x' if scale == 2 else ''}.png"
            m.resize((px, px), Image.LANCZOS).save(os.path.join(iconset, name))
    subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(ICON, "AppIcon.icns")], check=True)
    shutil.rmtree(tmp)

    fav = rounded(256)
    fav.save(os.path.join(PUBLIC, "favicon.ico"), sizes=[(16, 16), (32, 32)])
    fav.resize((32, 32), Image.LANCZOS).save(os.path.join(PUBLIC, "favicon.png"))
    artwork(180).convert("RGB").save(os.path.join(PUBLIC, "apple-touch-icon.png"))


if __name__ == "__main__":
    main()
