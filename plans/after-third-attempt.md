# Egg Game — After Third Attempt Refinements

## Context

After a third playtest session, the designer noted six refinements in `egg.org` under "After third attempt". The changes aim to: (1) let players pause, (2) eliminate the cracking penalty that discouraged oscillation (the core mechanic), (3) make the heat stakes clearer by turning boiling into an instant-loss, (4) extend the trip to 10 km, and (5) make the instrument panel easier to read at a glance.

`W_WHITE` and `W_YOLK` are already `1` in the code — no change needed there.

## Critical File

`/Users/terencecoelho/Claude/Projects/Games/egg/game.js` — all changes are self-contained here.

---

## Changes

- [x] **1. Constants** — `JONES_X`: `7500` → `25000`; remove `CRACK_THRESHOLD`, `CRACK_COOLDOWN`, `MAX_CRACKS`, `BOIL_LIMIT`
- [x] **2. Thermal state object** — remove `cracks`, `crackCooldown`, `prevWhiteTemp` fields
- [x] **3. Input handler** — add P key toggle (`playing` ↔ `paused`); add `'paused'` to restart condition
- [x] **4. `updateThermal()`** — remove `prevWhiteTemp` save, remove crack detection block, replace boil check with instant game over
- [x] **5. `calculateScore()`** — remove `crackPenalty` from formula
- [x] **6. `resetGame()`** — remove `cracks`, `crackCooldown`, `prevWhiteTemp` from reset object
- [x] **7. `renderDevice()`** — delete crack visuals block
- [x] **8. `renderHUD()`** — expand panel, 2-line label+value format for all 7 metrics, remove `renderShellIntegrity()` call, remove boiling counter
- [x] **9. Add `renderPauseOverlay()`** — semi-transparent overlay with PAUSED text
- [x] **10. Main loop render branch** — handle `paused` state
- [x] **11. `renderFinalStats()`** — remove cracks line
- [x] **12. Instructions screen** — remove cracking mention, add boil = instant death, add P key control
