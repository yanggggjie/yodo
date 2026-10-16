#!/usr/bin/env python3
"""
生成 brand/icon.svg（图标的参数化源文件）。只用标准库：python3 brand/icon.py

做法见 brand/icon.md。所有可调参数都在下面的常量里，改完运行本脚本，再 sh brand/make-icons.sh 出 PNG。
坐标系：画布 128×128，原点在左上角，y 向下；曲线端点故意超出画布（出血），让线从图标外伸进来、伸出去。
"""
import os

# ---- 画布 ----
SIZE = 128          # viewBox 边长
RX = 30             # 圆角半径，约 23%

# ---- y 的几何：两条三次贝塞尔曲线，在相接点 V 相接 ----
# 长斜线 TAIL：起点 S（右上，画布外）→ 经 V → 终点 E（左边缘外），尾巴向左弯出，像小写 y 的钩
S  = (140, -14)     # 长斜线起点
C1 = (118, 14)      # 长斜线第一段控制点 1（靠近 S）
C2 = (96, 48)       # 长斜线第一段控制点 2（靠近 V；V→C2 方向是进入 V 的切线）
V  = (70, 84)       # 相接点，画布约 55% 宽、66% 高
C3 = (58, 104)      # 长斜线第二段控制点 1（靠近 V；与 V→C2 近似同向，保证过 V 时切线连续）
C4 = (46, 124)      # 长斜线第二段控制点 2（靠近 E）
E  = (-12, 122)     # 长斜线终点（左边缘外）
# 短臂 ARM：起点 A（左上，画布外）→ V；接近 V 时很陡（C6 到 V 方向 (14,48)），像一笔汇入
A  = (-12, -12)
C5 = (22, 2)
C6 = (56, 36)

# ---- 线 ----
STROKE = 22         # 白线宽度，约画布 17%（16 像素下约 2.75 像素）

# ---- 配色：三块区域，各一条两色渐变 ----
# (起点色, 终点色, x1, y1, x2, y2)；渐变坐标在画布坐标系里（userSpaceOnUse）
TOP   = ("#FF8A5B", "#FF3D6E", 30, 0, 110, 60)      # 上方（两臂之间）：暖橙 → 玫红
LEFT  = ("#24166B", "#6C3BE0", 0, 10, 60, 115)      # 左侧（短臂以下）：靛紫 → 亮紫
RIGHT = ("#FFC857", "#FF8A3D", 130, 40, 50, 130)    # 右下（尾巴一侧）：金黄 → 橙


def p(pt):
    return f"{pt[0]} {pt[1]}"


def build():
    arm = f"M{p(A)} C{p(C5)} {p(C6)} {p(V)}"
    tail = f"M{p(S)} C{p(C1)} {p(C2)} {p(V)} C{p(C3)} {p(C4)} {p(E)}"
    # 左侧区域：沿短臂到 V，再沿长斜线下半到 E，沿画布左边外缘回到 A（闭合）
    left = f"M{p(A)} C{p(C5)} {p(C6)} {p(V)} C{p(C3)} {p(C4)} {p(E)} L{p(A)} Z"
    # 右下区域：从 S 向右越过画布到右下外角，沿底边到左下外角，再沿左边外缘到 E，
    # 然后沿长斜线反向回到 V、再回到 S（反向时每段的两个控制点顺序对调）
    right = (f"M{p(S)} L{SIZE + 22} {S[1]} L{SIZE + 22} {SIZE + 22} L{E[0]} {SIZE + 22} L{p(E)} "
             f"C{p(C4)} {p(C3)} {p(V)} C{p(C2)} {p(C1)} {p(S)} Z")

    def grad(name, g):
        c1, c2, x1, y1, x2, y2 = g
        return (f'<linearGradient id="{name}" gradientUnits="userSpaceOnUse" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}">'
                f'<stop offset="0" stop-color="{c1}"/><stop offset="1" stop-color="{c2}"/></linearGradient>')

    return f'''<!-- yodo 图标：整个图标面就是一个 y。由 brand/icon.py 生成，不要手改；设计说明见 brand/icon.md。 -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}">
  <defs>
    <!-- 三块区域各一条渐变：上方（两臂之间）暖橙到玫红，左侧靛紫，右下金黄到橙 -->
    {grad("top", TOP)}
    {grad("left", LEFT)}
    {grad("right", RIGHT)}
    <clipPath id="tile"><rect width="{SIZE}" height="{SIZE}" rx="{RX}"/></clipPath>
  </defs>
  <g clip-path="url(#tile)">
    <!-- 底色即上方区域；左侧、右下两块盖在上面 -->
    <rect width="{SIZE}" height="{SIZE}" fill="url(#top)"/>
    <path d="{left}" fill="url(#left)"/>
    <path d="{right}" fill="url(#right)"/>
    <!-- 两条白线画出 y：短臂（左上到相接点）和长斜线（右上经相接点，尾巴向左弯出左边缘） -->
    <path d="{arm}" stroke="#fff" stroke-width="{STROKE}" stroke-linecap="round" fill="none"/>
    <path d="{tail}" stroke="#fff" stroke-width="{STROKE}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </g>
</svg>
'''


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon.svg")
    open(out, "w", encoding="utf8").write(build())
    print(f"已生成 {out}")
