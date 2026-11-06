# -*- coding: utf-8 -*-
"""补齐 t1/t2 契约所需素材：fishgirl-blink.png、notify-card.png、icon.svg、
apple-touch-icon-180.png、icon-badge-96.png，并生成动效分镜图。

原始素材全部由本项目的 SVG 生成器绘制；本脚本只做组合/排版/导出。
"""
from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[1]          # assets/
SRC = ROOT / "src"
PARTS = SRC / "_parts"
PREVIEW = ROOT / "preview"
OUT = ROOT

FONT = "/System/Library/Fonts/Hiragino Sans GB.ttc"
F_REG = 0
F_BOLD = 2

INK = (34, 48, 79, 255)
CREAM = (255, 247, 236, 255)
CORAL = (255, 104, 138, 255)
MINT = (217, 247, 241, 255)
MINT_TXT = (31, 127, 118, 255)
BLUE = (77, 107, 254, 255)
GREY = (91, 107, 133, 255)
DARK_BG = (15, 17, 21, 255)


def font(size: int, bold: bool = False):
    return ImageFont.truetype(FONT, size, index=F_BOLD if bold else F_REG)


def star(draw: ImageDraw.ImageDraw, cx: float, cy: float, r: float, fill):
    pts = []
    for i in range(10):
        ang = -90 + i * 36
        rr = r if i % 2 == 0 else r * 0.42
        import math
        pts.append((cx + rr * math.cos(math.radians(ang)), cy + rr * math.sin(math.radians(ang))))
    draw.polygon(pts, fill=fill)


def glow(canvas: Image.Image, center, radius: int, color, strength: float = 0.30):
    g = Image.radial_gradient("L").resize((radius * 2, radius * 2), Image.LANCZOS)
    # 以“内切圆”为淡出边界，避免方形图层留下硬边
    g = g.point(lambda v: int(max(0.0, min(1.0, (181 - v) / 181.0)) * strength * 255))
    layer = Image.new("RGBA", (radius * 2, radius * 2), color)
    layer.putalpha(g)
    canvas.alpha_composite(layer, (center[0] - radius, center[1] - radius))


# ---------------------------------------------------------------- blink frame
def build_blink():
    src = PREVIEW / "fishgirl-hero-blink.png"
    dst = OUT / "fishgirl-blink.png"
    im = Image.open(src).convert("RGBA")
    assert im.size == (1024, 1024)
    im.save(dst, optimize=True)
    print("OK blink:", dst.relative_to(ROOT.parent), im.size)


# ---------------------------------------------------------------- icon.svg
def build_icon_svg():
    head_svg = (PARTS / "head.svg").read_text(encoding="utf-8")
    inner = re.sub(r"^\s*<svg[^>]*>", "", head_svg, count=1)
    inner = inner.rsplit("</svg>", 1)[0]
    # 头部 bbox 207,135 -> 817,723；缩放到 385px 宽，居中于 256,246
    s = 385 / 610
    tx = 256 - 512 * s
    ty = 246 - 429 * s
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="512" height="512" viewBox="0 0 512 512">
  <title>肥鱼娘 · DSH 完成提醒图标</title>
  <desc>原创角色「肥鱼娘」头像徽章，珊瑚渐变底 + 奶油圆盘。</desc>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#FFB3C2"/>
      <stop offset="0.55" stop-color="#FF8FA3"/>
      <stop offset="1" stop-color="#FF688A"/>
    </linearGradient>
    <radialGradient id="shine" cx="0.25" cy="0.18" r="0.75">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="14"/>
    </filter>
    <clipPath id="badgeClip"><circle cx="256" cy="256" r="222"/></clipPath>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <rect width="512" height="512" fill="url(#shine)"/>
  <ellipse cx="256" cy="300" rx="205" ry="190" fill="#A83A57" opacity="0.30" filter="url(#soft)"/>
  <circle cx="256" cy="256" r="222" fill="#FFF7EE" stroke="#FFE3C8" stroke-width="3"/>
  <g clip-path="url(#badgeClip)">
    <g transform="translate({tx:.2f},{ty:.2f}) scale({s:.5f})">
{inner}
    </g>
  </g>
  <circle cx="256" cy="256" r="222" fill="none" stroke="#FFE3C8" stroke-width="3"/>
  <g fill="#FFFFFF">
    <circle cx="88" cy="112" r="9" opacity="0.62"/>
    <circle cx="455" cy="116" r="7" opacity="0.55"/>
    <circle cx="462" cy="398" r="10" opacity="0.45"/>
    <circle cx="70" cy="384" r="6" opacity="0.5"/>
  </g>
  <g>
    <path d="M 468 138 l 5 12 13 2 -10 9 3 13 -11 -7 -12 7 3 -13 -10 -9 13 -2 z" fill="#FFD166" opacity="0.95"/>
    <path d="M 60 372 l 4 9 10 1 -8 7 2 10 -8 -5 -9 5 2 -10 -7 -7 10 -1 z" fill="#FFE3A3" opacity="0.85"/>
  </g>
</svg>'''
    p = OUT / "icon.svg"
    p.write_text(svg, encoding="utf-8")
    print("OK icon.svg:", p.stat().st_size, "bytes")
    # 预览渲染
    subprocess.run(["rsvg-convert", "-w", "512", "-h", "512", str(p), "-o", str(PREVIEW / "icon-svg-preview.png")], check=True)


# ---------------------------------------------------------------- notify card
def build_notify_card():
    W, H = 1024, 512
    canvas = Image.new("RGBA", (W, H), DARK_BG)
    glow(canvas, (665, 250), 340, (255, 104, 138, 255), 0.26)
    glow(canvas, (300, 290), 260, (127, 227, 216, 255), 0.12)

    # 背景泡泡/星点
    fg = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(fg)
    for cx, cy, r, a in [(120, 90, 26, 28), (900, 80, 14, 34), (940, 430, 26, 22),
                          (80, 380, 9, 40), (860, 300, 5, 50), (150, 300, 5, 34),
                          (760, 60, 4, 50), (980, 220, 7, 30)]:
        d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=(255, 255, 255, a), width=2)
    for cx, cy, r, a in [(930, 420, 3, 60), (160, 120, 3, 60), (880, 180, 2, 70)]:
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(255, 255, 255, a))
    star(d, 915, 130, 13, (255, 209, 102, 190))
    star(d, 125, 400, 9, (255, 227, 163, 150))
    star(d, 800, 470, 7, (127, 227, 216, 170))
    canvas.alpha_composite(fg)

    # 人物（去掉地面阴影的合成层）
    hero = Image.open(PARTS / "hero-noshadow.png").convert("RGBA")
    hero = hero.crop(hero.getchannel("A").getbbox())
    ch = 270
    cw = round(hero.width * ch / hero.height)
    hero = hero.resize((cw, ch), Image.LANCZOS)
    hx, hy = 660 - cw // 2, 250 - ch // 2
    # 地面阴影
    sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sh)
    sd.ellipse((660 - 82, 386, 660 + 82, 410), fill=(0, 0, 0, 110))
    sh = sh.filter(ImageFilter.GaussianBlur(7))
    canvas.alpha_composite(sh)
    canvas.alpha_composite(hero, (hx, hy))

    # 对话气泡 + 柔和投影
    bubble = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bubble)
    bd.rounded_rectangle((206, 156, 486, 302), radius=26, fill=CREAM)
    bd.polygon([(472, 246), (524, 258), (472, 276)], fill=CREAM)
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle((206, 166, 486, 312), radius=26, fill=(0, 0, 0, 120))
    sd.polygon([(472, 256), (524, 268), (472, 286)], fill=(0, 0, 0, 120))
    shadow = shadow.filter(ImageFilter.GaussianBlur(12))
    canvas.alpha_composite(shadow)
    canvas.alpha_composite(bubble)

    d = ImageDraw.Draw(canvas)
    d.text((230, 166), "DSH 任务完成", font=font(14, True), fill=BLUE)
    d.text((228, 186), "做好啦", font=font(46, True), fill=INK)
    d.text((230, 248), "任务完成 · 点开看看", font=font(16, False), fill=GREY)
    d.rounded_rectangle((230, 270, 330, 296), radius=13, fill=MINT)
    d.line([(240, 283), (246, 289), (258, 276)], fill=MINT_TXT, width=3, joint="curve")
    d.text((264, 274), "已完成", font=font(13, True), fill=MINT_TXT)

    # 角落小字（装饰，可被裁切）
    d.text((60, 474), "dsh-finish-notify · 肥鱼娘", font=font(13), fill=(180, 190, 210, 110))

    out = OUT / "notify-card.png"
    canvas.convert("RGB").save(out, optimize=True)
    print("OK notify-card:", out.stat().st_size, "bytes", canvas.size)


# ---------------------------------------------------------------- extra icons
def build_extra_icons():
    ic = Image.open(OUT / "icon-512.png").convert("RGBA")
    ic.resize((180, 180), Image.LANCZOS).convert("RGB").save(OUT / "apple-touch-icon-180.png", optimize=True)
    # Android 单色 badge：白色小鱼剪影 + 透明底（24dp 下更易辨识）
    scale = 4
    S = 96 * scale
    fish = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fish)
    u = S / 96
    fd.ellipse((18 * u, 30 * u, 76 * u, 66 * u), fill=(255, 255, 255, 255))
    fd.polygon([(24 * u, 48 * u), (2 * u, 28 * u), (2 * u, 68 * u)], fill=(255, 255, 255, 255))
    fd.polygon([(40 * u, 31 * u), (52 * u, 13 * u), (60 * u, 33 * u)], fill=(255, 255, 255, 255))
    fd.polygon([(38 * u, 65 * u), (50 * u, 83 * u), (57 * u, 63 * u)], fill=(255, 255, 255, 255))
    fd.ellipse((62 * u, 40 * u, 70 * u, 48 * u), fill=(255, 255, 255, 0))
    fd.ellipse((67 * u, 41 * u, 69 * u, 43 * u), fill=(255, 255, 255, 255))
    fish = fish.resize((96, 96), Image.LANCZOS)
    fish.save(OUT / "icon-badge-96.png", optimize=True)
    print("OK apple-touch + badge")


# ---------------------------------------------------------------- storyboard
def build_storyboard():
    frames = [
        ("/tmp/sb4-0.18.png", "0.18s · 卡片淡入"),
        ("/tmp/sb2-success-0.5.png", "0.50s · 弹跳出场"),
        ("/tmp/sb2-success-1.2.png", "1.20s · 说「做好啦」"),
        ("/tmp/sb4-2.15.png", "2.15s · 眨眼 / 摆尾"),
        ("/tmp/sb4-2.65.png", "2.65s · 淡出"),
        ("/tmp/sb2-error-1.2.png", "1.20s · 失败态「出错了」"),
    ]
    tile_w, tile_h = 360, 170
    gap_x, gap_y, margin, top = 18, 34, 30, 112
    cols, rows = 3, 2
    W = margin * 2 + cols * tile_w + (cols - 1) * gap_x
    H = top + rows * (tile_h + 26 + gap_y) + 16
    canvas = Image.new("RGBA", (W, H), (16, 19, 26, 255))
    d = ImageDraw.Draw(canvas)
    d.text((margin, 30), "肥鱼娘 · 完成提醒 3s 动效分镜", font=font(24, True), fill=(245, 248, 255, 255))
    d.text((margin, 66), "深色界面 · 成功 / 失败态 · 逐帧定格（freeze 截图）", font=font(13), fill=(140, 152, 174, 255))
    for i, (path, label) in enumerate(frames):
        r, c = divmod(i, cols)
        x = margin + c * (tile_w + gap_x)
        y = top + r * (tile_h + 26 + gap_y)
        try:
            shot = Image.open(path).convert("RGBA")
        except FileNotFoundError:
            continue
        crop = shot.crop((55, 655, 395, 815)).resize((tile_w, tile_h), Image.LANCZOS)
        canvas.alpha_composite(crop, (x, y))
        d.rounded_rectangle((x, y, x + tile_w - 1, y + tile_h - 1), radius=10, outline=(255, 255, 255, 22), width=1)
        d.text((x + 2, y + tile_h + 6), label, font=font(14, True), fill=(226, 233, 245, 255))
    out = PREVIEW / "fishgirl-storyboard.png"
    canvas.convert("RGB").save(out, optimize=True)
    print("OK storyboard:", out, canvas.size)


if __name__ == "__main__":
    build_blink()
    build_icon_svg()
    build_notify_card()
    build_extra_icons()
    build_storyboard()
