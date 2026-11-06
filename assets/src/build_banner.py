#!/usr/bin/env python3
"""生成 1024×512 通知大图（Android Web Push image）。"""
from __future__ import annotations

import base64
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
ASSETS = HERE.parent
PARTS = HERE / "_parts"
OUT = ASSETS / "notification-banner-1024x512.png"


def main() -> None:
    hero = base64.b64encode((PARTS / "hero-noshadow.png").read_bytes()).decode()
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="1024" height="512" viewBox="0 0 1024 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0E1726"/>
      <stop offset="0.55" stop-color="#17283D"/>
      <stop offset="1" stop-color="#203A56"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#FF9DB0" stop-opacity="0.42"/>
      <stop offset="0.6" stop-color="#FF7F9E" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#FF7F9E" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="mint" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#7FE3D8" stop-opacity="0.25"/>
      <stop offset="1" stop-color="#7FE3D8" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="18"/>
    </filter>
    <filter id="soft2" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="7"/>
    </filter>
  </defs>

  <rect width="1024" height="512" fill="url(#bg)"/>
  <!-- 背景光 -->
  <ellipse cx="812" cy="286" rx="300" ry="290" fill="url(#glow)"/>
  <ellipse cx="210" cy="470" rx="260" ry="160" fill="url(#mint)"/>
  <!-- 泡泡 -->
  <g fill="none" stroke="#BFE9FF" stroke-opacity="0.22" stroke-width="2">
    <circle cx="596" cy="120" r="16"/>
    <circle cx="900" cy="86" r="9"/>
    <circle cx="958" cy="390" r="13"/>
    <circle cx="660" cy="452" r="7"/>
    <circle cx="84" cy="88" r="10"/>
  </g>
  <g fill="#BFE9FF" fill-opacity="0.18">
    <circle cx="948" cy="140" r="4"/><circle cx="612" cy="470" r="4"/>
    <circle cx="720" cy="64" r="3"/><circle cx="130" cy="420" r="3"/>
  </g>

  <!-- 角色 -->
  <g transform="translate(522,8) scale(0.5)">
    <image x="0" y="0" width="1024" height="1024" xlink:href="data:image/png;base64,{hero}"/>
  </g>

  <!-- 说话气泡 -->
  <g>
    <rect x="62" y="116" width="446" height="276" rx="54" fill="#FFF7EC"/>
    <path d="M 496 268 L 582 300 L 496 336 Z" fill="#FFF7EC"/>
      <!-- 小鱼徽标 -->
    <g transform="translate(506,178) rotate(-8)">
      <circle cx="0" cy="0" r="26" fill="#FFE3D4"/>
      <path d="M -13 4 C -6 -8 8 -8 14 4 C 8 14 -6 14 -13 4 Z" fill="#4D6BFE"/>
      <path d="M 14 4 L 23 -5 L 23 13 Z" fill="#4D6BFE"/>
      <circle cx="-5" cy="2" r="2.4" fill="#FFF7EC"/>
      <path d="M -1 9 q 5 3 9 0" fill="none" stroke="#FFF7EC" stroke-width="2" stroke-linecap="round"/>
    </g>
  </g>

  <!-- 文字 -->
  <g font-family="PingFang SC, Hiragino Sans GB, Noto Sans CJK SC, sans-serif">
    <text x="106" y="180" font-size="23" letter-spacing="3" fill="#4D6BFE" font-weight="600">DSH 任务完成</text>
    <text x="100" y="286" font-size="96" fill="#22304F" font-weight="700" letter-spacing="4">做好啦</text>
    <text x="104" y="330" font-size="23" fill="#5B6B85">肥鱼娘来报喜 · 点开看看</text>
    <g transform="translate(104,336)">
      <rect width="128" height="34" rx="17" fill="#7FE3D8" fill-opacity="0.26"/>
      <path d="M 16 17 l 6 7 l 12 -14" fill="none" stroke="#1F8F84" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="42" y="23" font-size="17" fill="#1F7F76" font-weight="600">已完成</text>
    </g>
  </g>

  <!-- 角标 -->
  <text x="64" y="482" font-family="PingFang SC, sans-serif" font-size="17"
        fill="#FFFFFF" fill-opacity="0.38" letter-spacing="1">dsh-finish-notify · 肥鱼娘</text>

  <!-- 闪光 -->
  <g fill="#FFD166">
    <path d="M 586 138 l 6 15 l 15 6 l -15 6 l -6 15 l -6 -15 l -15 -6 l 15 -6 Z" opacity="0.9"/>
    <path d="M 962 236 l 4 10 l 10 4 l -10 4 l -4 10 l -4 -10 l -10 -4 l 10 -4 Z" opacity="0.65"/>
  </g>
  <g fill="#7FE3D8" opacity="0.55">
    <path d="M 560 430 l 3.5 9 l 9 3.5 l -9 3.5 l -3.5 9 l -3.5 -9 l -9 -3.5 l 9 -3.5 Z"/>
  </g>
</svg>'''
    tmp = PARTS / "banner.svg"
    tmp.write_text(svg, encoding="utf-8")
    subprocess.run(["rsvg-convert", "-w", "1024", "-h", "512", "-o", str(OUT), str(tmp)], check=True)
    print("OK:", OUT, OUT.stat().st_size)


if __name__ == "__main__":
    main()
