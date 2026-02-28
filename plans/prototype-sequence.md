# Egg Delivery Game — Prototype Sequence

## Context
The game ("DoorDash on Caldara") takes place on a steam gas giant where the player uses thrusters to deliver an egg from a farm to the Jones' house ~3km away. As the device descends, outside temperature rises, gradually cooking the egg. The player must oscillate in altitude to cook the egg to precise targets (white gelation 0.9, yolk gelation 0.6) without overcooking, cracking the shell, or boiling the interior. Built as HTML5 Canvas + JS, following the pattern established in `GravityProto/`.

## Prototype 1: Movement & Physics
- [x] Set up project structure: `egg/index.html`, `egg/game.js`, `egg/.gitignore`, `egg/plans/`
- [x] Canvas with a simple rectangle for the device
- [x] Arrow key controls: Up fires down-thruster (accelerates up at 1g), Left/Right fire side thrusters
- [x] Gravity (constant downward acceleration)
- [x] Simple air resistance model capping max velocity
- [x] Track position: depth (vertical, 0 = farm level) and horizontal distance
- [x] Boundary enforcement: can't go left of start, above depth 0, or below 5000m
- [x] Debug text overlay: position, velocity, depth, horizontal distance
- [x] Scrolling camera that follows the device

## Prototype 2: Thermal Simulation
- [x] Compute outside temperature and pressure
- [x] 1-second tick thermal updates (pod air, egg white, yolk temps)
- [x] Pod air pressure
- [x] Egg white boiling point
- [x] Egg white gelation
- [x] Egg yolk gelation
- [x] Shell cracking mechanic
- [x] Boiling mechanic
- [x] Gelation caps / game-over conditions
- [x] Display all thermal values as debug text

## Prototype 3: Instrument Panel & HUD
- [x] Depth numeric readout
- [x] Horizontal progress bar (farm → house)
- [x] Outside temp/pressure displays
- [x] Pod air temp/pressure displays
- [x] Egg white/yolk temp displays
- [x] Egg white boiling point with warning
- [x] Gelation bars with star targets
- [x] Shell integrity icon
- [x] Boiling counter

## Prototype 4: World Visuals & Game Flow
- [x] Steam gas giant background
- [x] Farm bubble at depth 0
- [x] Jones' house bubble at depth 0, 3km right
- [x] Device visual with egg and thrusters
- [x] Opening instructions popup
- [x] Opening sequence (cap opens, egg drops, free-fall)
- [x] Delivery prompt near Jones' house
- [x] Scoring screen with breakdown
- [x] High scores (localStorage)

## Prototype 5: Parameter Tuning
- [ ] Build simulation script
- [ ] Tune thermal/gelation parameters
- [ ] Tune physics parameters
- [ ] Verify 4+ oscillations required
- [ ] Verify idle time < 25%
- [ ] Play-test and iterate
