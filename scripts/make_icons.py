#!/usr/bin/env python3
"""Generate the placeholder pass images (crimson rounded square + heart)."""
from PIL import Image, ImageDraw

CRIMSON = (164, 19, 60, 255)
DEEP = (128, 15, 47, 255)
WHITE = (255, 255, 255, 255)

def heart(draw, cx, cy, size, fill):
    r = size // 4
    draw.ellipse([cx - 2 * r, cy - r - r // 2, cx, cy + r // 2 - r // 2], fill=fill)
    draw.ellipse([cx, cy - r - r // 2, cx + 2 * r, cy + r // 2 - r // 2], fill=fill)
    draw.polygon([(cx - 2 * r, cy - r // 4), (cx + 2 * r, cy - r // 4), (cx, cy + size // 2)], fill=fill)

def icon(px):
    img = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    rad = px // 5
    d.rounded_rectangle([0, 0, px - 1, px - 1], radius=rad, fill=CRIMSON)
    heart(d, px // 2, px // 2 - px // 12, int(px * 0.5), WHITE)
    return img

def logo(w, h):
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    heart(d, h // 2, h // 2 - h // 10, int(h * 0.7), WHITE)
    return img

if __name__ == '__main__':
    icon(29).save('assets/icon.png')
    icon(58).save('assets/icon@2x.png')
    icon(87).save('assets/icon@3x.png')
    logo(50, 50).save('assets/logo.png')
    logo(100, 100).save('assets/logo@2x.png')
    print('wrote 5 images to assets/')
