// ═══════════════════════════════════════════════════════════════
// DoorDash on Caldara — Egg Delivery Game
// ═══════════════════════════════════════════════════════════════

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const W = 800, H = 600;

// ── Physics Constants (2.5x spatial scale) ──
const GRAVITY = 24.525;        // m/s² downward (9.81 × 2.5)
const THRUST_UP = 2 * GRAVITY; // 2g upward — allows actual climbing
const THRUST_SIDE = 20.0;     // m/s² horizontal (8.0 × 2.5)
const DRAG = 0.003;            // low drag (terminal velocity scales with gravity)
const MAX_SPEED = 150;         // m/s hard speed cap (60 × 2.5)
const WORLD_TOP = -100;         // min depth (100m above surface)
const WORLD_BOTTOM = 12500;    // max depth in meters (5000 × 2.5)
const WORLD_LEFT = -50;        // small buffer left of farm
const JONES_X = 25000;         // horizontal distance to Jones' house (10 km × 2.5 scale)
const DELIVERY_RADIUS = 200;   // how close to deliver (80 × 2.5)

// ── Thermal Constants ──
let A_POD = 0.3;               // pod closely tracks outside temp
let A_WHITE = 0.035;           // white responds to pod (tuned for A_POD=0.3)
let A_YOLK = 0.010;            // yolk lags behind white
let K_WHITE = 0.009;           // white gelation rate (tuned for A_POD=0.3)
let W_WHITE = 1;
let K_YOLK = 0.004;            // yolk gelation rate
let W_YOLK = 1;
const WHITE_GEL_CAP = 1.5;    // overcooked threshold
const YOLK_GEL_CAP = 1.0;

// ── Rendering Constants ──
const SCALE = 1;               // pixels per meter
const DEVICE_W = 24;           // device width in pixels
const DEVICE_H = 20;           // device height in pixels

// ── Game State ──
let gameState = 'instructions'; // instructions | opening | playing | gameover | delivered | scoring
let gameOverReason = '';
let openingTimer = 0;
const OPENING_DURATION = 2.5;  // seconds for opening animation
let eggLoaded = false;         // true once falling egg reaches device in opening

let device = {
  x: 20, y: 0,      // world position (x = horizontal, y = depth)
  vx: 0, vy: 0      // velocity
};

let thermal = {
  podAirTemp: 323,       // K (starts at ambient surface temp)
  eggWhiteTemp: 323,     // K
  yolkTemp: 323,         // K
  whiteGelation: 0,
  yolkGelation: 0,
  boilSeconds: 0
};

let camera = { x: 0, y: 0 };
let keys = {};
let lastTime = 0;
let thermalAccum = 0;    // accumulator for 1-second thermal ticks
let score = 0;
let whiteScore = 0;
let yolkScore = 0;
let highScores = JSON.parse(localStorage.getItem('caldara_scores') || '[]');

// ── Particle Systems ──
let steamParticles = [];
let thrustParticles = [];

// ── Atmosphere ──
let atmosphereTime = 0;

// ── Wall scroll offset ──
let wallScrollY = 0;

// ── Sky Fish ──
let skyFish = [];
let fishSpawnCooldown = 6 + Math.random() * 10;

// ── Helper Functions ──
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function outsideTemp(depth) {
  return 323 + 0.02 * depth; // K (0.05/2.5 — same temp at proportional depth)
}

function outsidePressure(depth) {
  const T = outsideTemp(depth);
  return 0.12 * Math.pow(T / 323, 4.33); // bars (scales via T which already uses 0.02)
}

function kelvinToCelsius(k) {
  return k - 273.15;
}

function peak(value, target, width) {
  return Math.max(0, 1 - Math.abs(value - target) / width);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function getGelationFeedback(value, target, cap) {
  const ratio = value / target;
  if (ratio < 0.33) return { label: 'Raw', color: '#aaa' };
  if (ratio < 0.67) return { label: 'Undercooked', color: '#f88' };
  if (ratio < 0.89) return { label: 'Slightly undercooked', color: '#fa8' };
  if (ratio < 1.11) return { label: 'Just right!', color: '#6f6' };
  const overRatio = (value - target) / (cap - target);
  if (overRatio < 0.42) return { label: 'Slightly overcooked', color: '#fa8' };
  if (overRatio < 0.83) return { label: 'Overcooked', color: '#f88' };
  return { label: 'Ruined', color: '#f44' };
}

// ── Input Handling ──
document.addEventListener('keydown', e => {
  keys[e.key] = true;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) {
    e.preventDefault();
  }
  // Close instructions
  if (e.key === ' ' && gameState === 'instructions') {
    gameState = 'opening';
    openingTimer = 0;
  }
  // Start playing from opening hints
  if ((e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') && gameState === 'opening' && openingTimer >= OPENING_DURATION) {
    gameState = 'playing';
  }
  // Pause toggle
  if (e.key === 'p' || e.key === 'P') {
    if (gameState === 'playing') gameState = 'paused';
    else if (gameState === 'paused') gameState = 'playing';
  }
  // Deliver egg
  if (e.key === ' ' && gameState === 'playing') {
    const dx = device.x - JONES_X;
    const dy = device.y - 0;
    if (Math.sqrt(dx * dx + dy * dy) < DELIVERY_RADIUS) {
      gameState = 'scoring';
      calculateScore();
    }
  }
  // Restart
  if (e.key === 'r' || e.key === 'R') {
    if (gameState === 'gameover' || gameState === 'scoring' || gameState === 'playing' || gameState === 'paused') {
      resetGame();
    }
  }
});

document.addEventListener('keyup', e => {
  keys[e.key] = false;
});

// ── Physics Update ──
function updatePhysics(dt) {
  if (gameState !== 'playing') return;

  // Thrust
  let ax = 0, ay = GRAVITY; // gravity pulls down (positive y = deeper)

  if (keys['ArrowUp'] || keys['w'] || keys['W']) {
    ay -= THRUST_UP; // thrust upward (cancels gravity)
  }
  if (keys['ArrowLeft'] || keys['a'] || keys['A']) {
    ax -= THRUST_SIDE;
  }
  if (keys['ArrowRight'] || keys['d'] || keys['D']) {
    ax += THRUST_SIDE;
  }

  // Apply acceleration
  device.vx += ax * dt;
  device.vy += ay * dt;

  // Air resistance (drag proportional to velocity)
  device.vx *= (1 - DRAG);
  device.vy *= (1 - DRAG);

  // Speed cap
  const speed = Math.sqrt(device.vx * device.vx + device.vy * device.vy);
  if (speed > MAX_SPEED) {
    device.vx *= MAX_SPEED / speed;
    device.vy *= MAX_SPEED / speed;
  }

  // Update position
  device.x += device.vx * dt;
  device.y += device.vy * dt;

  // Boundary enforcement
  if (device.y < WORLD_TOP) {
    device.y = WORLD_TOP;
    device.vy = Math.max(0, device.vy);
  }
  if (device.y > WORLD_BOTTOM) {
    device.y = WORLD_BOTTOM;
    device.vy = Math.min(0, device.vy);
  }
  if (device.x < WORLD_LEFT) {
    device.x = WORLD_LEFT;
    device.vx = Math.max(0, device.vx);
  }
  const WORLD_RIGHT = JONES_X + 100;
  if (device.x > WORLD_RIGHT) {
    device.x = WORLD_RIGHT;
    device.vx = Math.min(0, device.vx);
  }

  // Spawn thrust particles
  if (keys['ArrowUp'] || keys['w'] || keys['W']) {
    for (let i = 0; i < 2; i++) {
      thrustParticles.push({
        x: device.x + (Math.random() - 0.5) * 8,
        y: device.y + DEVICE_H / 2 + 2,
        vx: (Math.random() - 0.5) * 15,
        vy: 20 + Math.random() * 30,
        life: 0.3 + Math.random() * 0.3,
        maxLife: 0.6
      });
    }
  }
  if (keys['ArrowLeft'] || keys['a'] || keys['A']) {
    thrustParticles.push({
      x: device.x + DEVICE_W / 2 + 2,
      y: device.y + (Math.random() - 0.5) * 6,
      vx: 20 + Math.random() * 20,
      vy: (Math.random() - 0.5) * 10,
      life: 0.2 + Math.random() * 0.2,
      maxLife: 0.4
    });
  }
  if (keys['ArrowRight'] || keys['d'] || keys['D']) {
    thrustParticles.push({
      x: device.x - DEVICE_W / 2 - 2,
      y: device.y + (Math.random() - 0.5) * 6,
      vx: -20 - Math.random() * 20,
      vy: (Math.random() - 0.5) * 10,
      life: 0.2 + Math.random() * 0.2,
      maxLife: 0.4
    });
  }
}

// ── Thermal Update (1-second ticks) ──
function updateThermal() {
  if (gameState !== 'playing') return;

  const T_out = outsideTemp(device.y);
  const P_out = outsidePressure(device.y);

  // Temperature updates (batch using previous values)
  const newPodTemp = thermal.podAirTemp + A_POD * (T_out - thermal.podAirTemp);
  const newWhiteTemp = thermal.eggWhiteTemp + A_WHITE * (thermal.podAirTemp - thermal.eggWhiteTemp);
  const newYolkTemp = thermal.yolkTemp + A_YOLK * (thermal.eggWhiteTemp - thermal.yolkTemp);

  thermal.podAirTemp = newPodTemp;
  thermal.eggWhiteTemp = newWhiteTemp;
  thermal.yolkTemp = newYolkTemp;

  // Pod air pressure
  const podPressure = 1.0 * (thermal.podAirTemp / 298);

  // Egg white boiling point
  const boilingPointK = 4894 / (13.12 - Math.log(podPressure / 1.013));

  // Gelation updates
  const whiteTempC = kelvinToCelsius(thermal.eggWhiteTemp);
  const yolkTempC = kelvinToCelsius(thermal.yolkTemp);

  thermal.whiteGelation += K_WHITE * sigmoid((whiteTempC - 85) / W_WHITE);
  thermal.yolkGelation += K_YOLK * sigmoid((yolkTempC - 65) / W_YOLK);

  // Boiling check — instant game over
  if (thermal.eggWhiteTemp > boilingPointK) {
    thermal.boilSeconds++;
    gameState = 'gameover';
    gameOverReason = 'Egg boiled! The interior pressure burst the egg.';
    return;
  }

  // Gelation caps
  if (thermal.whiteGelation > WHITE_GEL_CAP) {
    gameState = 'gameover';
    gameOverReason = 'Overcooked! The egg white turned to rubber.';
    return;
  }
  if (thermal.yolkGelation > YOLK_GEL_CAP) {
    gameState = 'gameover';
    gameOverReason = 'Overcooked! The yolk is chalky and grey.';
    return;
  }
}

// ── Particle Update ──
function updateParticles(dt) {
  // Steam/atmosphere particles + sky fish
  if (gameState === 'playing' || gameState === 'opening') {
    const depth = Math.max(0, device.y);
    const intensity = Math.min(1, depth / 2000);
    if (Math.random() < intensity * 0.3) {
      steamParticles.push({
        x: camera.x + Math.random() * W,
        y: camera.y + Math.random() * H,
        vx: (Math.random() - 0.5) * 8 - 3,
        vy: (Math.random() - 0.5) * 5 - 2,
        life: 2 + Math.random() * 3,
        maxLife: 5,
        size: 3 + Math.random() * 8,
        glow: Math.random() < 0.2
      });
    }

    // Sky fish spawn
    fishSpawnCooldown -= dt;
    if (fishSpawnCooldown <= 0 && skyFish.length < 5) {
      fishSpawnCooldown = 6 + Math.random() * 10;
      const facing = Math.random() < 0.5 ? 1 : -1;
      const spawnX = facing === 1 ? camera.x - 100 : camera.x + W + 100;
      const spawnY = camera.y + H * 0.1 + Math.random() * H * 0.8;
      const maxLife = 15 + Math.random() * 25;
      skyFish.push({
        x: spawnX,
        y: spawnY,
        vx: facing * (30 + Math.random() * 35),
        vy: 0,
        phase: Math.random() * Math.PI * 2,
        phaseSpeed: 1.2 + Math.random() * 0.8,
        undulateAmp: 15 + Math.random() * 20,
        facing,
        size: 0.3 + Math.random() * 2.2,
        hue: 175 + Math.random() * 40,
        alpha: 0,
        life: maxLife,
        maxLife,
      });
    }

    // Sky fish update
    for (let i = skyFish.length - 1; i >= 0; i--) {
      const fish = skyFish[i];
      fish.phase += fish.phaseSpeed * dt;
      fish.x += fish.vx * dt;
      fish.y += Math.sin(fish.phase) * fish.undulateAmp * dt;
      fish.life -= dt;
      const lifeRatio = fish.life / fish.maxLife;
      if (lifeRatio > 0.9) {
        fish.alpha = (1 - lifeRatio) / 0.1;
      } else if (lifeRatio < 0.15) {
        fish.alpha = lifeRatio / 0.15;
      } else {
        fish.alpha = 1;
      }
      if (fish.life <= 0) skyFish.splice(i, 1);
    }
  }

  // Update steam
  for (let i = steamParticles.length - 1; i >= 0; i--) {
    const p = steamParticles[i];
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt;
    if (p.life <= 0) steamParticles.splice(i, 1);
  }

  // Update thrust
  for (let i = thrustParticles.length - 1; i >= 0; i--) {
    const p = thrustParticles[i];
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt;
    if (p.life <= 0) thrustParticles.splice(i, 1);
  }
}

// ── Camera ──
function updateCamera() {
  camera.x = device.x - W / 2;
  camera.y = device.y - H / 2;
}

// ── Score Calculation ──
function calculateScore() {
  whiteScore = Math.round(500 * peak(thermal.whiteGelation, 0.9, 0.15));
  yolkScore = Math.round(500 * peak(thermal.yolkGelation, 0.6, 0.15));
  score = whiteScore + yolkScore;

  // Save high score
  highScores.push(score);
  highScores.sort((a, b) => b - a);
  highScores = highScores.slice(0, 5);
  localStorage.setItem('caldara_scores', JSON.stringify(highScores));
}

// ── Reset ──
function resetGame() {
  device = { x: 20, y: 0, vx: 0, vy: 0 };
  thermal = {
    podAirTemp: 323,
    eggWhiteTemp: 323,
    yolkTemp: 323,
    whiteGelation: 0,
    yolkGelation: 0,
    boilSeconds: 0
  };
  steamParticles = [];
  thrustParticles = [];
  skyFish = [];
  fishSpawnCooldown = 6 + Math.random() * 10;
  thermalAccum = 0;
  score = 0;
  whiteScore = 0;
  yolkScore = 0;
  openingTimer = 0;
  eggLoaded = false;
  wallScrollY = 0;
  gameState = 'instructions';
  gameOverReason = '';
}

// ═══════════════════════════════════════════════════════════════
// RENDERING
// ═══════════════════════════════════════════════════════════════

// ── Atmosphere Color Helper ──
function atmosphereColor(worldY) {
  const t = clamp(worldY / 3500, 0, 1);
  const stops = [
    { t: 0.00, r: 22,  g: 14, b: 58  },
    { t: 0.35, r: 38,  g: 72, b: 88  },
    { t: 0.65, r: 130, g: 78, b: 28  },
    { t: 1.00, r: 105, g: 22, b: 18  },
  ];
  let lo = stops[0], hi = stops[1];
  for (let i = 0; i < stops.length - 1; i++) {
    lo = stops[i];
    hi = stops[i + 1];
    if (t <= hi.t) break;
  }
  const seg = (hi.t === lo.t) ? 0 : (t - lo.t) / (hi.t - lo.t);
  return {
    r: Math.round(lo.r + seg * (hi.r - lo.r)),
    g: Math.round(lo.g + seg * (hi.g - lo.g)),
    b: Math.round(lo.b + seg * (hi.b - lo.b)),
  };
}

// ── Background ──
function renderBackground() {
  // 4-anchor piecewise gradient based on visible world depth band
  const topColor = atmosphereColor(camera.y);
  const botColor = atmosphereColor(camera.y + H);
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, `rgb(${topColor.r},${topColor.g},${topColor.b})`);
  grad.addColorStop(1, `rgb(${botColor.r},${botColor.g},${botColor.b})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // ── Atmospheric cloud bands (5 layers) ──
  const bandDefs = [
    { relY: 0.18, r: 80,  g: 130, b: 140, alpha: 0.07, halfH: 55, parallax: 0.15, drift: 12  },
    { relY: 0.35, r: 160, g: 100, b: 50,  alpha: 0.09, halfH: 40, parallax: 0.25, drift: -8  },
    { relY: 0.52, r: 200, g: 140, b: 60,  alpha: 0.08, halfH: 65, parallax: 0.18, drift: 15  },
    { relY: 0.70, r: 180, g: 80,  b: 40,  alpha: 0.10, halfH: 45, parallax: 0.30, drift: -10 },
    { relY: 0.85, r: 120, g: 30,  b: 20,  alpha: 0.12, halfH: 70, parallax: 0.12, drift: 6   },
  ];
  for (const band of bandDefs) {
    const worldBandY = band.relY * WORLD_BOTTOM;
    const rawScreenY = worldBandY - camera.y * (1 - band.parallax) + atmosphereTime * band.drift;
    const period = H + band.halfH * 4;
    const sy = ((rawScreenY % period) + period) % period - band.halfH * 2;
    // Draw at wrapped position and one period ahead to cover seam
    for (const drawY of [sy, sy + period]) {
      if (drawY - band.halfH > H || drawY + band.halfH < 0) continue;
      const bandGrad = ctx.createLinearGradient(0, drawY - band.halfH, 0, drawY + band.halfH);
      bandGrad.addColorStop(0,   `rgba(${band.r},${band.g},${band.b},0)`);
      bandGrad.addColorStop(0.5, `rgba(${band.r},${band.g},${band.b},${band.alpha})`);
      bandGrad.addColorStop(1,   `rgba(${band.r},${band.g},${band.b},0)`);
      ctx.fillStyle = bandGrad;
      ctx.fillRect(0, drawY - band.halfH, W, band.halfH * 2);
    }
  }

  // ── Swirling current streaks (recolored by depth) ──
  ctx.save();
  const depth = Math.max(0, device.y);
  const t = clamp(depth / 3500, 0, 1);
  const streakAlpha = 0.03 + t * 0.06;
  const streakR = Math.round(60  + t * 160);
  const streakG = Math.round(120 + t * 60  - t * t * 100);
  const streakB = Math.round(140 - t * 100);
  ctx.strokeStyle = `rgba(${streakR},${streakG},${streakB},${streakAlpha})`;
  ctx.lineWidth = 2;
  for (let i = 0; i < 8; i++) {
    const sy = ((i * 137 + depth * 0.3) % (H + 200)) - 100;
    const sx = ((i * 213 + depth * 0.1) % (W + 200)) - 100;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.bezierCurveTo(
      sx + 100 + Math.sin(depth * 0.002 + i) * 50, sy + 20,
      sx + 200 + Math.cos(depth * 0.003 + i) * 40, sy - 15,
      sx + 350, sy + 10
    );
    ctx.stroke();
  }
  ctx.restore();

}

// ── Farm Bubble ──
function renderFarm(ox, oy) {
  // Floating platform / bubble
  const bx = 20 - ox;
  const by = -30 - oy;

  // Bubble dome
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(bx, by - 25, 60, 50, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(180,220,255,0.12)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(180,220,255,0.3)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Ground inside bubble
  ctx.fillStyle = '#4a7a3a';
  ctx.fillRect(bx - 45, by - 10, 90, 15);

  // Grass tufts along ground line
  ctx.strokeStyle = '#5a9a4a';
  ctx.lineWidth = 0.8;
  for (let i = 0; i < 12; i++) {
    const gx = bx - 42 + i * 7;
    const gy = by - 10;
    ctx.beginPath();
    ctx.moveTo(gx, gy);
    ctx.lineTo(gx - 2, gy - 4);
    ctx.moveTo(gx, gy);
    ctx.lineTo(gx + 2, gy - 4);
    ctx.stroke();
  }

  // Small flowers along left edge
  const flowerColors = ['#f66', '#ff8', '#f8f', '#8cf'];
  for (let i = 0; i < 4; i++) {
    const fx = bx - 38 + i * 5;
    const fy = by - 13;
    // Stem
    ctx.strokeStyle = '#4a8a3a';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(fx, fy + 3);
    ctx.lineTo(fx, fy);
    ctx.stroke();
    // Petals
    ctx.fillStyle = flowerColors[i];
    ctx.beginPath();
    ctx.arc(fx, fy, 1.5, 0, Math.PI * 2);
    ctx.fill();
    // Center
    ctx.fillStyle = '#ff0';
    ctx.beginPath();
    ctx.arc(fx, fy, 0.6, 0, Math.PI * 2);
    ctx.fill();
  }

  // Small nest with 2 eggs near right side
  ctx.fillStyle = '#8a6530';
  ctx.beginPath();
  ctx.ellipse(bx + 30, by - 11, 6, 3, 0, 0, Math.PI * 2);
  ctx.fill();
  // Straw texture
  ctx.strokeStyle = '#a08040';
  ctx.lineWidth = 0.5;
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(bx + 25 + i * 3, by - 12);
    ctx.lineTo(bx + 26 + i * 3, by - 10);
    ctx.stroke();
  }
  // Eggs in nest
  ctx.fillStyle = '#f4ead0';
  ctx.beginPath();
  ctx.ellipse(bx + 28, by - 12, 2, 2.5, -0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(bx + 32, by - 12, 2, 2.5, 0.2, 0, Math.PI * 2);
  ctx.fill();

  // Chickens with distinct shapes and colors
  const chickenColors = ['#e8d4a0', '#f0ece0', '#8b5e3c']; // buff, white, brown
  const tailColors = ['#c8a060', '#d8d4c0', '#6a4020'];
  const chickens = [
    { x: bx - 25, y: by - 14, facing: 1 },
    { x: bx - 5, y: by - 15, facing: -1 },
    { x: bx + 15, y: by - 14, facing: 1 },
  ];
  for (let ci = 0; ci < chickens.length; ci++) {
    const ch = chickens[ci];
    const cx = ch.x, cy = ch.y, f = ch.facing;
    const bodyColor = chickenColors[ci];
    const tailColor = tailColors[ci];
    // Tail feathers
    ctx.fillStyle = tailColor;
    ctx.beginPath();
    ctx.moveTo(cx - f * 5, cy);
    ctx.lineTo(cx - f * 9, cy - 4);
    ctx.lineTo(cx - f * 8, cy + 1);
    ctx.closePath();
    ctx.fill();
    // Body (rounded)
    ctx.fillStyle = bodyColor;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 5, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    // Head
    ctx.fillStyle = bodyColor;
    ctx.beginPath();
    ctx.arc(cx + f * 5, cy - 3, 2.5, 0, Math.PI * 2);
    ctx.fill();
    // Comb (red zigzag on top)
    ctx.fillStyle = '#d33';
    ctx.beginPath();
    ctx.moveTo(cx + f * 4, cy - 5.5);
    ctx.lineTo(cx + f * 5, cy - 8);
    ctx.lineTo(cx + f * 6, cy - 5.5);
    ctx.lineTo(cx + f * 7, cy - 7.5);
    ctx.lineTo(cx + f * 7.5, cy - 5);
    ctx.closePath();
    ctx.fill();
    // Wattle (red drop below beak)
    ctx.fillStyle = '#c22';
    ctx.beginPath();
    ctx.ellipse(cx + f * 7.5, cy - 0.5, 1, 1.5, 0, 0, Math.PI * 2);
    ctx.fill();
    // Beak (triangle)
    ctx.fillStyle = '#e8a020';
    ctx.beginPath();
    ctx.moveTo(cx + f * 7, cy - 3);
    ctx.lineTo(cx + f * 10, cy - 2.5);
    ctx.lineTo(cx + f * 7, cy - 1.5);
    ctx.closePath();
    ctx.fill();
    // Eye
    ctx.fillStyle = '#222';
    ctx.beginPath();
    ctx.arc(cx + f * 5.5, cy - 3.5, 0.7, 0, Math.PI * 2);
    ctx.fill();
    // Legs
    ctx.strokeStyle = '#c87020';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(cx - 1, cy + 3);
    ctx.lineTo(cx - 2, cy + 7);
    ctx.moveTo(cx + 1, cy + 3);
    ctx.lineTo(cx + 2, cy + 7);
    ctx.stroke();
  }

  // Fence posts
  ctx.strokeStyle = '#8a6530';
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i++) {
    const fx = bx - 40 + i * 20;
    ctx.beginPath();
    ctx.moveTo(fx, by - 10);
    ctx.lineTo(fx, by - 2);
    ctx.stroke();
  }
  // Fence rails
  ctx.beginPath();
  ctx.moveTo(bx - 40, by - 7);
  ctx.lineTo(bx + 40, by - 7);
  ctx.moveTo(bx - 40, by - 4);
  ctx.lineTo(bx + 40, by - 4);
  ctx.stroke();

  // Flotation device (below platform)
  ctx.fillStyle = '#667';
  ctx.fillRect(bx - 30, by + 5, 60, 8);
  ctx.fillStyle = '#88a';
  ctx.fillRect(bx - 25, by + 13, 15, 15);
  ctx.fillRect(bx + 10, by + 13, 15, 15);

  // Pipe with cap (egg dispenser)
  ctx.fillStyle = '#556';
  ctx.fillRect(bx - 3, by + 5, 6, 30);
  // Cap
  ctx.fillStyle = openingTimer < 0.5 ? '#889' : 'transparent';
  ctx.fillRect(bx - 5, by + 33, 10, 4);

  ctx.restore();
}

// ── Jones' House Bubble ──
function renderJonesHouse(ox, oy) {
  const hx = JONES_X - ox;
  const hy = -30 - oy;

  // Bubble dome
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(hx, hy - 25, 55, 45, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(180,220,255,0.12)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(180,220,255,0.3)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Ground
  ctx.fillStyle = '#4a7a3a';
  ctx.fillRect(hx - 40, hy - 10, 80, 12);

  // House body
  ctx.fillStyle = '#8b6f47';
  ctx.fillRect(hx - 18, hy - 30, 36, 22);

  // Roof
  ctx.fillStyle = '#a33';
  ctx.beginPath();
  ctx.moveTo(hx - 22, hy - 30);
  ctx.lineTo(hx, hy - 45);
  ctx.lineTo(hx + 22, hy - 30);
  ctx.closePath();
  ctx.fill();

  // Roof shingles (horizontal lines across triangle)
  ctx.strokeStyle = '#822';
  ctx.lineWidth = 0.4;
  for (let i = 1; i <= 4; i++) {
    const t = i / 5;
    const sy = hy - 30 - t * 15;
    const halfW = 22 * (1 - t);
    ctx.beginPath();
    ctx.moveTo(hx - halfW, sy);
    ctx.lineTo(hx + halfW, sy);
    ctx.stroke();
  }

  // Chimney
  ctx.fillStyle = '#664';
  ctx.fillRect(hx + 10, hy - 42, 5, 12);
  ctx.fillStyle = '#553';
  ctx.fillRect(hx + 9, hy - 43, 7, 2);

  // Animated chimney smoke puffs
  const now = Date.now() / 1000;
  for (let i = 0; i < 3; i++) {
    const phase = now * 0.5 + i * 2.1;
    const drift = (phase % 3) / 3; // 0 to 1 rising
    const sx = hx + 12.5 + Math.sin(phase * 1.5) * 3;
    const sy = hy - 43 - drift * 15;
    const sr = 1.5 + drift * 2;
    const sa = 0.25 * (1 - drift);
    ctx.fillStyle = `rgba(200,200,210,${sa})`;
    ctx.beginPath();
    ctx.arc(sx, sy, sr, 0, Math.PI * 2);
    ctx.fill();
  }

  // Door
  ctx.fillStyle = '#5a3a1a';
  ctx.fillRect(hx - 4, hy - 20, 8, 12);
  // Door handle
  ctx.fillStyle = '#ca8';
  ctx.beginPath();
  ctx.arc(hx + 2, hy - 14, 0.8, 0, Math.PI * 2);
  ctx.fill();

  // Left window glow
  ctx.fillStyle = 'rgba(255,230,140,0.3)';
  ctx.fillRect(hx - 15, hy - 27, 9, 8);
  // Left window
  ctx.fillStyle = '#ffdd88';
  ctx.fillRect(hx - 14, hy - 26, 7, 6);
  ctx.strokeStyle = '#5a3a1a';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(hx - 10.5, hy - 26);
  ctx.lineTo(hx - 10.5, hy - 20);
  ctx.moveTo(hx - 14, hy - 23);
  ctx.lineTo(hx - 7, hy - 23);
  ctx.stroke();
  // Left shutters
  ctx.fillStyle = '#3a6a3a';
  ctx.fillRect(hx - 16, hy - 26, 2, 6);
  ctx.fillRect(hx - 7, hy - 26, 2, 6);

  // Right window glow
  ctx.fillStyle = 'rgba(255,230,140,0.3)';
  ctx.fillRect(hx + 7, hy - 27, 9, 8);
  // Right window
  ctx.fillStyle = '#ffdd88';
  ctx.fillRect(hx + 8, hy - 26, 7, 6);
  ctx.beginPath();
  ctx.moveTo(hx + 11.5, hy - 26);
  ctx.lineTo(hx + 11.5, hy - 20);
  ctx.moveTo(hx + 8, hy - 23);
  ctx.lineTo(hx + 15, hy - 23);
  ctx.stroke();
  // Right shutters
  ctx.fillStyle = '#3a6a3a';
  ctx.fillRect(hx + 6, hy - 26, 2, 6);
  ctx.fillRect(hx + 15, hy - 26, 2, 6);

  // Welcome mat
  ctx.fillStyle = '#6a4a2a';
  ctx.fillRect(hx - 5, hy - 8, 10, 3);

  // Stepping stones from door to edge
  ctx.fillStyle = '#8a8a7a';
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.ellipse(hx, hy - 4 + i * 4, 2.5, 1.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Small garden flowers by the door
  const gardenColors = ['#f66', '#ff8', '#f8f'];
  for (let i = 0; i < 3; i++) {
    const gx = hx - 12 + i * 3;
    const gy = hy - 10;
    ctx.strokeStyle = '#4a8a3a';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(gx, gy + 2);
    ctx.lineTo(gx, gy);
    ctx.stroke();
    ctx.fillStyle = gardenColors[i];
    ctx.beginPath();
    ctx.arc(gx, gy, 1.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Mailbox to the right
  ctx.fillStyle = '#556';
  ctx.fillRect(hx + 25, hy - 16, 2, 8);
  ctx.fillStyle = '#446';
  ctx.fillRect(hx + 23, hy - 18, 6, 4);
  // Mailbox flag
  ctx.fillStyle = '#d44';
  ctx.fillRect(hx + 29, hy - 18, 1, 3);

  // Flotation
  ctx.fillStyle = '#667';
  ctx.fillRect(hx - 28, hy + 2, 56, 6);

  // "JONES" sign
  ctx.fillStyle = '#ddd';
  ctx.font = '7px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('JONES', hx, hy - 48);

  ctx.restore();
}

// ── Device ──
function renderDevice(ox, oy) {
  const dx = device.x - ox;
  const dy = device.y - oy;

  ctx.save();

  // Main body
  ctx.fillStyle = '#556b8a';
  ctx.strokeStyle = '#7a8faa';
  ctx.lineWidth = 1;
  ctx.fillRect(dx - DEVICE_W / 2, dy - DEVICE_H / 2, DEVICE_W, DEVICE_H);
  ctx.strokeRect(dx - DEVICE_W / 2, dy - DEVICE_H / 2, DEVICE_W, DEVICE_H);

  // Egg inside (visible through a viewport)
  ctx.fillStyle = '#333';
  ctx.fillRect(dx - 6, dy - 6, 12, 10);
  if (eggLoaded) {
    // Egg
    ctx.fillStyle = '#f4ead0';
    ctx.beginPath();
    ctx.ellipse(dx, dy - 1, 4, 5, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Thrusters
  const thrusting = {
    up: keys['ArrowUp'] || keys['w'] || keys['W'],
    left: keys['ArrowLeft'] || keys['a'] || keys['A'],
    right: keys['ArrowRight'] || keys['d'] || keys['D']
  };

  // Bottom thruster housing
  ctx.fillStyle = '#445';
  ctx.fillRect(dx - 5, dy + DEVICE_H / 2 - 2, 10, 4);
  // Left thruster housing
  ctx.fillRect(dx + DEVICE_W / 2 - 2, dy - 3, 4, 6);
  // Right thruster housing
  ctx.fillRect(dx - DEVICE_W / 2 - 2, dy - 3, 4, 6);

  // Thrust flames
  if (thrusting.up && gameState === 'playing') {
    const grad = ctx.createRadialGradient(dx, dy + DEVICE_H / 2 + 8, 1, dx, dy + DEVICE_H / 2 + 8, 12);
    grad.addColorStop(0, 'rgba(255,200,50,0.9)');
    grad.addColorStop(0.5, 'rgba(255,100,20,0.6)');
    grad.addColorStop(1, 'rgba(255,50,10,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(dx, dy + DEVICE_H / 2 + 8, 6, 10 + Math.random() * 4, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  if (thrusting.right && gameState === 'playing') {
    const grad = ctx.createRadialGradient(dx - DEVICE_W / 2 - 6, dy, 1, dx - DEVICE_W / 2 - 6, dy, 8);
    grad.addColorStop(0, 'rgba(255,200,50,0.8)');
    grad.addColorStop(1, 'rgba(255,50,10,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(dx - DEVICE_W / 2 - 6, dy, 7 + Math.random() * 3, 4, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  if (thrusting.left && gameState === 'playing') {
    const grad = ctx.createRadialGradient(dx + DEVICE_W / 2 + 6, dy, 1, dx + DEVICE_W / 2 + 6, dy, 8);
    grad.addColorStop(0, 'rgba(255,200,50,0.8)');
    grad.addColorStop(1, 'rgba(255,50,10,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(dx + DEVICE_W / 2 + 6, dy, 7 + Math.random() * 3, 4, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

// ── Steam Particles (world space) ──
function renderSteamParticles(ox, oy) {
  const depth = Math.max(0, device.y);
  const t = clamp(depth / WORLD_BOTTOM, 0, 1);
  for (const p of steamParticles) {
    const alpha = (p.life / p.maxLife) * 0.15;
    const r = Math.floor(200 + t * 55);
    const g = Math.floor(180 + t * 20);
    const b = Math.floor(160 - t * 60);
    if (p.glow) {
      ctx.save();
      ctx.shadowBlur = 12;
      ctx.shadowColor = `rgba(${r},${g},${b},0.4)`;
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
      ctx.beginPath();
      ctx.arc(p.x - ox, p.y - oy, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else {
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
      ctx.beginPath();
      ctx.arc(p.x - ox, p.y - oy, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ── Thrust Particles (world space) ──
function renderThrustParticles(ox, oy) {
  for (const p of thrustParticles) {
    const alpha = (p.life / p.maxLife) * 0.8;
    ctx.fillStyle = `rgba(255,${Math.floor(150 * (p.life / p.maxLife))},20,${alpha})`;
    ctx.beginPath();
    ctx.arc(p.x - ox, p.y - oy, 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ── Sky Fish ──
function drawSingleFish(sx, sy, fish) {
  ctx.save();
  ctx.translate(sx, sy);
  ctx.scale(fish.size * fish.facing, fish.size);

  const hue = fish.hue;
  const alpha = fish.alpha;
  const phase = fish.phase;
  const flapOffset = Math.cos(phase) * 4;

  // Glow halo
  ctx.shadowBlur = 18;
  ctx.shadowColor = `hsla(${hue}, 90%, 65%, ${alpha * 0.6})`;

  // ── Pectoral fins ──
  // Upper fin
  ctx.beginPath();
  ctx.moveTo(-10, -3);
  ctx.bezierCurveTo(-20, -20 - flapOffset, -30, -35 - flapOffset, -5, -42 - flapOffset);
  ctx.bezierCurveTo(10, -35, 15, -15, 5, -5);
  ctx.closePath();
  ctx.fillStyle = `hsla(${hue}, 70%, 60%, ${alpha * 0.35})`;
  ctx.fill();

  // Lower fin
  ctx.beginPath();
  ctx.moveTo(-10, 3);
  ctx.bezierCurveTo(-20, 20 + flapOffset, -30, 35 + flapOffset, -5, 42 + flapOffset);
  ctx.bezierCurveTo(10, 35, 15, 15, 5, 5);
  ctx.closePath();
  ctx.fillStyle = `hsla(${hue}, 70%, 60%, ${alpha * 0.35})`;
  ctx.fill();

  // ── Body ──
  const bodyGrad = ctx.createLinearGradient(43, 0, -43, 0);
  bodyGrad.addColorStop(0, `hsla(${hue + 20}, 80%, 70%, ${alpha * 0.7})`);
  bodyGrad.addColorStop(1, `hsla(${hue - 20}, 60%, 30%, ${alpha * 0.6})`);

  ctx.beginPath();
  ctx.moveTo(43, 0);               // nose
  ctx.bezierCurveTo(38, -9, 10, -9, -28, -6);  // top sweep
  ctx.lineTo(-43, -10);            // upper tail fork
  ctx.lineTo(-38, 0);              // tail notch
  ctx.lineTo(-43, 10);             // lower tail fork
  ctx.lineTo(-28, 6);
  ctx.bezierCurveTo(10, 9, 38, 9, 43, 0);      // bottom sweep
  ctx.closePath();
  ctx.fillStyle = bodyGrad;
  ctx.fill();

  // Body outline
  ctx.strokeStyle = `hsla(${hue + 30}, 100%, 80%, ${alpha * 0.5})`;
  ctx.lineWidth = 0.8 / fish.size;  // compensate for scale
  ctx.stroke();

  // ── Dorsal ridge ──
  ctx.beginPath();
  ctx.moveTo(35, -2);
  ctx.bezierCurveTo(10, -14, -15, -10, -30, -6);
  ctx.strokeStyle = `hsla(${hue + 40}, 100%, 85%, ${alpha * 0.6})`;
  ctx.lineWidth = 1 / fish.size;
  ctx.stroke();

  // ── Bioluminescent spots ──
  ctx.shadowBlur = 10;
  for (let i = 0; i < 5; i++) {
    const dotX = 25 - i * 12;
    const dotY = -4 + Math.sin(dotX * 0.15) * 3;
    const pulse = 0.5 + 0.5 * Math.sin(phase + i * 0.8);
    const dotAlpha = alpha * (0.6 + pulse * 0.4);
    ctx.fillStyle = `hsla(${hue + 60}, 100%, 90%, ${dotAlpha})`;
    ctx.beginPath();
    ctx.arc(dotX, dotY, 1.5 + pulse * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function renderSkyFish(ox, oy) {
  for (const fish of skyFish) {
    const sx = fish.x - ox;
    const sy = fish.y - oy;
    if (sx < -200 || sx > W + 200 || sy < -100 || sy > H + 100) continue;
    drawSingleFish(sx, sy, fish);
  }
}

// ═══════════════════════════════════════════════════════════════
// HUD / INSTRUMENT PANEL (Prototype 3)
// ═══════════════════════════════════════════════════════════════

function renderHUD() {
  ctx.save();

  const panelX = 8;
  const panelY = 8;
  const panelW = 195;
  const panelH = 340;

  // Panel background
  ctx.fillStyle = 'rgba(10,15,30,0.75)';
  ctx.fillRect(panelX, panelY, panelW, panelH);
  ctx.strokeStyle = 'rgba(100,130,180,0.4)';
  ctx.lineWidth = 1;
  ctx.strokeRect(panelX, panelY, panelW, panelH);

  ctx.textAlign = 'left';
  let y = panelY + 16;
  const x = panelX + 8;
  const labelLh = 14;
  const valueLh = 18;

  // Depth
  ctx.font = '9px monospace';
  ctx.fillStyle = '#6a8aaa';
  ctx.fillText('Depth', x, y);
  y += labelLh;
  ctx.font = '11px monospace';
  ctx.fillStyle = '#8ac';
  ctx.fillText(`${Math.round(device.y)} m`, x, y);
  y += valueLh;

  // Exterior Temperature
  const outTemp = kelvinToCelsius(outsideTemp(device.y));
  const outPres = outsidePressure(device.y);
  ctx.font = '9px monospace';
  ctx.fillStyle = '#6a8aaa';
  ctx.fillText('Exterior Temp/Pressure', x, y);
  y += labelLh;
  ctx.font = '11px monospace';
  ctx.fillStyle = '#a96';
  ctx.fillText(`${outTemp.toFixed(0)}°C  ${outPres.toFixed(2)} bar`, x, y);
  y += valueLh;

  // Pod Air Temperature
  const podC = kelvinToCelsius(thermal.podAirTemp);
  const podPres = (thermal.podAirTemp / 298).toFixed(2);
  ctx.font = '9px monospace';
  ctx.fillStyle = '#6a8aaa';
  ctx.fillText('Pod Air Temp/Pressure', x, y);
  y += labelLh;
  ctx.font = '11px monospace';
  ctx.fillStyle = '#9a8';
  ctx.fillText(`${podC.toFixed(1)}°C  ${podPres} bar`, x, y);
  y += valueLh;

  // Egg White Temperature
  const whiteC = kelvinToCelsius(thermal.eggWhiteTemp);
  ctx.font = '9px monospace';
  ctx.fillStyle = '#6a8aaa';
  ctx.fillText('Egg White Temperature', x, y);
  y += labelLh;
  ctx.font = '11px monospace';
  ctx.fillStyle = '#dda';
  ctx.fillText(`${whiteC.toFixed(1)}°C`, x, y);
  if (whiteC > 85) {
    ctx.fillStyle = '#f44';
    ctx.font = 'bold 10px monospace';
    ctx.fillText('COOKING', x + 100, y);
  } else {
    ctx.fillStyle = '#665544';
    ctx.font = '8px monospace';
    ctx.fillText('>85 to cook', x + 58, y);
  }
  ctx.font = '11px monospace';
  y += valueLh;

  // Egg Yolk Temperature
  const yolkC = kelvinToCelsius(thermal.yolkTemp);
  ctx.font = '9px monospace';
  ctx.fillStyle = '#6a8aaa';
  ctx.fillText('Egg Yolk Temperature', x, y);
  y += labelLh;
  ctx.font = '11px monospace';
  ctx.fillStyle = '#da8';
  ctx.fillText(`${yolkC.toFixed(1)}°C`, x, y);
  if (yolkC > 65) {
    ctx.fillStyle = '#f44';
    ctx.font = 'bold 10px monospace';
    ctx.fillText('COOKING', x + 100, y);
  } else {
    ctx.fillStyle = '#554433';
    ctx.font = '8px monospace';
    ctx.fillText('>65 to cook', x + 58, y);
  }
  ctx.font = '11px monospace';
  y += valueLh;

  // Egg White Gelation
  ctx.font = '9px monospace';
  ctx.fillStyle = '#6a8aaa';
  ctx.fillText('Egg White Gelation', x, y);
  y += labelLh;
  renderGelationBar(x, y, 170, 10, thermal.whiteGelation, 0.9, WHITE_GEL_CAP, '#dda', '');
  y += 10 + 16; // bar height + gap before next section

  // Egg Yolk Gelation
  ctx.textAlign = 'left';
  ctx.font = '9px monospace';
  ctx.fillStyle = '#6a8aaa';
  ctx.fillText('Egg Yolk Gelation', x, y);
  y += labelLh;
  renderGelationBar(x, y, 170, 10, thermal.yolkGelation, 0.6, YOLK_GEL_CAP, '#da8', '');
  y += 10 + 16; // bar height + gap before next section

  // Internal Egg Boiling Point
  const podPressure = thermal.podAirTemp / 298;
  const bpK = 4894 / (13.12 - Math.log(podPressure / 1.013));
  const bpC = kelvinToCelsius(bpK);
  const nearBoil = whiteC > bpC - 10;
  ctx.textAlign = 'left';
  ctx.font = '9px monospace';
  ctx.fillStyle = '#6a8aaa';
  ctx.fillText('Internal Egg Boiling Point', x, y);
  y += labelLh;
  ctx.font = '11px monospace';
  ctx.fillStyle = nearBoil ? '#f66' : '#88a';
  ctx.fillText(`${bpC.toFixed(0)}°C${nearBoil ? '  ⚠' : ''}`, x, y);

  ctx.restore();

  // ── Horizontal progress bar (top of screen) ──
  renderProgressBar();
}

function renderGelationBar(x, y, w, h, value, target, cap, color, label) {
  // Background
  ctx.fillStyle = 'rgba(30,30,50,0.8)';
  ctx.fillRect(x, y, w, h);

  // Fill
  const fillFrac = clamp(value / cap, 0, 1);
  const targetFrac = target / cap;

  // Region before target: normal color. After target: increasingly red.
  const fillW = fillFrac * w;
  const targetX = targetFrac * w;

  if (fillW <= targetX) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, fillW, h);
  } else {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, targetX, h);
    ctx.fillStyle = '#c44';
    ctx.fillRect(x + targetX, y, fillW - targetX, h);
  }

  // Star marker at target
  const starX = x + targetX;
  const starY = y + h / 2;
  ctx.fillStyle = '#fff';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('★', starX, starY + 4);

  // Label
  ctx.fillStyle = '#888';
  ctx.font = '8px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(label, x + w, y - 1);

  // Border
  ctx.strokeStyle = 'rgba(100,130,180,0.4)';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(x, y, w, h);
}

function renderProgressBar() {
  const barX = 220;
  const barY = 12;
  const barW = 360;
  const barH = 16;

  // Background
  ctx.fillStyle = 'rgba(10,15,30,0.75)';
  ctx.fillRect(barX - 30, barY - 4, barW + 60, barH + 8);
  ctx.strokeStyle = 'rgba(100,130,180,0.4)';
  ctx.lineWidth = 1;
  ctx.strokeRect(barX - 30, barY - 4, barW + 60, barH + 8);

  // Bar track
  ctx.fillStyle = 'rgba(40,50,70,0.8)';
  ctx.fillRect(barX, barY, barW, barH);

  // Progress fill
  const progress = clamp(device.x / JONES_X, 0, 1);
  ctx.fillStyle = 'rgba(80,140,200,0.4)';
  ctx.fillRect(barX, barY, barW * progress, barH);

  // Farm icon (left)
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#8c8';
  ctx.fillText('🐔', barX - 14, barY + 13);

  // House icon (right)
  ctx.fillStyle = '#ca8';
  ctx.fillText('🏠', barX + barW + 14, barY + 13);

  // Egg position
  const eggScreenX = barX + barW * progress;
  ctx.fillStyle = '#f4ead0';
  ctx.beginPath();
  ctx.ellipse(eggScreenX, barY + barH / 2, 4, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#998';
  ctx.lineWidth = 0.8;
  ctx.stroke();

  // Distance text
  ctx.fillStyle = '#8ac';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  const distKm = (device.x / 1000).toFixed(1);
  const totalKm = (JONES_X / 1000).toFixed(1);
  ctx.fillText(`${distKm}km / ${totalKm}km`, barX + barW / 2, barY + barH + 14);
}

// ═══════════════════════════════════════════════════════════════
// GAME FLOW SCREENS
// ═══════════════════════════════════════════════════════════════

function renderInstructions() {
  // Dimmed background
  ctx.fillStyle = 'rgba(5,8,20,0.92)';
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = 'center';

  // Title
  ctx.fillStyle = '#ffcc66';
  ctx.font = 'bold 28px monospace';
  ctx.fillText('DoorDash on Caldara', W / 2, 100);

  // Flavor text
  ctx.fillStyle = '#99aacc';
  ctx.font = '13px monospace';
  const lines = [
    'The steam giant Caldara. Population: scattered.',
    'The Jones family ordered one egg, soft-boiled.',
    'Your job: deliver it through the atmosphere.',
    '',
    'As you descend, the air gets hotter — cooking the egg.',
    'A 2025 study in Nature found that the secret to a perfect egg',
    'lies in alternating between hot and cool zones —',
    'not lingering at one temperature.',
    'The egg needs rhythm, not patience.',
    '',
    'But watch out:',
    '  - If the interior boils even once, the egg bursts',
    '  - Overcook it and you\'re fired',
  ];
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], W / 2, 150 + i * 20);
  }

  // Controls
  ctx.fillStyle = '#88ccaa';
  ctx.font = '12px monospace';
  const controls = [
    '↑ / W  —  Fire down-thruster (go up)',
    '← / A  —  Fire right-thruster (go left)',
    '→ / D  —  Fire left-thruster (go right)',
    'SPACE  —  Deliver egg (when near house)',
    'P      —  Pause / unpause',
  ];
  for (let i = 0; i < controls.length; i++) {
    ctx.fillText(controls[i], W / 2, 420 + i * 20);
  }

  // Dismiss
  ctx.fillStyle = '#ffcc66';
  ctx.font = 'bold 14px monospace';
  ctx.fillText('Press SPACE to start', W / 2, 540);
}

function renderOpening(dt) {
  openingTimer += dt;

  // Show farm scene, egg dropping onto device
  renderBackground();
  const ox = camera.x;
  const oy = camera.y;
  renderSkyFish(ox, oy);
  renderFarm(ox, oy);
  renderDevice(ox, oy);

  // Falling egg animation
  if (openingTimer > 0.5 && openingTimer < 1.5) {
    const t = (openingTimer - 0.5) / 1.0;
    const eggY = -35 + t * 35; // falls from pipe to device
    const ex = 20 - ox;
    const ey = eggY - oy;
    ctx.fillStyle = '#f4ead0';
    ctx.beginPath();
    ctx.ellipse(ex, ey, 4, 5, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Status text
  ctx.fillStyle = '#ddd';
  ctx.font = '14px monospace';
  ctx.textAlign = 'center';
  if (openingTimer < 0.5) {
    ctx.fillText('Cap opening...', W / 2, H - 40);
  } else if (openingTimer < 1.5) {
    ctx.fillText('Egg loaded!', W / 2, H - 40);
  } else if (openingTimer < OPENING_DURATION) {
    ctx.fillText('Jones\' house is to the right \u2192', W / 2, H - 55);
    ctx.fillText('Dive deeper for warmer temperatures \u2193', W / 2, H - 35);
  } else {
    ctx.fillText('Jones\' house is to the right \u2192', W / 2, H - 55);
    ctx.fillText('Dive deeper for warmer temperatures \u2193', W / 2, H - 35);
    ctx.fillStyle = '#88ffaa';
    ctx.font = 'bold 14px monospace';
    ctx.fillText('Press \u2192 or D to launch', W / 2, H - 15);
  }

  if (openingTimer >= 1.5 && !eggLoaded) {
    eggLoaded = true;
  }
}

function renderGameOver() {
  // Keep showing game scene behind
  ctx.fillStyle = 'rgba(20,5,5,0.85)';
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#ff4444';
  ctx.font = 'bold 24px monospace';
  ctx.fillText('DELIVERY FAILED', W / 2, 180);

  ctx.fillStyle = '#cc8888';
  ctx.font = '14px monospace';
  ctx.fillText(gameOverReason, W / 2, 220);

  // Show egg stats
  renderFinalStats(280);

  ctx.fillStyle = '#ffcc66';
  ctx.font = '14px monospace';
  ctx.fillText('Press R to retry', W / 2, H - 50);
}

function renderScoring() {
  ctx.fillStyle = 'rgba(5,10,25,0.92)';
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#66ffaa';
  ctx.font = 'bold 26px monospace';
  ctx.fillText('EGG DELIVERED!', W / 2, 75);

  renderFinalStats(118);
  // renderFinalStats now ends ~y=248 (two bars, no boil line)

  // Separator
  ctx.strokeStyle = 'rgba(100,130,180,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(W / 2 - 130, 262);
  ctx.lineTo(W / 2 + 130, 262);
  ctx.stroke();

  // Total score — large and prominent
  ctx.fillStyle = 'rgba(255,200,80,0.12)';
  ctx.fillRect(W / 2 - 100, 272, 200, 68);
  ctx.fillStyle = '#ffcc66';
  ctx.font = 'bold 48px monospace';
  ctx.fillText(score, W / 2, 324);
  ctx.fillStyle = '#887744';
  ctx.font = '13px monospace';
  ctx.fillText('/ 1000', W / 2, 344);

  // High scores
  ctx.fillStyle = '#556677';
  ctx.font = '12px monospace';
  ctx.fillText('— BEST SCORES —', W / 2, 376);
  for (let i = 0; i < highScores.length; i++) {
    ctx.fillStyle = highScores[i] === score && i === highScores.indexOf(score)
      ? '#ffcc66' : '#445566';
    ctx.fillText(`${i + 1}.  ${highScores[i]}`, W / 2, 394 + i * 17);
  }

  ctx.fillStyle = '#88ccaa';
  ctx.font = '14px monospace';
  ctx.fillText('Press R to play again', W / 2, H - 40);
}

function renderFinalStats(startY) {
  let y = startY;
  ctx.font = '13px monospace';
  ctx.textAlign = 'center';

  // White gelation bar
  ctx.fillStyle = '#dda';
  ctx.fillText('Egg White Gelation', W / 2, y);
  y += 5;
  renderScoringBar(W / 2 - 120, y, 240, 14, thermal.whiteGelation, 0.9, WHITE_GEL_CAP);
  y += 22;
  const wFb = getGelationFeedback(thermal.whiteGelation, 0.9, WHITE_GEL_CAP);
  ctx.fillStyle = wFb.color;
  ctx.fillText(`${wFb.label}  +${whiteScore} / 500`, W / 2, y);
  y += 25;

  // Yolk gelation bar
  ctx.fillStyle = '#da8';
  ctx.fillText('Egg Yolk Gelation', W / 2, y);
  y += 5;
  renderScoringBar(W / 2 - 120, y, 240, 14, thermal.yolkGelation, 0.6, YOLK_GEL_CAP);
  y += 22;
  const yFb = getGelationFeedback(thermal.yolkGelation, 0.6, YOLK_GEL_CAP);
  ctx.fillStyle = yFb.color;
  ctx.fillText(`${yFb.label}  +${yolkScore} / 500`, W / 2, y);
}

function renderScoringBar(x, y, w, h, value, target, cap) {
  ctx.fillStyle = 'rgba(30,30,50,0.8)';
  ctx.fillRect(x, y, w, h);

  const fillFrac = clamp(value / cap, 0, 1);
  const targetFrac = target / cap;
  const fillW = fillFrac * w;
  const targetX = targetFrac * w;

  if (fillW <= targetX) {
    ctx.fillStyle = '#aa8';
    ctx.fillRect(x, y, fillW, h);
  } else {
    ctx.fillStyle = '#aa8';
    ctx.fillRect(x, y, targetX, h);
    ctx.fillStyle = '#c44';
    ctx.fillRect(x + targetX, y, fillW - targetX, h);
  }

  // Star
  ctx.fillStyle = '#fff';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('★', x + targetX, y + h / 2 + 5);

  ctx.strokeStyle = 'rgba(100,130,180,0.5)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
}

// ── Pause Overlay ──
function renderPauseOverlay() {
  ctx.save();
  ctx.fillStyle = 'rgba(5,10,25,0.65)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffcc66';
  ctx.font = 'bold 36px monospace';
  ctx.fillText('PAUSED', W / 2, H / 2 - 20);
  ctx.fillStyle = '#88ccaa';
  ctx.font = '14px monospace';
  ctx.fillText('Press P to continue  /  R to restart', W / 2, H / 2 + 20);
  ctx.restore();
}

// ── Right Boundary Wall ──
function renderBoundaryWall(ox, oy) {
  const wallX = JONES_X + 100;
  const screenX = wallX - ox;
  // Only render if visible on screen
  if (screenX < 0 || screenX > W + 20) return;

  ctx.save();
  ctx.fillStyle = 'rgba(255,120,60,0.5)';
  ctx.font = '16px monospace';
  ctx.textAlign = 'center';
  const wallPhase = ((wallScrollY % 25) + 25) % 25;
  for (let i = -1; i <= Math.ceil(H / 25) + 1; i++) {
    const screenY = wallPhase + i * 25;
    ctx.fillText('\u25B2', screenX, screenY);
  }
  // Vertical line
  ctx.strokeStyle = 'rgba(255,120,60,0.25)';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(screenX, 0);
  ctx.lineTo(screenX, H);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

// ── Delivery Prompt ──
function renderDeliveryPrompt() {
  const dx = device.x - JONES_X;
  const dy = device.y - 0;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < DELIVERY_RADIUS && gameState === 'playing') {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(10,20,40,0.8)';
    ctx.fillRect(W / 2 - 130, H - 70, 260, 35);
    ctx.strokeStyle = '#6a8';
    ctx.lineWidth = 1;
    ctx.strokeRect(W / 2 - 130, H - 70, 260, 35);
    ctx.fillStyle = '#88ffaa';
    ctx.font = 'bold 14px monospace';
    ctx.fillText('Press SPACE to deliver egg', W / 2, H - 48);
    ctx.restore();
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN LOOP
// ═══════════════════════════════════════════════════════════════

function loop(timestamp) {
  const dt = Math.min((timestamp - lastTime) / 1000, 0.05); // cap at 50ms
  lastTime = timestamp;
  atmosphereTime += dt;

  // ── Update ──
  if (gameState === 'playing') {
    updatePhysics(dt);
    updateCamera();
    updateParticles(dt);
    wallScrollY -= device.vy * dt;

    // Thermal ticks (1-second intervals)
    thermalAccum += dt;
    while (thermalAccum >= 1.0) {
      thermalAccum -= 1.0;
      updateThermal();
    }
  } else if (gameState === 'opening') {
    updateCamera();
    updateParticles(dt);
  }

  // ── Render ──
  ctx.clearRect(0, 0, W, H);

  if (gameState === 'instructions') {
    renderBackground();
    renderInstructions();
  } else if (gameState === 'opening') {
    renderOpening(dt);
  } else if (gameState === 'playing' || gameState === 'paused') {
    renderBackground();
    const ox = camera.x;
    const oy = camera.y;
    renderSteamParticles(ox, oy);
    renderSkyFish(ox, oy);
    renderFarm(ox, oy);
    renderJonesHouse(ox, oy);
    renderThrustParticles(ox, oy);
    renderDevice(ox, oy);
    renderBoundaryWall(ox, oy);
    renderHUD();
    renderDeliveryPrompt();
    if (gameState === 'paused') renderPauseOverlay();
  } else if (gameState === 'gameover') {
    renderBackground();
    const ox = camera.x;
    const oy = camera.y;
    renderSteamParticles(ox, oy);
    renderSkyFish(ox, oy);
    renderDevice(ox, oy);
    renderGameOver();
  } else if (gameState === 'scoring') {
    renderScoring();
  }

  requestAnimationFrame(loop);
}

// Start
requestAnimationFrame(ts => {
  lastTime = ts;
  loop(ts);
});
