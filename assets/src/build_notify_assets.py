#!/usr/bin/env python3
"""生成通知图标与通知大图（依赖 build_assets.py 中的 SVG 零件）。"""
from __future__ import annotations

import base64
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
ASSETS = ROOT / "assets"
PARTS = HERE / "_parts"
sys.path.insert(0, str(HERE))

import build_assets as ba  # noqa: E402

PARTS.mkdir(parents=True, exist_ok=True)


def head_png() -> Image.Image:
    """BODY 去掉腿/服装/手臂，得到干净的头像，裁掉透明边。"""
    body = ba.BODY
    legs = body[body.index("  <!-- 短胖腿与鞋 -->"):body.index("  <!-- 裙身 -->")]
    clothes = body[body.index("  <!-- 裙身 -->"):body.index("  <!-- 脸 -->")]
    head_body = body.replace(legs, "").replace(clothes, "").replace(ba.ARMS_HAPPY, "")
    raw = PARTS / "head.png"
    ba.render(ba.svg_doc(head_body + ba.EYES_OPEN), raw)
    im = Image.open(raw).convert("RGBA")
    bbox = im.getbbox()
    head = im.crop(bbox)
    head.save(ASSETS / "fishgirl-head.png", optimize=True)
    print("head:", head.size, "bbox", bbox)
    return head


def vgrad(size: tuple[int, int], top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    w, h = size
    im = Image.new("RGB", size)
    d = ImageDraw.Draw(im)
    for y in range(h):
        t = y / max(1, h - 1)
        d.line([(0, y), (w, y)], fill=tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return im.convert("RGBA")


def radial_glow(size: tuple[int, int], center: tuple[int, int], radius: int,
                color: tuple[int, int, int], alpha: int) -> Image.Image:
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.ellipse([center[0] - radius, center[1] - radius, center[0] + radius, center[1] + radius],
              fill=color + (alpha,))
    return layer.filter(ImageFilter.GaussianBlur(radius * 0.32))


def star(d: ImageDraw.ImageDraw, cx: float, cy: float, r: float, fill, outline=None) -> None:
    pts = []
    for i in range(8):
        ang = -90 + i * 45
        rr = r if i % 2 == 0 else r * 0.42
        import math
        pts.append((cx + rr * math.cos(math.radians(ang)), cy + rr * math.sin(math.radians(ang))))
    d.polygon(pts, fill=fill, outline=outline)


def icon(size: int, head: Image.Image, maskable: bool = False) -> Image.Image:
    """珊瑚底 + 奶油圆形徽章 + 鱼娘头像。maskable 版缩小徽章，保证 80% 安全区。"""
    bg = vgrad((size, size), (255, 168, 184), (255, 100, 134))
    bg.alpha_composite(radial_glow((size, size), (size // 2, int(size * 0.44)), int(size * 0.46),
                                   (255, 246, 236), 60))

    # 角落装饰
    d = ImageDraw.Draw(bg)
    for (cx, cy, r, a) in [(0.10, 0.16, 0.030, 95), (0.90, 0.13, 0.020, 70),
                           (0.08, 0.84, 0.018, 60), (0.92, 0.86, 0.026, 70)]:
        d.ellipse([size * cx - size * r, size * cy - size * r,
                   size * cx + size * r, size * cy + size * r], fill=(255, 255, 255, a))

    cx = cy = size // 2
    r = int(size * (0.440 if not maskable else 0.385))

    # 徽章投影
    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sh)
    sd.ellipse([cx - r, cy - r + size * 0.018, cx + r, cy + r + size * 0.018],
               fill=(150, 42, 65, 95))
    bg.alpha_composite(sh.filter(ImageFilter.GaussianBlur(size * 0.022)))

    # 奶油圆盘 + 珊瑚描边
    disc = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    dd = ImageDraw.Draw(disc)
    dd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 247, 238, 255),
               outline=(255, 226, 212, 255), width=max(4, round(size * 0.012)))
    bg.alpha_composite(disc)

    # 头像裁进圆形
    inner = int(r * 0.94)
    target_w = int(inner * 2 * 0.88)
    scale = target_w / head.width
    hw, hh = int(head.width * scale), int(head.height * scale)
    hi = head.resize((hw, hh), Image.LANCZOS)
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    layer.alpha_composite(hi, (cx - hw // 2, cy - inner + int(size * 0.035)))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse([cx - inner, cy - inner, cx + inner, cy + inner], fill=255)
    layer.putalpha(Image.composite(layer.getchannel("A"), Image.new("L", (size, size), 0), mask))
    bg.alpha_composite(layer)
    d = ImageDraw.Draw(bg)
    star(d, size * 0.905, size * 0.175, size * 0.036, (255, 209, 102, 245))
    star(d, size * 0.085, size * 0.805, size * 0.024, (255, 240, 210, 220))
    return bg


def main() -> None:
    head = head_png()
    icon512 = icon(512, head)
    icon512.convert("RGB").save(ASSETS / "icon-512.png", optimize=True)
    icon192 = icon512.resize((192, 192), Image.LANCZOS).convert("RGB")
    icon192.save(ASSETS / "icon-192.png", optimize=True)
    mask = icon(512, head, maskable=True)
    mask.convert("RGB").save(ASSETS / "icon-maskable-512.png", optimize=True)
    # 预览
    prev = Image.new("RGB", (760, 560), (245, 242, 236))
    prev.paste(icon512.resize((320, 320), Image.LANCZOS), (30, 40))
    prev.paste(icon192.resize((120, 120), Image.LANCZOS), (390, 60))
    prev.paste(mask.resize((240, 240), Image.LANCZOS), (480, 250))
    prev.save(ASSETS / "preview" / "icons-preview.png")
    print("OK: icons")


if __name__ == "__main__":
    main()
