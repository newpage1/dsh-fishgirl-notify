#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""肥鱼娘视觉素材生成器（原创 SVG 绘制 → rsvg-convert 渲染 PNG）。

本脚本只负责设计素材，不包含任何插件运行时代码。
运行：python3 assets/src/build_assets.py
依赖：rsvg-convert（librsvg）、Pillow
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]          # dsh-finish-notify/
SRC = ROOT / "assets" / "src"
ASSETS = ROOT / "assets"
PREVIEW = ASSETS / "preview"

# ----------------------------------------------------------------------------
# 调色板（与 DSH 深/浅色界面兼容：暖珊瑚主色 + 深海蓝描边 + DSH 蓝点缀）
# ----------------------------------------------------------------------------
INK = "#22304F"          # 统一描边色
INK_SOFT = "#3A5578"
SKIN = "#FFE8D8"
SKIN_SH = "#F8CDB8"
HAIR1 = "#4390C2"
HAIR2 = "#245C88"
HAIR_HI = "#8AD4F2"
FIN1 = "#FFB9C8"
FIN2 = "#FF7F9E"
FIN_RAY = "#E06381"
DRESS = "#FFF8F0"
DRESS_SH = "#FFE7D3"
TRIM = "#FF8FA3"
NAVY = "#2C5680"
NAVY_D = "#1D3A5B"
GOLD = "#FFD166"
BLUE = "#4D6BFE"
MINT = "#7FE3D8"
BLUSH = "#FF9DB0"
MOUTH = "#8C3A4D"
TONGUE = "#FF8FA3"

DEFS = f"""
<defs>
  <linearGradient id="gSkin" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#FFF4EB"/><stop offset="1" stop-color="{SKIN}"/>
  </linearGradient>
  <linearGradient id="gHair" x1="0" y1="0" x2="0.15" y2="1">
    <stop offset="0" stop-color="{HAIR1}"/><stop offset="1" stop-color="{HAIR2}"/>
  </linearGradient>
  <linearGradient id="gHairSide" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#4E9BCB"/><stop offset="1" stop-color="#2A6390"/>
  </linearGradient>
  <linearGradient id="gFin" x1="0" y1="0" x2="1" y2="0.3">
    <stop offset="0" stop-color="{FIN1}"/><stop offset="1" stop-color="{FIN2}"/>
  </linearGradient>
  <linearGradient id="gTail" x1="0" y1="0" x2="0.8" y2="1">
    <stop offset="0" stop-color="#FFC0CD"/><stop offset="0.55" stop-color="#FF8FA8"/><stop offset="1" stop-color="#FF7C9C"/>
  </linearGradient>
  <linearGradient id="gDress" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="{DRESS}"/><stop offset="1" stop-color="{DRESS_SH}"/>
  </linearGradient>
  <radialGradient id="gIris" cx="0.42" cy="0.32" r="0.75">
    <stop offset="0" stop-color="#4FA8D8"/><stop offset="0.55" stop-color="#2A6C9C"/><stop offset="1" stop-color="#173E60"/>
  </radialGradient>
  <radialGradient id="gGlow" cx="0.5" cy="0.5" r="0.5">
    <stop offset="0" stop-color="#FF8FA3" stop-opacity="0.5"/><stop offset="1" stop-color="#FF8FA3" stop-opacity="0"/>
  </radialGradient>
  <filter id="soft" x="-40%" y="-40%" width="180%" height="180%">
    <feGaussianBlur stdDeviation="10"/>
  </filter>
  <filter id="soft2" x="-40%" y="-40%" width="180%" height="180%">
    <feGaussianBlur stdDeviation="4"/>
  </filter>
</defs>
"""

# ----------------------------------------------------------------------------
# 基础小组件
# ----------------------------------------------------------------------------

def star(x: float, y: float, r: float, fill: str, opacity: float = 1.0, rot: float = 0) -> str:
    """四角星闪光。"""
    q = r * 0.28
    return (
        f'<path d="M {x} {y-r} L {x+q} {y-q} L {x+r} {y} L {x+q} {y+q} '
        f'L {x} {y+r} L {x-q} {y+q} L {x-r} {y} L {x-q} {y-q} Z" '
        f'fill="{fill}" opacity="{opacity}" transform="rotate({rot} {x} {y})"/>'
    )


def bubble(x: float, y: float, r: float, opacity: float = 0.75) -> str:
    return (
        f'<circle cx="{x}" cy="{y}" r="{r}" fill="#FFFFFF" fill-opacity="0.10" '
        f'stroke="#BFE9F7" stroke-width="{max(2, r*0.14):.1f}" stroke-opacity="{opacity}"/>'
        f'<circle cx="{x-r*0.32:.1f}" cy="{y-r*0.36:.1f}" r="{r*0.18:.1f}" fill="#FFFFFF" opacity="0.8"/>'
    )


# ----------------------------------------------------------------------------
# 鱼鳍耳（左右镜像）
# ----------------------------------------------------------------------------
LEFT_FIN = f"""
<g id="fin-left">
  <path d="M 338 404 C 302 380 254 366 212 372
           C 226 396 230 414 226 434
           C 240 446 246 458 242 474
           C 260 496 302 502 338 486 Z"
        fill="url(#gFin)" stroke="{INK}" stroke-width="9" stroke-linejoin="round"/>
  <path d="M 330 416 C 298 398 260 388 228 390
           C 238 408 240 420 238 434
           C 250 442 254 452 252 462
           C 268 478 300 480 326 468 Z" fill="#FFD6DF" opacity="0.9"/>
  <g stroke="{FIN_RAY}" stroke-width="5" stroke-linecap="round" opacity="0.85" fill="none">
    <path d="M 330 426 C 294 404 256 390 220 378"/>
    <path d="M 334 442 C 300 428 264 420 228 420"/>
    <path d="M 334 460 C 302 460 270 466 240 480"/>
  </g>
</g>
"""

RIGHT_FIN = f'<g transform="translate(1024,0) scale(-1,1)">{LEFT_FIN}</g>'

# ----------------------------------------------------------------------------
# 尾巴（可独立旋转做“摆尾”）
# ----------------------------------------------------------------------------
TAIL = f"""
<g id="tail">
  <!-- 尾柄：从裙后向下再向右回卷 -->
  <path d="M 556 668 C 640 682 708 730 752 788 L 706 842 C 656 792 608 758 552 748 Z"
        fill="url(#gTail)" stroke="{INK}" stroke-width="10" stroke-linejoin="round"/>
  <!-- 尾鳍：两瓣流动扇形 -->
  <path d="M 744 786 C 796 742 852 706 912 682 C 940 670 956 692 938 714
           C 908 752 866 780 826 796 C 850 826 858 862 844 892
           C 834 914 804 908 796 886 C 776 842 762 816 742 806 Z"
        fill="url(#gTail)" stroke="{INK}" stroke-width="10" stroke-linejoin="round"/>
  <!-- 尾鳍内缘高光 -->
  <path d="M 796 782 C 848 750 896 720 926 696" fill="none" stroke="#FFF1E6"
        stroke-width="11" stroke-linecap="round" opacity="0.75"/>
  <path d="M 812 830 C 834 856 848 880 854 894" fill="none" stroke="#FFF1E6"
        stroke-width="9" stroke-linecap="round" opacity="0.7"/>
  <g stroke="{FIN_RAY}" stroke-width="5" stroke-linecap="round" opacity="0.8" fill="none">
    <path d="M 786 796 C 840 762 890 730 924 704"/>
    <path d="M 788 804 C 834 792 878 778 912 760"/>
    <path d="M 790 812 C 818 840 838 868 850 890"/>
    <path d="M 770 802 C 786 824 796 848 802 872"/>
  </g>
  <!-- 尾柄鳞片 -->
  <g fill="#FFF1E6" opacity="0.55">
    <path d="M 586 694 q 22 -16 44 0 q -22 16 -44 0 Z"/>
    <path d="M 618 716 q 24 -16 48 0 q -24 16 -48 0 Z"/>
    <path d="M 650 740 q 24 -16 48 0 q -24 16 -48 0 Z"/>
  </g>
</g>
"""

# ----------------------------------------------------------------------------
# 身体（头发后层、裙、四肢、头部、五官除眼睛）
# ----------------------------------------------------------------------------
ARMS_HAPPY = f"""
  <!-- 手臂：右手挥动 / 左手叉腰（绘制在头发之后，确保可见） -->
  <g>
    <path d="M 646 654 C 690 656 722 638 752 608" fill="none" stroke="{INK}" stroke-width="66" stroke-linecap="round"/>
    <path d="M 646 654 C 690 656 722 638 752 608" fill="none" stroke="{DRESS_SH}" stroke-width="54" stroke-linecap="round"/>
    <path d="M 734 630 L 762 596" fill="none" stroke="{INK}" stroke-width="54" stroke-linecap="round"/>
    <path d="M 734 630 L 762 596" fill="none" stroke="{SKIN}" stroke-width="42" stroke-linecap="round"/>
    <path d="M 724 632 L 742 650" fill="none" stroke="{TRIM}" stroke-width="14" stroke-linecap="round"/>
    <circle cx="778" cy="574" r="38" fill="{SKIN}" stroke="{INK}" stroke-width="9"/>
    <path d="M 744 560 q -14 -4 -18 10 q 8 10 22 6" fill="{SKIN}" stroke="{INK}" stroke-width="7" stroke-linejoin="round"/>
    <path d="M 770 552 q 12 -8 22 0" fill="none" stroke="{INK}" stroke-width="7" stroke-linecap="round" opacity="0.65"/>

    <path d="M 386 654 C 358 668 342 706 336 746" fill="none" stroke="{INK}" stroke-width="68" stroke-linecap="round"/>
    <path d="M 386 654 C 358 668 342 706 336 746" fill="none" stroke="{DRESS_SH}" stroke-width="56" stroke-linecap="round"/>
    <path d="M 338 744 L 334 780" fill="none" stroke="{INK}" stroke-width="54" stroke-linecap="round"/>
    <path d="M 338 744 L 334 780" fill="none" stroke="{SKIN}" stroke-width="42" stroke-linecap="round"/>
    <path d="M 356 736 L 332 748" fill="none" stroke="{TRIM}" stroke-width="14" stroke-linecap="round"/>
    <circle cx="334" cy="798" r="36" fill="{SKIN}" stroke="{INK}" stroke-width="9"/>
    <path d="M 366 788 q 14 2 16 16 q -10 8 -22 2" fill="{SKIN}" stroke="{INK}" stroke-width="7" stroke-linejoin="round"/>
  </g>
"""

FACE_HAPPY = f"""
  <!-- 眉毛 -->
  <path d="M 384 362 C 406 344 442 340 468 352" fill="none" stroke="#2F6C9E" stroke-width="11" stroke-linecap="round"/>
  <path d="M 640 362 C 618 344 582 340 556 352" fill="none" stroke="#2F6C9E" stroke-width="11" stroke-linecap="round"/>

  <!-- 腮红（收在脸内） -->
  <ellipse cx="370" cy="524" rx="42" ry="21" fill="{BLUSH}" opacity="0.5"/>
  <ellipse cx="654" cy="524" rx="42" ry="21" fill="{BLUSH}" opacity="0.5"/>
  <g stroke="#FF7D95" stroke-width="5" stroke-linecap="round" opacity="0.5">
    <path d="M 352 510 l 12 8"/><path d="M 370 508 l 12 8"/><path d="M 388 510 l 12 8"/>
    <path d="M 636 510 l 12 8"/><path d="M 654 508 l 12 8"/><path d="M 672 510 l 12 8"/>
  </g>

  <!-- 鼻子 -->
  <path d="M 505 512 q 7 6 14 0" fill="none" stroke="{SKIN_SH}" stroke-width="7" stroke-linecap="round"/>

  <!-- 嘴（开心张开） -->
  <path d="M 480 548 C 494 536 530 536 544 548 C 538 576 524 592 512 592
           C 500 592 486 576 480 548 Z"
        fill="{MOUTH}" stroke="{INK}" stroke-width="7" stroke-linejoin="round"/>
  <path d="M 496 572 C 504 562 520 562 528 572 C 522 582 516 587 512 587
           C 508 587 502 582 496 572 Z" fill="{TONGUE}"/>
  <path d="M 488 546 q 24 -8 48 0" fill="none" stroke="#FFF3E6" stroke-width="6" stroke-linecap="round" opacity="0.5"/>
"""

BODY = f"""
<g id="body">
  <!-- 后发 -->
  <ellipse cx="512" cy="462" rx="232" ry="240" fill="url(#gHair)" stroke="{INK}" stroke-width="10"/>
  <path d="M 292 552 C 274 612 286 676 324 712 C 338 724 356 718 352 700
           C 344 668 336 624 334 582 Z" fill="url(#gHairSide)" stroke="{INK}" stroke-width="9"/>
  <path d="M 732 552 C 750 612 738 676 700 712 C 686 724 668 718 672 700
           C 680 668 688 624 690 582 Z" fill="url(#gHairSide)" stroke="{INK}" stroke-width="9"/>

  {LEFT_FIN}
  {RIGHT_FIN}

  <!-- 短胖腿与鞋 -->
  <g>
    <rect x="438" y="834" width="62" height="76" rx="31" fill="#FFF9F2" stroke="{INK}" stroke-width="8"/>
    <rect x="524" y="834" width="62" height="76" rx="31" fill="#FFF9F2" stroke="{INK}" stroke-width="8"/>
    <ellipse cx="466" cy="918" rx="46" ry="27" fill="{TRIM}" stroke="{INK}" stroke-width="8"/>
    <ellipse cx="558" cy="918" rx="46" ry="27" fill="{TRIM}" stroke="{INK}" stroke-width="8"/>
    <path d="M 432 908 Q 466 894 500 908" fill="none" stroke="#FFD3DC" stroke-width="8" stroke-linecap="round"/>
    <path d="M 524 908 Q 558 894 592 908" fill="none" stroke="#FFD3DC" stroke-width="8" stroke-linecap="round"/>
  </g>

  <!-- 裙身 -->
  <path d="M 404 586 C 378 602 356 642 342 692 C 328 742 320 792 334 820
           C 352 852 420 868 512 868 C 604 868 672 852 690 820
           C 704 792 696 742 682 692 C 668 642 646 602 620 586 Z"
        fill="url(#gDress)" stroke="{INK}" stroke-width="10" stroke-linejoin="round"/>
  <!-- 裙摆荷叶边 -->
  <path d="M 330 806 C 362 796 392 806 422 816 C 452 826 482 828 512 828
           C 542 828 572 826 602 816 C 632 806 662 796 694 806
           C 700 830 690 850 672 858 C 620 874 404 874 352 858
           C 334 850 324 830 330 806 Z"
        fill="#FFF1E2" stroke="{INK}" stroke-width="9" stroke-linejoin="round"/>
  <path d="M 348 842 C 420 856 604 856 676 842" fill="none" stroke="{TRIM}" stroke-width="8" stroke-linecap="round" opacity="0.9"/>
  <!-- 小鱼补丁 -->
  <g transform="translate(512,790)">
    <path d="M -34 0 C -18 -22 18 -22 34 0 C 18 22 -18 22 -34 0 Z"
          fill="{MINT}" stroke="{INK}" stroke-width="6" stroke-linejoin="round"/>
    <path d="M 34 0 L 52 -16 L 52 16 Z" fill="{MINT}" stroke="{INK}" stroke-width="6" stroke-linejoin="round"/>
    <circle cx="-14" cy="-3" r="4" fill="{INK}"/>
    <path d="M -2 8 q 10 6 20 0" fill="none" stroke="{INK}" stroke-width="4" stroke-linecap="round"/>
  </g>
  <!-- 水手领 -->
  <path d="M 404 588 C 430 606 458 616 512 618 C 566 616 594 606 620 588
           C 646 618 664 660 674 692 C 640 716 578 730 512 730
           C 446 730 384 716 350 692 C 360 660 378 618 404 588 Z"
        fill="{NAVY}" stroke="{INK}" stroke-width="9" stroke-linejoin="round"/>
  <path d="M 376 660 C 420 684 604 684 648 660" fill="none" stroke="#FFF3E6" stroke-width="9" stroke-linecap="round"/>
  <path d="M 512 618 L 512 730" stroke="#FFF3E6" stroke-width="7" opacity="0.4"/>

  <!-- 蝴蝶结（胸口） -->
  <g transform="translate(0,-34)">
    <path d="M 512 690 C 474 660 436 668 440 696 C 444 722 486 724 512 704 Z"
          fill="{TRIM}" stroke="{INK}" stroke-width="8" stroke-linejoin="round"/>
    <path d="M 512 690 C 550 660 588 668 584 696 C 580 722 538 724 512 704 Z"
          fill="{TRIM}" stroke="{INK}" stroke-width="8" stroke-linejoin="round"/>
    <path d="M 504 706 C 486 734 480 752 490 762" fill="none" stroke="{INK}" stroke-width="26" stroke-linecap="round"/>
    <path d="M 520 706 C 538 734 544 752 534 762" fill="none" stroke="{INK}" stroke-width="26" stroke-linecap="round"/>
    <path d="M 504 706 C 486 734 480 752 490 762" fill="none" stroke="{TRIM}" stroke-width="16" stroke-linecap="round"/>
    <path d="M 520 706 C 538 734 544 752 534 762" fill="none" stroke="{TRIM}" stroke-width="16" stroke-linecap="round"/>
    <circle cx="512" cy="694" r="22" fill="#FFB3C4" stroke="{INK}" stroke-width="8"/>
  </g>

  <!-- 脸 -->
  <ellipse cx="512" cy="436" rx="196" ry="184" fill="url(#gSkin)" stroke="{INK}" stroke-width="10"/>

  <!-- 前发（刘海 + 鬓角） -->
  <path d="M 320 444 C 296 332 382 238 512 238 C 642 238 728 332 704 444
           C 690 414 678 376 662 390 C 646 404 638 368 622 384
           C 606 400 596 362 578 382 C 560 402 552 358 534 380
           C 516 402 508 356 490 380 C 472 404 464 360 446 382
           C 428 404 420 368 402 388 C 384 408 372 380 356 402
           C 342 420 330 430 320 444 Z"
        fill="url(#gHair)"/>
  <path d="M 320 444 C 296 332 382 238 512 238 C 642 238 728 332 704 444"
        fill="none" stroke="{INK}" stroke-width="10" stroke-linecap="round"/>
  <path d="M 704 444 C 690 414 678 376 662 390 C 646 404 638 368 622 384
           C 606 400 596 362 578 382 C 560 402 552 358 534 380
           C 516 402 508 356 490 380 C 472 404 464 360 446 382
           C 428 404 420 368 402 388 C 384 408 372 380 356 402
           C 342 420 330 430 320 444"
        fill="none" stroke="#1B4C72" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M 352 344 C 402 286 468 262 534 262 C 596 262 650 286 684 328
           C 652 306 604 290 560 292 C 502 296 448 312 404 340 Z"
        fill="{HAIR_HI}" opacity="0.5"/>
  <!-- 鬓角 -->
  <path d="M 330 402 C 306 470 302 540 318 598 C 326 626 354 640 370 620
           C 382 604 368 586 354 590 C 374 562 378 504 364 462 Z"
        fill="url(#gHairSide)" stroke="{INK}" stroke-width="9" stroke-linejoin="round"/>
  <path d="M 694 402 C 718 470 722 540 706 598 C 698 626 670 640 654 620
           C 642 604 656 586 670 590 C 650 562 646 504 660 462 Z"
        fill="url(#gHairSide)" stroke="{INK}" stroke-width="9" stroke-linejoin="round"/>
  <!-- 鬓角发丝高光 -->
  <path d="M 336 450 C 326 500 328 550 340 584" fill="none" stroke="{HAIR_HI}" stroke-width="6" stroke-linecap="round" opacity="0.5"/>
  <path d="M 688 450 C 698 500 696 550 684 584" fill="none" stroke="{HAIR_HI}" stroke-width="6" stroke-linecap="round" opacity="0.5"/>

  <!-- 呆毛 + 水滴 -->
  <path d="M 498 246 C 486 202 506 166 544 154 C 578 144 594 164 582 180
           C 572 192 554 188 548 176" fill="none" stroke="{INK}" stroke-width="24" stroke-linecap="round"/>
  <path d="M 498 246 C 486 202 506 166 544 154 C 578 144 594 164 582 180
           C 572 192 554 188 548 176" fill="none" stroke="url(#gHair)" stroke-width="13" stroke-linecap="round"/>
  <circle cx="541" cy="150" r="12" fill="#E7FBFF" stroke="{INK}" stroke-width="6"/>
  <circle cx="537" cy="146" r="3.5" fill="#FFFFFF"/>

  {ARMS_HAPPY}

  {FACE_HAPPY}
</g>
"""

# ----------------------------------------------------------------------------
# 眼睛（睁眼 / 闭眼，供 CSS 眨眼切换）
# ----------------------------------------------------------------------------
def eye(cx: float, cy: float, side: int, teary: bool = False) -> str:
    tears = ""
    if teary:
        tears = f"""
    <path d="M {cx-46} {cy+50} Q {cx} {cy+68} {cx+46} {cy+50}" fill="none" stroke="#BFF0FF" stroke-width="10" stroke-linecap="round" opacity="0.9"/>
    <ellipse cx="{cx}" cy="{cy+56}" rx="30" ry="9" fill="#D6F6FF" opacity="0.5"/>
    <path d="M {cx+side*54} {cy+44} q 10 16 0 26 q -10 -10 0 -26 Z" fill="#B7EEFF" stroke="#3F86AE" stroke-width="4"/>
"""
    return f"""
  <g>
    <ellipse cx="{cx}" cy="{cy}" rx="56" ry="64" fill="#FFFDF8" stroke="{INK}" stroke-width="7"/>
    <circle cx="{cx}" cy="{cy+2}" r="47" fill="url(#gIris)"/>
    <circle cx="{cx}" cy="{cy+22}" r="40" fill="{MINT}" opacity="0.22"/>
    <ellipse cx="{cx}" cy="{cy+4}" rx="19" ry="24" fill="#102438"/>
    <circle cx="{cx-17}" cy="{cy-20}" r="16" fill="#FFFFFF"/>
    <circle cx="{cx+16}" cy="{cy+20}" r="7" fill="#D9F7FF" opacity="0.95"/>
    {star(cx-4, cy+24, 9, "#FFFFFF", 0.9, side*12)}
    <path d="M {cx-58} {cy-34} Q {cx} {cy-78} {cx+58} {cy-34}" fill="none" stroke="{INK}" stroke-width="13" stroke-linecap="round"/>
    <path d="M {cx+side*50} {cy-46} q {side*20} -18 {side*26} -34" fill="none" stroke="{INK}" stroke-width="10" stroke-linecap="round"/>
    <path d="M {cx-46} {cy-58} q 22 -14 44 -8" fill="none" stroke="#FFFFFF" stroke-width="6" stroke-linecap="round" opacity="0.5"/>
    {tears}
  </g>
"""

EYES_OPEN = f'<g id="eyes-open">{eye(424, 452, -1)}{eye(600, 452, 1)}</g>'

EYES_CLOSED = f"""
<g id="eyes-closed">
  <path d="M 372 456 Q 424 500 476 456" fill="none" stroke="{INK}" stroke-width="13" stroke-linecap="round"/>
  <path d="M 548 456 Q 600 500 652 456" fill="none" stroke="{INK}" stroke-width="13" stroke-linecap="round"/>
  <path d="M 372 456 q -14 8 -20 18" fill="none" stroke="{INK}" stroke-width="9" stroke-linecap="round"/>
  <path d="M 652 456 q 14 8 20 18" fill="none" stroke="{INK}" stroke-width="9" stroke-linecap="round"/>
  <path d="M 366 468 q 58 24 116 0" fill="none" stroke="{BLUSH}" stroke-width="5" stroke-linecap="round" opacity="0.4"/>
  <path d="M 542 468 q 58 24 116 0" fill="none" stroke="{BLUSH}" stroke-width="5" stroke-linecap="round" opacity="0.4"/>
</g>
"""

# ----------------------------------------------------------------------------
# 前景闪光 / 泡泡（可单独做 twinkle）
# ----------------------------------------------------------------------------
SPARKLES = f"""
<g id="sparkles">
  {bubble(236, 726, 20)}
  {bubble(806, 676, 13)}
  {bubble(842, 402, 9)}
  {bubble(196, 468, 12)}
  {star(250, 352, 30, GOLD, 0.95, 8)}
  {star(800, 330, 24, BLUE, 0.9, -10)}
  {star(858, 466, 17, GOLD, 0.9, 16)}
  {star(176, 620, 20, MINT, 0.9, -12)}
  {star(760, 886, 26, GOLD, 0.9, 12)}
  {star(300, 876, 15, BLUE, 0.85, 0)}
  {star(744, 476, 12, GOLD, 0.8, 24)}
  <g fill="none" stroke="{TRIM}" stroke-width="7" stroke-linecap="round" opacity="0.8">
    <path d="M 214 492 q 18 -20 40 -18"/>
    <path d="M 800 496 q -14 -22 -36 -24"/>
  </g>
  <g fill="none" stroke="{GOLD}" stroke-width="6" stroke-linecap="round" opacity="0.75">
    <path d="M 292 792 q 20 8 26 28"/>
    <path d="M 804 850 q -18 4 -26 22"/>
  </g>
</g>
"""

# ----------------------------------------------------------------------------
# 变体：失败 / 等待
# ----------------------------------------------------------------------------
ARMS_DOWN = f"""
  <!-- 手臂：垂放（失败/等待） -->
  <g>
    <path d="M 646 654 C 688 674 704 706 706 744" fill="none" stroke="{INK}" stroke-width="66" stroke-linecap="round"/>
    <path d="M 646 654 C 688 674 704 706 706 744" fill="none" stroke="{DRESS_SH}" stroke-width="54" stroke-linecap="round"/>
    <path d="M 704 742 L 708 774" fill="none" stroke="{INK}" stroke-width="52" stroke-linecap="round"/>
    <path d="M 704 742 L 708 774" fill="none" stroke="{SKIN}" stroke-width="40" stroke-linecap="round"/>
    <path d="M 694 736 L 712 748" fill="none" stroke="{TRIM}" stroke-width="13" stroke-linecap="round"/>
    <circle cx="710" cy="794" r="34" fill="{SKIN}" stroke="{INK}" stroke-width="9"/>
    <path d="M 694 796 q -12 10 -8 22" fill="{SKIN}" stroke="{INK}" stroke-width="7" stroke-linejoin="round"/>

    <path d="M 386 654 C 344 674 328 706 326 744" fill="none" stroke="{INK}" stroke-width="66" stroke-linecap="round"/>
    <path d="M 386 654 C 344 674 328 706 326 744" fill="none" stroke="{DRESS_SH}" stroke-width="54" stroke-linecap="round"/>
    <path d="M 328 742 L 324 774" fill="none" stroke="{INK}" stroke-width="52" stroke-linecap="round"/>
    <path d="M 328 742 L 324 774" fill="none" stroke="{SKIN}" stroke-width="40" stroke-linecap="round"/>
    <path d="M 320 736 L 302 748" fill="none" stroke="{TRIM}" stroke-width="13" stroke-linecap="round"/>
    <circle cx="322" cy="794" r="34" fill="{SKIN}" stroke="{INK}" stroke-width="9"/>
    <path d="M 338 796 q 12 10 8 22" fill="{SKIN}" stroke="{INK}" stroke-width="7" stroke-linejoin="round"/>
  </g>
"""

FACE_SAD = f"""
  <!-- 眉毛（担心） -->
  <path d="M 384 372 C 410 358 442 350 468 354" fill="none" stroke="#2F6C9E" stroke-width="11" stroke-linecap="round"/>
  <path d="M 640 372 C 614 358 582 350 556 354" fill="none" stroke="#2F6C9E" stroke-width="11" stroke-linecap="round"/>

  <!-- 腮红（略淡） -->
  <ellipse cx="370" cy="524" rx="42" ry="21" fill="{BLUSH}" opacity="0.3"/>
  <ellipse cx="654" cy="524" rx="42" ry="21" fill="{BLUSH}" opacity="0.3"/>

  <!-- 鼻子 -->
  <path d="M 505 512 q 7 6 14 0" fill="none" stroke="{SKIN_SH}" stroke-width="7" stroke-linecap="round"/>

  <!-- 嘴（委屈波浪） -->
  <path d="M 482 566 q 15 14 30 0 q 15 14 30 0" fill="none" stroke="{MOUTH}" stroke-width="9" stroke-linecap="round"/>
  <path d="M 476 580 q 13 6 22 1" fill="none" stroke="{SKIN_SH}" stroke-width="5" stroke-linecap="round" opacity="0.7"/>
"""

EYES_SAD = f"""
<g id="eyes-sad">
  {eye(424, 452, -1, teary=True)}
  {eye(600, 452, 1, teary=True)}
  <!-- 挂在眼角的水滴 -->
  <path d="M 352 534 q 13 22 0 33 q -13 -11 0 -33 Z" fill="#B7EEFF" stroke="#3F86AE" stroke-width="5"/>
  <path d="M 672 534 q 13 22 0 33 q -13 -11 0 -33 Z" fill="#B7EEFF" stroke="#3F86AE" stroke-width="5"/>
</g>
"""

FX_ERROR = f"""
<g id="fx-error">
  {bubble(222, 690, 14, 0.5)}
  {bubble(806, 640, 10, 0.5)}
  {star(788, 470, 16, BLUE, 0.7, 12)}
  {star(238, 500, 13, BLUE, 0.6, -8)}
  <!-- 汗滴 -->
  <path d="M 742 392 C 756 416 760 430 746 442 C 730 430 732 414 742 392 Z"
        fill="#B7EEFF" stroke="#3F86AE" stroke-width="6" stroke-linejoin="round"/>
  <circle cx="741" cy="430" r="5" fill="#FFFFFF" opacity="0.85"/>
  <!-- 小乌云（下雨） -->
  <g transform="translate(292,244) scale(0.92)">
    <path d="M -34 0 C -42 -20 -18 -32 2 -24 C 10 -42 42 -40 46 -16 C 66 -14 68 12 46 16 L -26 16 C -48 14 -50 -6 -34 0 Z"
          fill="#C9D8E8" stroke="{INK}" stroke-width="7" stroke-linejoin="round"/>
    <g stroke="#8FD4F2" stroke-width="6" stroke-linecap="round">
      <path d="M -14 30 l -6 16"/><path d="M 10 32 l -6 16"/><path d="M 32 30 l -6 16"/>
    </g>
  </g>
</g>
"""

FACE_WAIT = f"""
  <!-- 眉毛（放松） -->
  <path d="M 384 364 C 406 348 442 344 468 354" fill="none" stroke="#2F6C9E" stroke-width="10" stroke-linecap="round"/>
  <path d="M 640 364 C 618 348 582 344 556 354" fill="none" stroke="#2F6C9E" stroke-width="10" stroke-linecap="round"/>

  <ellipse cx="370" cy="524" rx="42" ry="21" fill="{BLUSH}" opacity="0.4"/>
  <ellipse cx="654" cy="524" rx="42" ry="21" fill="{BLUSH}" opacity="0.4"/>

  <path d="M 505 512 q 7 6 14 0" fill="none" stroke="{SKIN_SH}" stroke-width="7" stroke-linecap="round"/>

  <!-- 嘴（小声嘟囔） -->
  <ellipse cx="512" cy="568" rx="13" ry="15" fill="{MOUTH}" stroke="{INK}" stroke-width="6"/>
  <ellipse cx="512" cy="574" rx="7" ry="6" fill="{TONGUE}"/>
"""

FX_WAIT = f"""
<g id="fx-wait">
  {bubble(806, 676, 12, 0.6)}
  {star(788, 428, 14, GOLD, 0.75, 10)}
  <!-- 思考气泡 -->
  <g transform="translate(748,286)">
    <circle cx="0" cy="0" r="16" fill="#FFFDF8" stroke="{INK}" stroke-width="6" opacity="0.95"/>
    <circle cx="-34" cy="28" r="11" fill="#FFFDF8" stroke="{INK}" stroke-width="5" opacity="0.9"/>
    <circle cx="-56" cy="48" r="7" fill="#FFFDF8" stroke="{INK}" stroke-width="4" opacity="0.85"/>
    <circle cx="-12" cy="0" r="3.5" fill="{INK}"/>
    <circle cx="10" cy="0" r="3.5" fill="{INK}"/>
  </g>
  <g transform="translate(286,352)">
    <circle cx="0" cy="0" r="5" fill="{MINT}" opacity="0.9"/>
    <circle cx="22" cy="-18" r="3.5" fill="{MINT}" opacity="0.7"/>
  </g>
</g>
"""

TAIL_SAD = f'<g transform="rotate(10 560 700)">{TAIL}</g>'
BODY_SAD = BODY.replace(ARMS_HAPPY, ARMS_DOWN).replace(FACE_HAPPY, FACE_SAD)
BODY_WAIT = BODY.replace(ARMS_HAPPY, ARMS_DOWN).replace(FACE_HAPPY, FACE_WAIT)

# 地面柔和阴影（仅主视觉，不参与动效图层）
SHADOW = f"""
<g id="shadow">
  <ellipse cx="512" cy="952" rx="250" ry="26" fill="#1B2B45" opacity="0.18" filter="url(#soft)"/>
</g>
"""


def svg_doc(inner: str, w: int = 1024, h: int = 1024, bg: str | None = None) -> str:
    rect = f'<rect width="{w}" height="{h}" fill="{bg}"/>' if bg else ""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" '
        f'viewBox="0 0 {w} {h}">{DEFS}{rect}{inner}</svg>'
    )


# ----------------------------------------------------------------------------
# 渲染
# ----------------------------------------------------------------------------
def render(svg_text: str, out_png: Path, w: int | None = None, h: int | None = None) -> None:
    tmp = out_png.with_suffix(".svg")
    tmp.write_text(svg_text, encoding="utf-8")
    cmd = ["rsvg-convert", str(tmp), "-o", str(out_png)]
    if w:
        cmd[2:2] = ["-w", str(w)]
    if h:
        cmd += ["-h", str(h)]
    subprocess.run(cmd, check=True)


def composite(layers: list[Path], out: Path) -> None:
    base = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    for p in layers:
        im = Image.open(p).convert("RGBA")
        base = Image.alpha_composite(base, im)
    base.save(out, optimize=True)


def main() -> None:
    SRC.mkdir(parents=True, exist_ok=True)
    PREVIEW.mkdir(parents=True, exist_ok=True)
    tmpdir = SRC / "_parts"
    tmpdir.mkdir(exist_ok=True)

    # ---- 成功主视觉图层 ----
    render(svg_doc(TAIL), tmpdir / "tail.png")
    render(svg_doc(BODY), tmpdir / "body.png")
    render(svg_doc(EYES_OPEN), tmpdir / "eyes-open.png")
    render(svg_doc(EYES_CLOSED), tmpdir / "eyes-closed.png")
    render(svg_doc(SPARKLES), tmpdir / "sparkles.png")
    render(svg_doc(SHADOW), tmpdir / "shadow.png")

    composite([tmpdir / "shadow.png", tmpdir / "tail.png", tmpdir / "body.png",
               tmpdir / "eyes-open.png", tmpdir / "sparkles.png"], ASSETS / "fishgirl-hero.png")
    composite([tmpdir / "shadow.png", tmpdir / "tail.png", tmpdir / "body.png",
               tmpdir / "eyes-closed.png", tmpdir / "sparkles.png"],
              PREVIEW / "fishgirl-hero-blink.png")

    # ---- 失败 / 等待主视觉 ----
    render(svg_doc(SHADOW + TAIL_SAD + BODY_SAD + EYES_SAD + FX_ERROR),
           ASSETS / "fishgirl-hero-error.png")
    render(svg_doc(SHADOW + TAIL + BODY_WAIT + EYES_CLOSED + FX_WAIT),
           ASSETS / "fishgirl-hero-waiting.png")

    # ---- 动效图层（统一 1024 画布，已对齐）----
    for name in ("tail", "body", "eyes-open", "eyes-closed", "sparkles", "shadow"):
        src = tmpdir / f"{name}.png"
        dst = ASSETS / f"fishgirl-{name}.png"
        Image.open(src).save(dst, optimize=True)

    print("OK: hero + variants + layers rendered")


if __name__ == "__main__":
    main()
