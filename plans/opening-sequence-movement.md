# Plan: Opening Sequence & Movement Changes

## Changes

- [x] Remove thruster/on-your-own text from opening sequence
- [x] Replace with orientation hints: "Jones' house is to the right →" and "Dive deeper for warmer temperatures ↓"
- [x] Change WORLD_TOP from 0 to -100 to allow flying 100m above starting depth
- [ ] Verify in browser via Playwright

## Files modified
- `egg/game.js` — WORLD_TOP constant (line 15), opening sequence text (lines 1370-1378)
