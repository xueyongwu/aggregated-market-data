"""生成扩展图标 icon{16,32,48,128}.png 和 iOS 主屏图标 apple-touch-icon-*.png。
改了尺寸/配色重跑一次即可(仓库根目录跑: python chrome-ext/make_icon.py)。

Chrome 的 action 图标只吃位图, 不认 SVG, 所以这里用 PIL 画。
造型是一根上行分时线 + 端点圆点, 刻意压在左上~右上: badge 恒在右下角, 那块会被盖住。
16px 下文字("NQ")糊成一坨, 折线还认得出, 故不用文字。

iOS 的 apple-touch-icon 同样不认 SVG/data-URI(favicon 那两个 emoji data-URI 只对桌面浏览器
有效), 所以另画 PNG。两页图标必须不同, 否则主屏两个入口分不出。
"""
from PIL import Image, ImageDraw

BLUE = (57, 135, 229, 255)  # --blue, 同 etf.html
PTS = [(0.08, 0.78), (0.34, 0.46), (0.52, 0.61), (0.90, 0.15)]
S = 8  # 超采样倍数, PIL 的线段接头有锯齿, 放大画再缩回去就平滑了

for size in (16, 32, 48, 128):
    n = size * S
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    xy = [(x * n, y * n) for x, y in PTS]
    w = int(0.15 * n)
    # 末段方向的单位向量, 箭头照它转
    (x2, y2), (x3, y3) = xy[-2], xy[-1]
    seg = ((x3 - x2) ** 2 + (y3 - y2) ** 2) ** 0.5
    ux, uy = (x3 - x2) / seg, (y3 - y2) / seg
    al, aw = 0.34 * n, 0.21 * n  # 箭头长 / 半宽; 半宽要明显大于 w/2 才看得出是箭头
    # 折线只画到箭头根部稍里面一点, 免得箭头两侧漏出线角
    d.line(xy[:-1] + [(x3 - ux * al * 0.8, y3 - uy * al * 0.8)], fill=BLUE, width=w, joint="curve")
    cx, cy = xy[0]  # 圆头: PIL 没有 linecap, 起点补个圆
    d.ellipse([cx - w / 2, cy - w / 2, cx + w / 2, cy + w / 2], fill=BLUE)
    bx, by = x3 - ux * al, y3 - uy * al
    d.polygon([(x3, y3), (bx - uy * aw, by + ux * aw), (bx + uy * aw, by - ux * aw)], fill=BLUE)
    img.resize((size, size), Image.LANCZOS).save(f"chrome-ext/icon{size}.png")
    print(f"icon{size}.png")

# --- iOS 主屏图标 ---
# 满幅纯色底 + 白色图形, 不留内边距: iOS 自己套圆角遮罩, 再留白就成了"方块套方块"。
# 两页靠"图形 + 颜色"双重区分(折线/红, 柱状/蓝), 缩到 60px 也认得出是哪个。
TOUCH = 180  # iPhone 3x 主屏尺寸, 系统自己缩到别的档
UP = (228, 83, 74)  # --up, 同 index.html
BLUE_BG = (57, 135, 229)  # --blue, 同 etf.html
PURPLE = (124, 92, 214)  # us.html; 蓝已被 etf 占了, 换个色相才在主屏上分得开
WHITE = (255, 255, 255, 255)
LINE_PTS = [(0.16, 0.70), (0.39, 0.43), (0.56, 0.57), (0.84, 0.28)]
BARS = [(0.26, 0.52), (0.50, 0.34), (0.74, 0.21)]  # (中心x, 顶部y), 底边统一 0.78
# 横条(权重表): 左端统一 0.18, (中心y, 右端x)。竖柱是 etf 的, 这里必须横着才区分得开
HBARS = [(0.30, 0.84), (0.50, 0.62), (0.70, 0.44)]


def touch_icon(bg, draw_glyph):
    n = TOUCH * S
    img = Image.new("RGB", (n, n), bg)
    draw_glyph(ImageDraw.Draw(img), n)
    return img.resize((TOUCH, TOUCH), Image.LANCZOS)


def polyline(d, n):
    w = int(0.095 * n)
    xy = [(x * n, y * n) for x, y in LINE_PTS]
    d.line(xy, fill=WHITE, width=w, joint="curve")
    for cx, cy in (xy[0], xy[-1]):  # PIL 没有 linecap, 两端各补个圆
        d.ellipse([cx - w / 2, cy - w / 2, cx + w / 2, cy + w / 2], fill=WHITE)


def bars(d, n):
    w = 0.155 * n
    for cx, top in BARS:
        d.rounded_rectangle(
            [cx * n - w / 2, top * n, cx * n + w / 2, 0.78 * n], radius=w / 2, fill=WHITE
        )


def hbars(d, n):
    h = 0.135 * n
    for cy, right in HBARS:
        d.rounded_rectangle(
            [0.18 * n, cy * n - h / 2, right * n, cy * n + h / 2], radius=h / 2, fill=WHITE
        )


for name, bg, glyph in (("index", UP, polyline), ("etf", BLUE_BG, bars), ("us", PURPLE, hbars)):
    touch_icon(bg, glyph).save(f"apple-touch-icon-{name}.png")
    print(f"apple-touch-icon-{name}.png")
