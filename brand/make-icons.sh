#!/bin/sh
# 生成图标：先由 brand/icon.py 生成 brand/icon.svg，再用 rsvg-convert 出扩展用的 PNG。
# 需要 python3 和 rsvg-convert（macOS：brew install librsvg）。用法：sh brand/make-icons.sh
set -e
cd "$(dirname "$0")/.."
python3 brand/icon.py
out=skills/yodo/src/chrome-extension/icons
mkdir -p "$out"
for size in 16 32 48 128; do
  rsvg-convert -w "$size" -h "$size" brand/icon.svg -o "$out/$size.png"
done
echo "已生成 $out/{16,32,48,128}.png"
