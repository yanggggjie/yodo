#!/usr/bin/env python3
"""Generate time.svg and cost.svg next to this file."""

from pathlib import Path

ROWS = [
    ("yodo (run)", 56, 0.24, "run"),
    ("agent-browser", 6 * 60 + 25, 0.83, "other"),
    ("browser-use", 9 * 60 + 45, 0.93, "other"),
    ("yodo (learn)", 6 * 60 + 46, 0.83, "learn"),
]

FILL = {
    "run": "#1f6b4a",
    "other": "#8b9099",
    "learn": "url(#learn)",
}

TIME_LABEL = {
    56: "56 秒",
    385: "6 分 25 秒",
    585: "9 分 45 秒",
    406: "6 分 46 秒",
}


def bar_chart(path: Path, title: str, values: list[float], labels: list[str], kinds: list[str]) -> None:
    width, height = 720, 268
    left, right, top = 168, 28, 52
    row_h, gap = 40, 14
    plot_w = width - left - right
    max_v = max(values)
    names = [row[0] for row in ROWS]

    bars = []
    for i, (name, value, label, kind) in enumerate(zip(names, values, labels, kinds)):
        y = top + i * (row_h + gap)
        w = max(6, plot_w * (value / max_v))
        fill = FILL[kind]
        text_x = left + w + 10
        anchor = "start"
        color = "#222"
        if w > 220:
            text_x = left + w - 12
            anchor = "end"
            color = "#fff" if kind == "run" else "#222"
        bars.append(
            f'<rect x="{left}" y="{y}" width="{w:.1f}" height="{row_h}" rx="6" fill="{fill}"/>'
            f'<text x="20" y="{y + 26}" font-size="15" fill="#222">{name}</text>'
            f'<text x="{text_x:.1f}" y="{y + 26}" text-anchor="{anchor}" font-size="15" fill="{color}">{label}</text>'
        )

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-label="{title}">
  <defs>
    <pattern id="learn" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
      <rect width="8" height="8" fill="#c5c9d0"/>
      <path d="M0 0h3v8H0z" fill="#dfe2e6"/>
    </pattern>
  </defs>
  <rect width="{width}" height="{height}" rx="12" fill="#f4f5f7"/>
  <g font-family='ui-sans-serif, system-ui, "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", sans-serif'>
    <text x="20" y="32" font-size="16" font-weight="600" fill="#111">{title}</text>
    {"".join(bars)}
  </g>
</svg>
"""
    path.write_text(svg, encoding="utf-8")


def main() -> None:
    here = Path(__file__).resolve().parent
    names_ok = [row[0] for row in ROWS]
    assert names_ok[0] == "yodo (run)" and names_ok[-1] == "yodo (learn)"
    times = [row[1] for row in ROWS]
    costs = [row[2] for row in ROWS]
    kinds = [row[3] for row in ROWS]
    bar_chart(
        here / "time.svg",
        "耗时（本次）",
        times,
        [TIME_LABEL[t] for t in times],
        kinds,
    )
    bar_chart(
        here / "cost.svg",
        "花费（本次）",
        costs,
        [f"${c:.2f}" for c in costs],
        kinds,
    )


if __name__ == "__main__":
    main()
