"""从一张源图生成 Windows 应用图标（多尺寸 .ico + .png）。

用法：
    <venv>/Scripts/python.exe scripts/make-icons.py "D:/work/AI LOGO/me.png"

依赖 Pillow —— 只在「换图标」时需要，不是应用运行时依赖：
    pip install pillow

为什么需要这个脚本而不是直接把 png 丢给 electron-builder：
Windows 的 .ico 是一个**多尺寸容器**。任务栏、标题栏、桌面、文件列表、
安装包各取不同尺寸。只塞一张 256x256 的图，系统在 16x16 场景会临时缩放，
结果就是边缘发糊、线条断掉。这里把 7 个标准尺寸一次性烧进 ico。
"""

import sys
from pathlib import Path

from PIL import Image

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else r"D:/work/AI LOGO/me.png")
OUT = Path(__file__).resolve().parent.parent / "build"
OUT.mkdir(exist_ok=True)

if not SRC.exists():
    sys.exit(f"源图不存在：{SRC}")

img = Image.open(SRC).convert("RGBA")
src_w, src_h = img.size

# 裁成正方形。源图本身是正方形，这里兜住非正方形的情况 ——
# 直接 resize 会把人像拉变形，裁掉多余边比拉伸好。
side = min(src_w, src_h)
img = img.crop(
    ((src_w - side) // 2, (src_h - side) // 2, (src_w + side) // 2, (src_h + side) // 2)
)

# Windows 图标的标准尺寸集合：
#   16/24/32 —— 任务栏、窗口标题栏、文件列表（小图标视图）
#   48/64    —— 桌面、中等图标视图
#   128/256  —— 安装包、资源管理器大图标、Alt+Tab
SIZES = [16, 24, 32, 48, 64, 128, 256]

# Pillow 保存 ICO 时会从原图逐尺寸重采样，LANCZOS 在缩小场景下比默认的
# NEAREST/BILINEAR 干净得多（细线条不会断）。
img.save(OUT / "icon.ico", format="ICO", sizes=[(s, s) for s in SIZES])

# BrowserWindow 的 icon 用 png（Windows 也接受 ico，但 png 在开发态更稳）
img.resize((256, 256), Image.LANCZOS).save(OUT / "icon.png", optimize=True)
# 512 留给高分屏与文档/关于页
img.resize((512, 512), Image.LANCZOS).save(OUT / "icon-512.png", optimize=True)

print(f"源图：{SRC}  ({src_w}x{src_h})")
print(f"输出：{OUT}")
for f in sorted(OUT.glob("icon*")):
    print(f"  {f.name:<16} {f.stat().st_size:>9,} B")

# 自检：读回 ico，确认容器里确实是 7 个尺寸而不是被悄悄合并成一个
with Image.open(OUT / "icon.ico") as ico:
    got = sorted(ico.ico.sizes())
print(f"ico 内含尺寸：{got}")
if len(got) != len(SIZES):
    sys.exit(f"❌ 期望 {len(SIZES)} 个尺寸，实际 {len(got)} 个")
