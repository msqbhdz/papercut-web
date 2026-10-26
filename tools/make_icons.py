"""由程序化几何绘制生成剪纸窗花 PWA 图标（不读取外部图片、不联网）。

设计坐标系：中心 (0,0)，r=1.0 为内容半径；绘制后按 content_scale 缩进到
正方形画布内，maskable 版本用更小的 content_scale 留出安全边距。
"""

from pathlib import Path
import math

from PIL import Image, ImageDraw

RED = (200, 16, 46)
WHITE = (255, 255, 255)
GOLD = (232, 182, 58)

SS = 4          # 超采样倍数：先画 4 倍图，再用 LANCZOS 缩回目标尺寸
FOLDS = 8       # 8 折对称
ICON_SCALE = 0.88      # 普通图标：内容直径占 88%
MASKABLE_SCALE = 0.56  # maskable：内容直径占 56%，四边各留 22% 安全边距

LANCZOS = getattr(Image, 'Resampling', Image).LANCZOS
OUT_DIR = Path(__file__).resolve().parent.parent / 'icons'


class Painter:
    def __init__(self, size, content_scale):
        self.size = size
        self.c = size / 2.0
        self.unit = (size / 2.0) * content_scale

    def pt(self, r, deg):
        a = math.radians(deg)
        return (self.c + self.unit * r * math.cos(a), self.c + self.unit * r * math.sin(a))

    def px(self, value):
        return max(1, int(round(self.unit * value)))


def arc(draw, p, r, a0, a1, width, fill=WHITE):
    steps = max(12, int(abs(a1 - a0) * 2))
    pts = [p.pt(r, a0 + (a1 - a0) * i / steps) for i in range(steps + 1)]
    w = p.px(width)
    draw.line(pts, fill=fill, width=w, joint='curve')
    for x, y in (pts[0], pts[-1]):
        cap = w / 2.0
        draw.ellipse([x - cap, y - cap, x + cap, y + cap], fill=fill)


def leaf(draw, p, r0, r1, half, base, power=0.85, steps=72, fill=WHITE):
    upper, lower = [], []
    for i in range(steps + 1):
        t = i / steps
        r = r0 + (r1 - r0) * t
        h = half * math.sin(math.pi * t) ** power
        spread = math.degrees(math.atan2(h, r))
        upper.append(p.pt(r, base + spread))
        lower.append(p.pt(r, base - spread))
    draw.polygon(upper + lower[::-1], fill=fill)


def dot(draw, p, r, deg, radius, fill=WHITE):
    x, y = p.pt(r, deg)
    rad = p.unit * radius
    draw.ellipse([x - rad, y - rad, x + rad, y + rad], fill=fill)


def star(draw, p, r_out, r_in, points, fill):
    pts = []
    for i in range(points * 2):
        r = r_out if i % 2 == 0 else r_in
        pts.append(p.pt(r, -90.0 + 360.0 * i / (points * 2)))
    draw.polygon(pts, fill=fill)


def motif(draw, p, base):
    # 主轴长花瓣
    leaf(draw, p, 0.20, 0.95, 0.105, base)
    # 外侧弧形切口（对称于主轴）
    arc(draw, p, 0.70, base + 14, base + 31, 0.030)
    arc(draw, p, 0.70, base - 31, base - 14, 0.030)
    # 内圈连弧
    arc(draw, p, 0.30, base - 20, base + 20, 0.028)
    # 花瓣两侧的小圆点
    dot(draw, p, 0.40, base + 12, 0.030)
    dot(draw, p, 0.40, base - 12, 0.030)
    # 落在折缝上的外圈圆钉
    dot(draw, p, 0.955, base + 22.5, 0.022)
    dot(draw, p, 0.955, base - 22.5, 0.022)


def center(draw, p):
    # 白色纸环
    outer = p.unit * 0.150
    inner = p.unit * 0.108
    x, y = p.c, p.c
    draw.ellipse([x - outer, y - outer, x + outer, y + outer], fill=WHITE)
    draw.ellipse([x - inner, y - inner, x + inner, y + inner], fill=RED)
    # 金色八角花心
    star(draw, p, 0.082, 0.034, FOLDS, GOLD)


def render(size, content_scale):
    hi = size * SS
    p = Painter(hi, content_scale)
    img = Image.new('RGB', (hi, hi), RED)
    draw = ImageDraw.Draw(img)
    for k in range(FOLDS):
        motif(draw, p, 360.0 * k / FOLDS)
    center(draw, p)
    return img.resize((size, size), LANCZOS)


JOBS = (
    ('icon-180.png', 180, ICON_SCALE),
    ('icon-192.png', 192, ICON_SCALE),
    ('icon-512.png', 512, ICON_SCALE),
    ('icon-maskable-512.png', 512, MASKABLE_SCALE),
)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, size, scale in JOBS:
        img = render(size, scale)
        path = OUT_DIR / name
        img.save(path, format='PNG', optimize=True)
        print('%-24s %dx%d %s %d bytes' % (name, img.width, img.height, img.mode, path.stat().st_size))


if __name__ == '__main__':
    main()
