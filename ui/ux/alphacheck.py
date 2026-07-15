#!/usr/bin/env python3
"""See-through verification: regenerate shots (alphashot.mjs), then assert
pane interiors blend the backdrop image at the pane-opacity alpha, and the
split gap shows the raw image. Usage: python3 alphacheck.py"""
import json, math, subprocess, sys
from PIL import Image

HERE = '/home/xuehaonan/mymux/ui/ux'
if '--analyze-only' not in sys.argv:
    r = subprocess.run(['node', f'{HERE}/alphashot.mjs'], capture_output=True, text=True,
                       env=dict(__import__('os').environ, PLAYWRIGHT_BROWSERS_PATH='0'))
    if r.returncode != 0:
        print(r.stdout, r.stderr); sys.exit(1)

def wall(x, y, w=1440, h=900):
    t = (x / w + y / h) / 2
    r_ = int(20 + 200 * max(0, t - 0.5) * 2 + 40 * math.sin(t * 6.28))
    g = int(30 + 90 * (1 - abs(t - 0.5) * 2))
    b = int(80 + 140 * (1 - t))
    return (min(255, r_), min(255, g), min(255, b))

PANE_BG = (11, 14, 20)
def blend(fg, bg, a): return tuple(round(a * f + (1 - a) * b) for f, b in zip(fg, bg))
def close(got, exp, tol=16): return all(abs(a - e) <= tol for a, e in zip(got, exp))

see = Image.open(f'{HERE}/shots/alpha-see.png').convert('RGB')
solid = Image.open(f'{HERE}/shots/alpha-solid.png').convert('RGB')
noimg = Image.open(f'{HERE}/shots/alpha-noimg.png').convert('RGB')
dflt = Image.open(f'{HERE}/shots/alpha-default.png').convert('RGB')
layout = json.load(open(f'{HERE}/shots/alpha-layout.json'))
panes = sorted(layout, key=lambda p: p['x'])
a, b = panes[0], panes[1]
interior = (int(a['x'] + a['w'] * 0.5), int(a['y'] + a['h'] * 0.8))
# Split panes tile flush (cell-exact); the see-through #term strip is the
# partial row BELOW the last pane row, at the window's bottom edge.
bottom = max(p['y'] + p['h'] for p in panes)
gap = (int(a['x'] + a['w'] / 2), int(bottom + (900 - bottom) / 2))

fails = []
def check(name, got, exp):
    ok = close(got, exp)
    print(f"{'✓' if ok else '✗ FAIL'} {name}: expect~{exp} got{got}")
    if not ok: fails.append(name)

ix, iy = interior
check('pane interior = 60% pane-bg over image', see.getpixel(interior), blend(PANE_BG, wall(ix, iy), 0.6))
gx, gy = gap
check('split gap = raw image', see.getpixel(gap), wall(gx, gy))
# Slider-without-backdrop must be INERT: identical rendering to the plain
# default at both sample points (whatever the stock look is there).
check('no-image slider is inert (interior matches default)', noimg.getpixel(interior), dflt.getpixel(interior))
check('no-image slider is inert (gap strip matches default)', noimg.getpixel(gap), dflt.getpixel(gap))
# The pane surface is the single terminal background: rows AND empty voids
# show pane-bg in every mode (was stock #000 voids before the unification).
check('default voids are pane-bg, not black', dflt.getpixel(interior), PANE_BG)
# Image set but slider at 100%: panes stay solid (image in gaps/bar only).
check('image at 100% opacity keeps solid pane', solid.getpixel(interior), PANE_BG)
sys.exit(1 if fails else 0)
