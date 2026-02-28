# Egg Game — Post-Playtest Refinements

## Implementation Order
- [x] 1. Constants changes (4, 5) + outsideTemp/outsidePressure updates
- [x] 2. Re-run sim → adjust if needed → iterate
  - A_WHITE 0.025→0.035, K_WHITE 0.007→0.009 to compensate for A_POD=0.3
  - Route J (4 long osc, always right) scores 150 — optimal
- [x] 3. Gameplay fixes (1, 6, 8)
- [x] 4. HUD/instructions changes (2, 7, 9)
- [x] 5. Visual polish (3)
- [x] 6. Commit (9fd2b34)
- [x] 7. Playwright verification — all checks pass
