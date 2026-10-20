#!/usr/bin/env python3
"""
生成字标与社交预览图。只用标准库：python3 brand/wordmark.py

输出（都在 brand/ 下，由本脚本生成，不要手改；规范见 brand/README.md）：
- wordmark-light.svg  浅色背景用的字标：图标 + 深色 yodo
- wordmark-dark.svg   深色背景用的字标：图标 + 白色 yodo
- social-preview.svg  GitHub 社交预览图，1280×640；PNG 由 make-icons.sh 导出

图标部分直接取 icon.py 的 build()，所以字标里的 y 与扩展图标逐像素一致。
"""
import os
import sys

sys.dont_write_bytecode = True  # 导入 icon.py 时不在 brand/ 里留下 __pycache__
from icon import A, C1, C2, C3, C4, C5, C6, E, RX, S, SIZE, STROKE, TOP, V, build as build_icon

HERE = os.path.dirname(os.path.abspath(__file__))

# ---- 颜色（与 brand/README.md 的「颜色」一致）----
INK = "#0B0B10"        # 深色：浅色背景上的文字，也是深色背景
PAPER = "#FFFFFF"      # 白色：深色背景上的文字
MUTED = "#A0A0AB"      # 次要文字
ACCENT = TOP[:2]       # 强调渐变：取图标上方区域的 橙 → 玫红

# ---- 字体 ----
LATIN = "Inter, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"
CJK = "'PingFang SC', 'Noto Sans SC', 'Source Han Sans SC', 'Microsoft YaHei', 'WenQuanYi Zen Hei', sans-serif"
MONO = "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace"

# ---- 字标几何：图标 128×128，文字与图标等高居中 ----
# Inter Bold 下 yodo 的 d 顶到 y 尾约为字号的 0.94；字号 112 时上下各留约 11，基线在 93
WORD_SIZE = 112
WORD_GAP = 28          # 图标与文字的间距
WORD_BASELINE = 93
WORD_WIDTH = 432       # 字标总宽（图标 128 + 间距 28 + 文字约 270，略留余量）


def icon_at(x, y, size):
    """把 icon.svg 作为嵌套 svg 放到指定位置与尺寸。"""
    svg = build_icon().split("\n", 1)[1]  # 去掉第一行注释
    return svg.replace(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox=',
        f'<svg x="{x}" y="{y}" width="{size}" height="{size}" viewBox=',
        1,
    )


def wordmark_group(color):
    return (f'{icon_at(0, 0, SIZE)}'
            f'<text x="{SIZE + WORD_GAP}" y="{WORD_BASELINE}" fill="{color}" font-family="{LATIN}" '
            f'font-size="{WORD_SIZE}" font-weight="700" letter-spacing="-2">yodo</text>')


def wordmark(color):
    return (f'<!-- yodo 字标：由 brand/wordmark.py 生成，不要手改；规范见 brand/README.md。 -->\n'
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {WORD_WIDTH} {SIZE}" '
            f'width="{WORD_WIDTH}" height="{SIZE}">\n{wordmark_group(color)}\n</svg>\n')


def big_y(x, y, scale):
    """右侧装饰：图标里同一组 y 曲线放大，裁在同样放大的圆角方块里，白色低透明度描线。"""
    def pt(q):
        return f"{q[0]} {q[1]}"
    arm = f"M{pt(A)} C{pt(C5)} {pt(C6)} {pt(V)}"
    tail = f"M{pt(S)} C{pt(C1)} {pt(C2)} {pt(V)} C{pt(C3)} {pt(C4)} {pt(E)}"
    return (f'<g transform="translate({x} {y}) scale({scale})" clip-path="url(#ghost)" fill="none" '
            f'stroke="{PAPER}" stroke-width="{STROKE}" stroke-linecap="round" stroke-linejoin="round" opacity="0.07">'
            f'<path d="{arm}"/><path d="{tail}"/></g>')


def social_preview():
    w, h, m = 1280, 640, 112   # 画布与左边距
    scale = 1.125              # 字标放大到高 144
    return f'''<!-- yodo 社交预览图：由 brand/wordmark.py 生成，不要手改；规范见 brand/README.md。 -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">
  <defs>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="{ACCENT[0]}"/><stop offset="1" stop-color="{ACCENT[1]}"/></linearGradient>
    <clipPath id="ghost"><rect width="{SIZE}" height="{SIZE}" rx="{RX}"/></clipPath>
  </defs>
  <rect width="{w}" height="{h}" fill="{INK}"/>
  {big_y(760, -26, 5.4)}
  <g transform="translate({m} 128) scale({scale})">{wordmark_group(PAPER)}</g>
  <text x="{m}" y="382" fill="url(#accent)" font-family="{LATIN}" font-size="72" font-weight="700" letter-spacing="-1">You only do once</text>
  <text x="{m}" y="452" fill="{PAPER}" font-family="{CJK}" font-size="40" font-weight="600">你只演示一次，之后直接调用接口</text>
  <text x="{m}" y="548" fill="{MUTED}" font-family="{MONO}" font-size="28">github.com/yanggggjie/yodo</text>
</svg>
'''


if __name__ == "__main__":
    outputs = {
        "wordmark-light.svg": wordmark(INK),
        "wordmark-dark.svg": wordmark(PAPER),
        "social-preview.svg": social_preview(),
    }
    for name, content in outputs.items():
        out = os.path.join(HERE, name)
        open(out, "w", encoding="utf8").write(content)
        print(f"已生成 {out}")
