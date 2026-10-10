#!/usr/bin/env python3
"""Build "Eyes", a Hermes pet: round googly eyes acting out what the agent
is doing. The repository ships the result in pet/eyes; run this to change it.
Needs ImageMagick (`magick`) for the lossless WebP.

    make-pet.py [OUT_DIR]          default ./pet/eyes

Hermes pets are petdex sprite atlases: 8 columns x 9 rows of 192x208 frames
(1536x1872), one row per state, six frames stepped per state over 1.1 s. Hermes
picks the row from the agent's activity and draws the pet in the classic CLI,
the modern TUI and the desktop app, so these eyes follow the agent into every
Hermes screen. Inside Hermes they react to the agent rather than the mouse:
Hermes owns those screens and drives the animation.

The rows, top to bottom, are the petdex order Hermes reads:

    idle            looking around, one blink
    running-right   busy, glancing right
    running-left    busy, glancing left
    waving          just finished: happy closed arcs
    jumping         celebrating: wide eyes, a hop and sparkles
    failed          something broke: sad tilted lids, looking down
    waiting         wants your input: looking down at the input box
    running         working: darting side to side
    review          thinking: looking up, lids lowered

Writes spritesheet.webp (lossless) and pet.json. Nothing is installed; copy
the folder into a profile's pets/ directory and select it with
`hermes -p PROFILE pets select eyes`.
"""
import json, math, os, struct, subprocess, sys, zlib

FW, FH, COLS, ROWS = 192, 208, 8, 9
W, H = FW * COLS, FH * ROWS

WHITE = (252, 250, 255)
RIM = (196, 184, 226)
SHADOW = (14, 4, 12)
IRIS_DARK = (14, 7, 18)
IRIS_LOW = (96, 72, 160)
LID = (124, 92, 214)
LID_DARK = (78, 52, 160)
LASH = (38, 16, 56)
GLOW = (182, 156, 255)
GOLD = (255, 214, 102)


def clamp(v):
    return 0.0 if v < 0 else 1.0 if v > 1 else v


def mix(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)


def ellipse_d(x, y, cx, cy, rx, ry):
    nx, ny = (x - cx) / rx, (y - cy) / ry
    q = math.hypot(nx, ny)
    if q < 1e-6:
        return -min(rx, ry)
    return (q - 1) / (math.hypot(nx / rx, ny / ry) / q)


def over(dst, col, a):
    """Paint `col` at alpha `a` over the RGBA float pixel `dst`."""
    if a <= 0:
        return dst
    r, g, b, da = dst
    na = a + da * (1 - a)
    if na <= 0:
        return dst
    return ((col[0] * a + r * da * (1 - a)) / na, (col[1] * a + g * da * (1 - a)) / na,
            (col[2] * a + b * da * (1 - a)) / na, na)


# --- one frame -------------------------------------------------------------------

RX, RY = 38.0, 44.0          # each eye
GAP = 88.0                   # centre to centre
PUPIL = 0.72                 # pupil radius as a share of the smaller eye radius


def eye_pixel(px, py, cx, cy, look, lid, tilt, side):
    """RGBA of one eye at a pixel. look: (-1..1, -1..1). lid: 0 open .. 1 shut.
    tilt: sad lids drop toward the outer corner. side -1 left eye, +1 right."""
    d = ellipse_d(px, py, cx, cy, RX, RY)
    out = (0.0, 0.0, 0.0, 0.0)
    shadow = clamp(0.5 - ellipse_d(px, py, cx, cy + 5, RX, RY) / 5) * 0.35
    out = over(out, SHADOW, shadow)
    cov = clamp(0.5 - d)
    if cov <= 0:
        return out
    nx, ny = (px - cx) / RX, (py - cy) / RY
    shade = clamp((math.hypot(nx, ny) - 0.55) / 0.45) ** 1.6
    light = clamp(1 - math.hypot(nx + 0.35, ny + 0.45) / 0.9) * 0.6
    col = mix(mix(WHITE, RIM, shade), (255, 255, 255), light)
    R = min(RX, RY) * PUPIL
    reach_x, reach_y = RX - R, RY - R
    ix, iy = cx + look[0] * reach_x, cy + look[1] * reach_y
    r = math.hypot(px - ix, py - iy)
    inner = clamp(0.5 - (d + 1.0))
    pc = clamp(0.5 - (r - R)) * inner
    if pc > 0:
        t = r / R
        low = clamp(((py - iy) / R + 0.15) / 0.85)
        ic = mix(IRIS_DARK, IRIS_LOW, low * 0.9 * clamp((t - 0.30) / 0.45))
        ic = mix(ic, (4, 2, 6), clamp(0.5 - (r - R * 0.40)) * 0.9)
        ic = mix(ic, IRIS_DARK, clamp((r - R * 0.88) / (R * 0.12)))
        big = ((px - ix + R * 0.36) / (R * 0.27)) ** 2 + ((py - iy + R * 0.34) / (R * 0.22)) ** 2
        ic = mix(ic, (255, 255, 255), clamp((1 - big) * R * 0.2))
        ic = mix(ic, (255, 255, 255), clamp(0.5 - (math.hypot(px - ix - R * 0.32, py - iy - R * 0.36) - R * 0.085)) * 0.85)
        col = mix(col, ic, pc)
    out = over(out, col, cov)
    if lid > 0 or tilt:
        top = cy - RY
        u = (px - cx) / RX * side                     # +1 at the outer corner
        edge = top + lid * 2 * RY * (1 - 0.12 * nx * nx) + tilt * RY * 0.55 * (u + 1) / 2
        a = clamp(0.5 - (py - edge)) * cov
        if a > 0:
            lc = mix(LID, LID_DARK, clamp((py - top) / (2 * RY)))
            lc = mix(lc, LASH, clamp(1.6 - abs(py - edge)) * 0.9)
            out = over(out, lc, a)
    return out


def happy_pixel(px, py, cx, cy):
    """A closed, smiling eye: an upward arc with a violet glow."""
    r = math.hypot(px - cx, (py - (cy + 14)) * 1.15)
    band = abs(r - 26) - 3.2
    if py > cy + 16:
        band = max(band, (py - (cy + 16)))       # only the top of the circle
    a = clamp(0.5 - band)
    glow = clamp(1 - (band + 1) / 6) * 0.45
    out = over((0.0, 0.0, 0.0, 0.0), GLOW, glow)
    return over(out, WHITE, a)


def sparkle(px, py, sx, sy, size):
    dx, dy = abs(px - sx), abs(py - sy)
    d = min(dx * 3 + dy, dx + dy * 3) - size
    return clamp(0.5 - d) + clamp(1 - (d + 1) / 5) * 0.4


def frame(spec):
    """Render one 192x208 frame from a pose spec into RGBA bytes."""
    look = spec.get("look", (0, 0))
    lid = spec.get("lid", 0.0)
    tilt = spec.get("tilt", 0.0)
    bob = spec.get("bob", 0.0)
    shift = spec.get("shift", 0.0)
    happy = spec.get("happy", False)
    sparkles = spec.get("sparkles", [])
    cy = FH / 2 + 6 + bob
    cxs = (FW / 2 - GAP / 2 + shift, FW / 2 + GAP / 2 + shift)
    buf = bytearray()
    for y in range(FH):
        py = y + 0.5
        for x in range(FW):
            px = x + 0.5
            pix = (0.0, 0.0, 0.0, 0.0)
            for side, cx in zip((-1, 1), cxs):
                if abs(px - cx) > RX + 10 or abs(py - cy) > RY + 12:
                    continue
                part = happy_pixel(px, py, cx, cy) if happy else eye_pixel(px, py, cx, cy, look, lid, tilt, side)
                pix = over(pix, part[:3], part[3])
            for sx, sy, size in sparkles:
                s = sparkle(px, py, sx, sy + bob, size)
                if s > 0:
                    pix = over(pix, GOLD, min(1.0, s))
            r, g, b, a = pix
            buf += bytes((min(255, int(r + 0.5)), min(255, int(g + 0.5)), min(255, int(b + 0.5)), min(255, int(a * 255 + 0.5))))
    return bytes(buf)


# --- the nine states -------------------------------------------------------------

def states():
    focused = 0.22
    return {
        "idle": [dict(look=(0, 0)), dict(look=(-0.7, 0)), dict(look=(-0.7, 0.1)),
                 dict(look=(0, 0)), dict(look=(0.7, -0.1)), dict(look=(0, 0), lid=1.0)],
        "running-right": [dict(look=(1, -0.1), lid=focused, shift=s, bob=b)
                          for s, b in ((0, 0), (3, -3), (6, 0), (3, -3), (0, 0), (3, -3))],
        "running-left": [dict(look=(-1, -0.1), lid=focused, shift=-s, bob=b)
                         for s, b in ((0, 0), (3, -3), (6, 0), (3, -3), (0, 0), (3, -3))],
        "waving": [dict(look=(0, 0)), dict(happy=True), dict(happy=True, bob=-3),
                   dict(happy=True), dict(happy=True, bob=-3), dict(look=(0, 0))],
        "jumping": [dict(look=(0, -0.3), bob=b, sparkles=sp) for b, sp in (
            (0, []), (-10, [(24, 40, 6)]), (-20, [(24, 40, 9), (170, 50, 6)]),
            (-12, [(170, 50, 9), (30, 150, 6)]), (-4, [(30, 150, 9)]), (0, []))],
        "failed": [dict(look=(0, 0.8), tilt=0.9, lid=0.12, shift=s) for s in (0, -2, 2, -2, 0, 0)],
        "waiting": [dict(look=(-0.5, 0.9)), dict(look=(-0.5, 0.9)), dict(look=(-0.5, 0.9), lid=0.5),
                    dict(look=(-0.5, 0.9), lid=1.0), dict(look=(-0.5, 0.9), lid=0.4), dict(look=(-0.5, 0.9))],
        "running": [dict(look=(x, 0), lid=focused) for x in (-1, -1, 1, 1, -1, 0)],
        "review": [dict(look=(x, -0.9), lid=0.18) for x in (0.5, 0.3, 0, -0.3, 0, 0.3)],
    }


ORDER = ["idle", "running-right", "running-left", "waving", "jumping", "failed", "waiting", "running", "review"]


def png(width, height, rgba):
    rows = b"".join(b"\x00" + rgba[y * width * 4:(y + 1) * width * 4] for y in range(height))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "pet", "eyes")
    os.makedirs(out, exist_ok=True)
    sheet = bytearray(W * H * 4)
    poses = states()
    for row, name in enumerate(ORDER):
        frames = [frame(spec) for spec in poses[name]]
        frames += [frames[-1]] * (COLS - len(frames))   # columns 7-8 are never stepped; repeat the last
        for col, fr in enumerate(frames):
            for y in range(FH):
                start = ((row * FH + y) * W + col * FW) * 4
                sheet[start:start + FW * 4] = fr[y * FW * 4:(y + 1) * FW * 4]
        print(f"  {name}", flush=True)
    tmp = os.path.join(out, "spritesheet.png")
    with open(tmp, "wb") as f:
        f.write(png(W, H, bytes(sheet)))
    subprocess.run(["magick", tmp, "-define", "webp:lossless=true", os.path.join(out, "spritesheet.webp")], check=True)
    os.unlink(tmp)
    with open(os.path.join(out, "pet.json"), "w") as f:
        json.dump({"id": "eyes", "displayName": "Eyes",
                   "description": "Round googly eyes that act out what your agent is doing: they look around when "
                                  "idle, dart while it works, look up while it thinks, down at your input while it waits, smile "
                                  "when it finishes, hop when it celebrates and droop when something fails.",
                   "spritesheetPath": "spritesheet.webp", "createdBy": "hermes-eyes"}, f, indent=2)
        f.write("\n")
    print(out)


if __name__ == "__main__":
    main()
