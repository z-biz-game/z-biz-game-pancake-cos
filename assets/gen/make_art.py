#!/usr/bin/env python3
"""烙饼 PANCAKE 的位图资产工厂：一条命令重生成 icons/ 与 art/ 下的全部真实 PNG。

    python3 assets/gen/make_art.py            # 全量
    python3 assets/gen/make_art.py --only art  # 只重生成游戏内纹理/sprite

母题不是装饰，是玩法的一帧定格：一摞饼从下往上变小，最上面一张焦面朝下之前的那个状态，
铲刃从左边插进第二张饼下面 —— 也就是"把那张饼和它上面的一切整段翻回来"这一铲。

颜色不凭空编：全部十六进制从 css/game.css 的自定义属性里实测抽取（palette()），
所以调色板改了重跑一次，图标和游戏内纹理会跟着一起换。

可复现：唯一的随机源（铁板麻点）走 random.Random(7)；每张图按尺寸原生矢量绘制后再超采样缩小，
不依赖任何外部素材、字体之外的库（Pillow 只用于画图与缩放）。
"""
import argparse
import math
import os
import random
import re
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
TOKEN_RE = re.compile(r'--([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\b')

# 需要哪些 token：缺一个就直接失败，而不是悄悄用内置色画出一张和主题无关的图。
WANTED = [
    'pancake-plain', 'pancake-plain-2', 'pancake-burnt', 'pancake-edge', 'pancake-syrup',
    'plate', 'bg', 'bg-2', 'panel', 'ink', 'ink-dim', 'ink-faint', 'warn', 'good', 'press-light',
]

FONT_CANDIDATES = [
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/System/Library/Fonts/Supplemental/Hiragino Sans GB.ttc',
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
]

# The motif's own span is y 0.373..0.93 / x 0.04..0.96, i.e. hung at the bottom of the frame.
# 放大 1.15 之后把中心搬回 (0.5, 0.52) —— 图标上留出一线灶台的气口，下面压住盘子。
FIT = {'scale': 1.15, 'ox': -0.075, 'oy': -0.2275}


def rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def mix(a, b, t):
    return tuple(int(round(a[i] * (1 - t) + b[i] * t)) for i in range(3))


def palette():
    """First declaration wins ⇒ the dark block, which is the shipped default palette."""
    css = open(os.path.join(ROOT, 'css', 'game.css'), encoding='utf8').read()
    found = {}
    for name, hexv in TOKEN_RE.findall(css):
        found.setdefault(name, hexv)
    missing = [k for k in WANTED if k not in found]
    if missing:
        sys.exit('game.css 里找不到这些 token：' + ', '.join(missing) + '（配色不许凭空编，脚本停在这里）')
    return {k: rgb(v) for k, v in found.items() if k in WANTED}


def font(px):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, px)
            except Exception:
                continue
    return ImageFont.load_default()


def bg_gradient(P, w, h):
    """Vertical bg-2 -> bg with a centred radial lift, the same lamp the CSS page hangs."""
    top, bot = P['bg-2'], P['bg']
    img = Image.new('RGB', (w, h))
    dr = ImageDraw.Draw(img)
    for y in range(h):
        dr.line([(0, y), (w, y)], fill=mix(top, bot, y / max(1, h - 1)))
    glow = Image.radial_gradient('L').resize((w, h), Image.BICUBIC)
    lift = Image.new('RGB', (w, h), mix(top, P['plate'], 0.16))
    return Image.composite(lift, img, glow.point(lambda v: int(v * 0.55)))


def speckle(dr, cx, cy, rx, ry, colour, count, seed=7, scale=1.0, wrap=None):
    """Cast-iron pits. `wrap` (tile size) repeats each pit across the edges so the tile seams."""
    rnd = random.Random(seed)
    for _ in range(count):
        a = rnd.uniform(0, math.tau)
        r = math.sqrt(rnd.random())
        x = cx + math.cos(a) * rx * r
        y = cy + math.sin(a) * ry * r
        rad = rnd.uniform(0.7, 2.4) * scale
        spots = [(x, y)]
        if wrap:
            for dx in (-wrap, 0, wrap):
                for dy in (-wrap, 0, wrap):
                    if dx or dy:
                        spots.append((x + dx, y + dy))
        for sx, sy in spots:
            dr.ellipse([sx - rad, sy - rad, sx + rad, sy + rad], fill=colour)


def stack(P, n=4, cut=1, burnt=True):
    """The unit-space rects of the stack, bottom (largest) first, exactly as view.js lays them out."""
    heights = [0.68, 0.55, 0.42, 0.30, 0.22, 0.16][:n]
    rh = 0.118
    base = 0.845
    out = []
    for i, wfrac in enumerate(heights):
        size = n - i  # bottom is the biggest pancake
        tone = 0.42 + 0.58 * (size / n)
        out.append({
            'w': wfrac,
            'top': base - (i + 1) * rh,
            'h': rh * 0.92,
            'fill': mix(P['pancake-plain'], P['pancake-syrup'], tone),
            'line': mix(P['pancake-plain'], P['pancake-edge'], 0.55 + 0.2 * tone),
            'burnt': burnt and i == n - 1,
            'cut': i == cut,
        })
    return out


def draw_motif(img, P, *, griddle=True, spatula=True, scale=1.0, ox=0.0, oy=0.0):
    """Paint the stack into `img`. All coordinates are unit fractions of the image height."""
    S = img.height
    dr = ImageDraw.Draw(img, 'RGBA')

    def box(x0, y0, x1, y1):
        return [(x0 * S) * scale + ox, (y0 * S) * scale + oy, (x1 * S) * scale + ox, (y1 * S) * scale + oy]

    if griddle:
        # Side-on cast iron: a dark shell, a brighter cooking face, pits only on the face and a
        # specular arc on the near rim — otherwise the plate reads as a brown smudge.
        dr.ellipse(box(0.03, 0.795, 0.97, 0.945), fill=mix(P['plate'], (0, 0, 0), 0.68) + (255,))
        dr.ellipse(box(0.075, 0.812, 0.925, 0.928), fill=mix(P['plate'], (0, 0, 0), 0.18) + (255,))
        speckle(dr, 0.5 * S * scale + ox, 0.87 * S * scale + oy, 0.4 * S * scale, 0.05 * S * scale,
                mix(P['plate'], (0, 0, 0), 0.62) + (170,), 90 if S > 600 else 24, scale=scale)
        dr.arc(box(0.11, 0.822, 0.89, 0.922), 20, 160,
               fill=mix(P['plate'], P['press-light'], 0.42) + (90,), width=max(1, int(0.006 * S * scale)))
        # The stack has to stand on something: a thin contact shadow under the widest pancake.
        dr.ellipse(box(0.17, 0.838, 0.83, 0.884), fill=(0, 0, 0, 34))

    for p in stack(P):
        cx = 0.5
        x0, y0 = cx - p['w'] / 2, p['top']
        rad = p['h'] / 2
        dr.rounded_rectangle(box(x0, y0, x0 + p['w'], y0 + p['h']), radius=rad * S * scale,
                             fill=p['fill'] + (255,), outline=p['line'] + (255,),
                             width=max(1, int(0.006 * S * scale)))
        if p['burnt']:
            edge = p['h'] * 0.34
            dr.rounded_rectangle(box(x0, y0, x0 + p['w'], y0 + edge),
                                 radius=min(edge * S * scale / 2, rad * S * scale * 0.9),
                                 fill=P['pancake-burnt'] + (255,))
            dr.line(box(x0 + 0.02, y0 + edge, x0 + p['w'] - 0.02, y0 + edge),
                    fill=P['pancake-edge'] + (255,), width=max(1, int(0.008 * S * scale)))
        # syrup gloss: one straight highlight inside each pancake's own body
        dr.line(box(x0 + 0.055, y0 + p['h'] * 0.3, x0 + p['w'] - 0.055, y0 + p['h'] * 0.3),
                fill=mix(p['fill'], P['press-light'], 0.34) + (120,),
                width=max(1, int(0.008 * S * scale)))

    if spatula:
        under = stack(P)[-2]  # the cut one pancake below the top: the move this mark is about
        blade_y = under['top'] + under['h'] * 0.5
        metal = mix(P['plate'], P['press-light'], 0.82)
        dark = mix(P['plate'], P['press-light'], 0.45)
        dr.rounded_rectangle(box(0.02, blade_y - 0.014, 0.44, blade_y + 0.014),
                             radius=0.014 * S * scale, fill=metal + (255,))
        dr.line(box(0.02, blade_y + 0.014, 0.44, blade_y + 0.014), fill=dark + (255,),
                width=max(1, int(0.006 * S * scale)))
        dr.rounded_rectangle(box(0.005, blade_y - 0.022, 0.10, blade_y + 0.022),
                             radius=0.02 * S * scale, fill=mix(P['pancake-edge'], (0, 0, 0), 0.3) + (255,))


def fit_motif(img, P, **kw):
    """draw_motif's unit framing puts the stack in the lower half; FIT recentres and enlarges it."""
    S = img.height
    return draw_motif(img, P, scale=FIT['scale'], ox=FIT['ox'] * S, oy=FIT['oy'] * S, **kw)


def render_app(size, P, maskable=False, opaque=False):
    """Rounded-square app icon (maskable: full bleed) rendered natively at `size`, then supersampled."""
    ss = 4 if size <= 256 else 3 if size <= 512 else 2
    S = size * ss
    img = bg_gradient(P, S, S).convert('RGBA')
    fit_motif(img, P)

    if maskable:
        # The launcher's safe zone is the centre 80% circle: shrink the whole mark into it and
        # refill the border-to-border bleed, so nothing that matters gets cropped away by iOS.
        inner = img.resize((int(S * 0.76), int(S * 0.76)), Image.LANCZOS)
        base = bg_gradient(P, S, S).convert('RGBA')
        base.alpha_composite(inner, ((S - inner.width) // 2, (S - inner.height) // 2))
        return base.resize((size, size), Image.LANCZOS)

    if opaque:
        # apple-touch-icon must carry no alpha: flatten onto the griddle colour *before* the
        # corners are cut, otherwise the corner pixels come back as black after the flatten.
        flat = Image.new('RGBA', (S, S), P['bg'] + (255,))
        flat.alpha_composite(img)
        img = flat
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.2237), fill=255)
    img.putalpha(mask)
    # A rim light so the mark survives a dark wallpaper.
    rim = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(rim).rounded_rectangle(
        [int(S * 0.012), int(S * 0.012), int(S * 0.988), int(S * 0.988)],
        radius=int(S * 0.21), outline=P['warn'] + (70,), width=max(1, int(S * 0.008)))
    return Image.alpha_composite(img, rim).resize((size, size), Image.LANCZOS)


def render_tile(size, P):
    """Tileable cast-iron texture for #board-wrap: the pits wrap across all four edges."""
    S = size * 4
    img = Image.new('RGBA', (S, S), mix(P['panel'], (0, 0, 0), 0.12) + (255,))
    dr = ImageDraw.Draw(img, 'RGBA')
    speckle(dr, S / 2, S / 2, S * 0.75, S * 0.75, mix(P['panel'], (0, 0, 0), 0.55) + (90,), 420, wrap=S)
    speckle(dr, S / 2, S / 2, S * 0.75, S * 0.75, mix(P['press-light'], P['panel'], 0.5) + (34,), 150, seed=11, wrap=S)
    # A faint brushed arc so the tile is not pure noise; drawn through the centre twice for the wrap.
    for cx in (0, S):
        dr.arc([cx - S * 0.9, -S * 0.4, cx + S * 0.9, S * 1.4], 20, 160,
               fill=mix(P['plate'], P['panel'], 0.55) + (40,), width=int(S * 0.004))
    return img.resize((size, size), Image.LANCZOS)


def render_sprite(size, P):
    """Transparent stack sprite (the win-screen plate, and the source of the 180px touch icon)."""
    ss = 4 if size <= 256 else 3
    S = size * ss
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    fit_motif(img, P)
    return img.resize((size, size), Image.LANCZOS)


def render_og(w, h, P, rows):
    ss = 2
    W, H = w * ss, h * ss
    img = bg_gradient(P, W, H).convert('RGBA')
    dr = ImageDraw.Draw(img, 'RGBA')
    # Left: the mark on its own griddle, sized off the card height so the plate never gets clipped.
    side = int(H * 0.86)
    plate = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    fit_motif(plate, P)
    lx = int(W * 0.035)
    img.alpha_composite(plate, (lx, (H - side) // 2))
    rule_x = lx + side + int(W * 0.022)
    tx = rule_x + int(W * 0.022)
    max_w = W - tx - int(W * 0.04)
    dr.line([(rule_x, int(H * 0.14)), (rule_x, int(H * 0.86))], fill=P['pancake-syrup'] + (210,), width=3 * ss)

    def line(y, text, px, colour, weight=1.0):
        """Shrink the type until the run fits the column: a card that crops its own headline lies."""
        size = max(12, int(px * weight))
        f = font(size)
        while size > 12 and dr.textlength(text, font=f) > max_w:
            size -= 2
            f = font(size)
        dr.text((tx, y), text, font=f, fill=colour)
        return size

    y = int(H * 0.19)
    y += line(y, rows['title'], 64 * ss, P['ink'] + (255,)) + int(18 * ss)
    dr.line([(tx, y), (tx + int(max_w * 0.42), y)], fill=P['warn'] + (230,), width=4 * ss)
    y += int(22 * ss)
    for text in rows['sub']:
        y += line(y, text, 26 * ss, mix(P['ink'], P['bg'], 0.18) + (255,)) + int(14 * ss)
    y = int(H * 0.72)
    for text in rows['foot']:
        y += line(y, text, 19 * ss, P['ink-faint'] + (255,)) + int(11 * ss)
    return img.resize((w, h), Image.LANCZOS)


def write(rel, img):
    path = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, 'PNG', optimize=True)
    return path, img.size, os.path.getsize(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', choices=['icons', 'art'], help='只重生成一组')
    a = ap.parse_args()
    P = palette()
    out = []

    if a.only in (None, 'icons'):
        for size in (16, 32, 48, 96):
            out.append(write(f'icons/favicon-{size}.png', render_app(size, P)))
        # apple-touch-icon: iOS refuses alpha, so it gets the same mark on a solid griddle.
        out.append(write('icons/apple-touch-icon.png', render_app(180, P, opaque=True).convert('RGB')))
        out.append(write('icons/icon-192.png', render_app(192, P)))
        out.append(write('icons/icon-512.png', render_app(512, P)))
        out.append(write('icons/icon-maskable-512.png', render_app(512, P, maskable=True).convert('RGB')))
        out.append(write('icons/icon-1024.png', render_app(1024, P)))

    if a.only in (None, 'art'):
        out.append(write('art/griddle-256.png', render_tile(256, P)))
        out.append(write('art/win-plate-240.png', render_sprite(240, P)))
        out.append(write('art/og-1200x630.png', render_og(1200, 630, P, {
            'title': '烙饼 PANCAKE',
            'sub': ['前缀翻转排序：一铲翻起最上面若干张',
                    '每关的 par 都是全图广度优先量出的下界'],
            'foot': ['零依赖 · 纯 ES module · 可离线安装',
                     'github.com/z-biz-game/z-biz-game-pancake-cos'],
        })))

    for path, size, n in out:
        print('%-34s %4dx%-4d %7d B' % (os.path.relpath(path, ROOT), size[0], size[1], n))
    print('=> %d files, palette from css/game.css: %s' % (len(out), ' '.join(
        '%s#%02x%02x%02x' % (k, *P[k]) for k in ('pancake-plain', 'pancake-syrup', 'pancake-burnt', 'plate'))))


if __name__ == '__main__':
    main()
