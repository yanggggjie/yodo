#!/usr/bin/env python3
"""
生成 bench/time.svg 和 bench/cost.svg：python3 bench/charts.py

样式取自 brand/README.md：墨黑背景；只有 yodo (run) 用暮色橙红强调，
yodo (learn) 用灰色虚线框（一次性的学习，不强调），对照的其它工具用对照灰实心柱；数字先说，原理后说。颜色、字体、图标直接取 brand/wordmark.py，
品牌改了这里跟着变。需要 PNG 时：rsvg-convert -w 1760 bench/time.svg -o bench/time.png
"""
import os
import sys

sys.dont_write_bytecode = True  # 导入 brand/ 里的模块时不留 __pycache__
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "brand"))
from wordmark import ACCENT, CJK, INK, LATIN, MUTED, PAPER, icon_at  # noqa: E402

GRAY = "#6B6B76"   # 对照灰：和其它工具对比时，对方一律用它

# (名称, 耗时秒, 花费美元, 类型)
ROWS = [
    ("yodo (run)", 56, 0.24, "run"),
    ("agent-browser", 6 * 60 + 25, 0.83, "other"),
    ("browser-use", 9 * 60 + 45, 0.93, "other"),
    ("yodo (learn)", 6 * 60 + 46, 0.83, "learn"),
]

W, PAD = 880, 40
LABEL_W, BAR_X = 190, 40 + 190   # 左侧名称列、柱子起点
PLOT_W = 460                     # 最长的柱子宽度；右侧留给数值
ROW_H, ROW_GAP = 40, 22
TOP = 132                        # 第一行柱子的顶部
FOOT = 36


def duration(seconds):
    m, s = divmod(seconds, 60)
    return f"{s} 秒" if m == 0 else f"{m} 分 {s} 秒"


def chart(title, hint, values, labels, factor, factor_caption, note):
    height = TOP + len(ROWS) * ROW_H + (len(ROWS) - 1) * ROW_GAP + FOOT + 44
    names = [r[0] for r in ROWS]
    kinds = [r[3] for r in ROWS]
    top_value = max(values)
    name_fill = {"run": PAPER, "learn": MUTED, "other": MUTED}

    rows = []
    for i, (name, value, label, kind) in enumerate(zip(names, values, labels, kinds)):
        y = TOP + i * (ROW_H + ROW_GAP)
        w = max(8, PLOT_W * value / top_value)
        value_fill = "url(#accent)" if kind == "run" else PAPER
        if kind == "run":
            bar = f'<rect x="{BAR_X}" y="{y}" width="{w:.1f}" height="{ROW_H}" rx="10" fill="url(#accent)"/>'
        elif kind == "learn":  # 灰色虚线框：一次性的学习，不强调
            bar = (f'<rect x="{BAR_X + 1}" y="{y + 1}" width="{w - 2:.1f}" height="{ROW_H - 2}" rx="9" fill="{GRAY}" '
                   f'fill-opacity="0.18" stroke="{GRAY}" stroke-width="2" stroke-dasharray="7 6"/>')
        else:
            bar = f'<rect x="{BAR_X}" y="{y}" width="{w:.1f}" height="{ROW_H}" rx="10" fill="{GRAY}"/>'
        rows.append(
            f'<text x="{PAD}" y="{y + 26}" fill="{name_fill[kind]}" font-family="{LATIN}" font-size="18" '
            f'font-weight="{600 if kind == "run" else 500}">{name}</text>'
            f'<rect x="{BAR_X}" y="{y}" width="{PLOT_W}" height="{ROW_H}" rx="10" fill="{PAPER}" opacity="0.06"/>'
            f'{bar}'
            f'<text x="{BAR_X + w + 14:.1f}" y="{y + 27}" fill="{value_fill}" font-family="{LATIN}" font-size="22" '
            f'font-weight="700">{label}</text>'
        )

    return f'''<!-- yodo 性能图：由 bench/charts.py 生成，不要手改；样式规范见 brand/README.md。 -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {height}" width="{W}" height="{height}" role="img" aria-label="{title}：{'；'.join(f'{n} {l}' for n, l in zip(names, labels))}">
  <defs>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="{ACCENT[0]}"/><stop offset="1" stop-color="{ACCENT[1]}"/></linearGradient>
  </defs>
  <rect width="{W}" height="{height}" rx="24" fill="{INK}"/>
  <text x="{PAD}" y="62" fill="{PAPER}" font-family="{CJK}" font-size="30" font-weight="600">{title}</text>
  <text x="{PAD}" y="92" fill="{MUTED}" font-family="{CJK}" font-size="16">{hint}</text>
  <text x="{W - PAD}" y="70" text-anchor="end" fill="url(#accent)" font-family="{LATIN}" font-size="56" font-weight="700" letter-spacing="-1">{factor}</text>
  <text x="{W - PAD}" y="96" text-anchor="end" fill="{MUTED}" font-family="{CJK}" font-size="15">{factor_caption}</text>
  {"".join(rows)}
  <text x="{PAD}" y="{height - 26}" fill="{MUTED}" font-family="{CJK}" font-size="13">{note}</text>
  <g opacity="0.9">{icon_at(W - PAD - 24, height - 48, 24)}</g>
</svg>
'''


def main():
    seconds = [r[1] for r in ROWS]
    dollars = [r[2] for r in ROWS]
    assert ROWS[0][0] == "yodo (run)" and ROWS[0][3] == "run"
    others = [r for r in ROWS if r[3] == "other"]
    fastest = min(others, key=lambda r: r[1])
    cheapest = min(others, key=lambda r: r[2])
    note = "v1.2.0 · 读取 X Following 最近 3 条，发布到知乎和即刻 · 每种方式测试一次"

    outputs = {
        "time.svg": chart(
            "耗时", "越短越好", seconds, [duration(s) for s in seconds],
            f"{fastest[1] / ROWS[0][1]:.1f}×", f"比 {fastest[0]} 快", note),
        "cost.svg": chart(
            "花费", "越低越好", dollars, [f"${d:.2f}" for d in dollars],
            f"−{(1 - ROWS[0][2] / cheapest[2]) * 100:.0f}%", f"比 {cheapest[0]} 少花", note),
    }
    for name, svg in outputs.items():
        path = os.path.join(HERE, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(svg)
        print(f"已生成 {path}")


if __name__ == "__main__":
    main()
