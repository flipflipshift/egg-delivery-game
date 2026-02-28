"""
Egg Delivery Game — Parameter Tuning Simulation
"""

import math

# ── Physics ──
GRAVITY = 9.81
THRUST_UP = 2 * GRAVITY    # 2g up — allows real climbing
THRUST_SIDE = 8.0
DRAG = 0.003                # low drag → terminal ~54 m/s → deep dives possible
MAX_SPEED = 60
JONES_X = 3000
WORLD_BOTTOM = 5000

# ── Thermal ──
A_POD = 0.08                # pod heats/cools fast (8% per second)
A_WHITE = 0.025             # white responds reasonably to pod
A_YOLK = 0.010              # yolk lags behind white
K_WHITE = 0.007             # white gelation rate (needs 0.9 target)
W_WHITE = 3
K_YOLK = 0.004              # yolk gelation rate (needs 0.6 target)
W_YOLK = 3
CRACK_THRESHOLD = 1.5       # °C per tick — only triggers on aggressive dives
CRACK_COOLDOWN = 20
BOIL_LIMIT = 20


def sigmoid(x):
    return 1 / (1 + math.exp(-x))


def outside_temp(depth):
    return 323 + 0.05 * depth


def peak(v, t, w):
    return max(0, 1 - abs(v - t) / w)


def sim(route, label="", verbose=False):
    x, y, vx, vy = 20.0, 0.0, 0.0, 0.0
    pod, wt, yt = 323.0, 323.0, 323.0
    wg, yg = 0.0, 0.0
    cracks, crack_cd, boil = 0, 0, 0
    prev_wt = 323.0
    t, ta = 0.0, 0.0
    dt = 1/60

    osc = 0
    prev_dir = 1  # 1=down, -1=up
    peak_y = 0
    trough_y = 0
    idle = 0

    for dur, th_up, th_x in route:
        st = 0
        while st < dur:
            ay = GRAVITY - (THRUST_UP if th_up else 0)
            vx += th_x * dt
            vy += ay * dt
            vx *= (1 - DRAG)
            vy *= (1 - DRAG)
            sp = math.sqrt(vx**2 + vy**2)
            if sp > MAX_SPEED:
                vx *= MAX_SPEED / sp
                vy *= MAX_SPEED / sp
            x += vx * dt
            y += vy * dt
            if y < 0: y, vy = 0, max(0, vy)
            if y > WORLD_BOTTOM: y, vy = WORLD_BOTTOM, min(0, vy)

            # Oscillation tracking
            d = 1 if vy > 1 else (-1 if vy < -1 else 0)
            if d != 0 and d != prev_dir:
                if d == -1 and y > 300:  # started going up from depth
                    if y - trough_y > 200:
                        osc += 1
                    trough_y = y
                elif d == 1:
                    trough_y = y
                prev_dir = d
            peak_y = max(peak_y, y)

            if abs(x - JONES_X) < 200 and y < 100:
                idle += dt

            # Thermal (1s ticks)
            ta += dt
            while ta >= 1.0:
                ta -= 1.0
                To = outside_temp(y)
                prev_wt = wt
                pod += A_POD * (To - pod)
                wt += A_WHITE * (pod - wt)
                yt += A_YOLK * (wt - yt)

                wc = wt - 273.15
                yc = yt - 273.15
                wg += K_WHITE * sigmoid((wc - 85) / W_WHITE)
                yg += K_YOLK * sigmoid((yc - 65) / W_YOLK)

                if crack_cd > 0: crack_cd -= 1
                if abs(wt - prev_wt) >= CRACK_THRESHOLD and crack_cd <= 0:
                    cracks += 1
                    crack_cd = CRACK_COOLDOWN

                pp = pod / 298
                bp = 4894 / (13.12 - math.log(pp / 1.013))
                if wt > bp:
                    boil += 1

            st += dt
            t += dt

            if verbose and int(t) % 10 == 0 and abs(t - int(t)) < dt:
                print(f"  t={t:.0f}s y={y:.0f}m pod={pod-273.15:.1f}°C "
                      f"wt={wt-273.15:.1f}°C yt={yt-273.15:.1f}°C "
                      f"wg={wg:.3f} yg={yg:.3f}")

    ws = 100 * peak(wg, 0.9, 0.15)
    ys = 100 * peak(yg, 0.6, 0.15)
    sc = max(0, ws + ys - boil * 10 - cracks**2 * 20)

    print(f"\n  {label}")
    print(f"  Time:{t:.0f}s Pos:({x:.0f},{y:.0f}) MaxDepth:{peak_y:.0f}m Osc:{osc}")
    print(f"  White:{wg:.3f}(tgt 0.9) Yolk:{yg:.3f}(tgt 0.6)")
    print(f"  Cracks:{cracks} Boil:{boil}s Idle:{idle/t*100:.1f}%")
    print(f"  Score: {sc:.0f} = w:{ws:.0f} + y:{ys:.0f} - boil:{boil*10} - crack:{cracks**2*20}")
    return {'wg': wg, 'yg': yg, 'score': sc, 'osc': osc, 'time': t,
            'idle_pct': idle/t*100 if t else 0, 'cracks': cracks, 'boil': boil,
            'peak_y': peak_y}


print("=" * 60)
print("  EGG DELIVERY — PARAMETER TUNING")
print(f"  Terminal vel: {GRAVITY / (60 * DRAG):.1f} m/s")
print(f"  Depth for 100°C outside: {(373-323)/0.05:.0f}m")
print(f"  Depth for 120°C outside: {(393-323)/0.05:.0f}m")
print("=" * 60)

UP = 1  # shorthand

# A: Straight across — should produce 0 cooking
sim([(150, UP, THRUST_SIDE)], "A: Straight across (no descent)")

# B: Single deep dive — should overcook white
sim([
    (30, 0, THRUST_SIDE * 0.3),   # freefall 30s
    (30, UP, THRUST_SIDE * 0.3),  # climb back
    (90, UP, THRUST_SIDE),         # cruise
], "B: Single dive (30s down, 30s up)", verbose=True)

# C: 2 oscillations — should undercook
r = []
for _ in range(2):
    r.append((25, 0, THRUST_SIDE * 0.4))
    r.append((25, UP, THRUST_SIDE * 0.4))
r.append((60, UP, THRUST_SIDE))
sim(r, "C: 2 oscillations")

# D: 4 oscillations — target optimal
r = []
for _ in range(4):
    r.append((25, 0, THRUST_SIDE * 0.4))
    r.append((25, UP, THRUST_SIDE * 0.4))
r.append((40, UP, THRUST_SIDE))
sim(r, "D: 4 oscillations (target optimal)", verbose=True)

# E: 6 oscillations — should overcook slightly
r = []
for _ in range(6):
    r.append((20, 0, THRUST_SIDE * 0.4))
    r.append((20, UP, THRUST_SIDE * 0.4))
r.append((20, UP, THRUST_SIDE))
sim(r, "E: 6 oscillations")

# F: 4 deep oscillations (30s each)
r = []
for _ in range(4):
    r.append((30, 0, THRUST_SIDE * 0.3))
    r.append((30, UP, THRUST_SIDE * 0.3))
r.append((20, UP, THRUST_SIDE))
sim(r, "F: 4 deep oscillations (30s each)", verbose=True)

# G: Aggressive deep dive — should trigger game over
sim([
    (60, 0, 0),          # freefall straight down
    (60, UP, 0),         # climb back
    (80, UP, THRUST_SIDE),
], "G: Single very deep dive (game-over test)")

# H: Realistic player — right thrust always on, oscillate vertically
# Player goes right the whole time, toggling vertical thrust
print("\n--- REALISTIC PLAYER ROUTES ---")
r = []
for _ in range(4):
    r.append((25, 0, THRUST_SIDE))      # fall + go right
    r.append((25, UP, THRUST_SIDE))     # climb + go right
sim(r, "H: 4 osc, always going right (realistic)")

r = []
for _ in range(5):
    r.append((22, 0, THRUST_SIDE))
    r.append((22, UP, THRUST_SIDE))
sim(r, "I: 5 osc, always going right")

r = []
for _ in range(4):
    r.append((30, 0, THRUST_SIDE))
    r.append((30, UP, THRUST_SIDE))
sim(r, "J: 4 long osc, always going right", verbose=True)

r = []
for _ in range(6):
    r.append((18, 0, THRUST_SIDE))
    r.append((18, UP, THRUST_SIDE))
sim(r, "K: 6 short osc, always going right")

print("\n" + "=" * 60)
