# Plan: Beautiful Atmosphere & Sky Fish — egg/Caldara

## Status: Complete

## Steps

- [x] 1. Add global state (atmosphereTime, lightningState, skyFish, fishSpawnCooldown)
- [x] 2. Reset new state in resetGame()
- [x] 3. Advance atmosphereTime in loop()
- [x] 4. Replace renderBackground() with enhanced version (4-anchor gradient, cloud bands, recolored streaks, lightning)
- [x] 5. Add glow field to steam particles
- [x] 6. Update renderSteamParticles() to draw glowing motes
- [x] 7. Add lightning update in updateParticles()
- [x] 8. Add sky fish spawn + update in updateParticles()
- [x] 9. Add drawSingleFish() and renderSkyFish() functions
- [x] 10. Integrate renderSkyFish() into playing/paused, gameover, and opening render blocks
- [x] 11. Playwright verification
