// ═══════════════════════════════════════════════════════════════
// DoorDash on Caldara — Egg Delivery Game
// ═══════════════════════════════════════════════════════════════

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const W = 800, H = 600;

// ── Physics Constants ──
const GRAVITY = 9.81;          // m/s² downward
const THRUST_UP = 2 * GRAVITY; // 2g upward — allows actual climbing
const THRUST_SIDE = 8.0;       // m/s² horizontal
const DRAG = 0.003;            // low drag for deep dives (terminal ~54 m/s)
const MAX_SPEED = 60;          // m/s hard speed cap
const WORLD_TOP = 0;           // min depth
const WORLD_BOTTOM = 5000;     // max depth in meters
const WORLD_LEFT = -50;        // small buffer left of farm
const JONES_X = 3000;          // horizontal distance to Jones' house
const DELIVERY_RADIUS = 80;    // how close to deliver

// ── Thermal Constants ──
let A_POD = 0.08;              // pod heats/cools fast
let A_WHITE = 0.025;           // white responds to pod
let A_YOLK = 0.010;            // yolk lags behind white
let K_WHITE = 0.007;           // white gelation rate
let W_WHITE = 3;
let K_YOLK = 0.004;            // yolk gelation rate
let W_YOLK = 3;
const CRACK_THRESHOLD = 1.5;   // °C change per tick (only aggressive dives)
const CRACK_COOLDOWN = 20;     // seconds between cracks
const MAX_CRACKS = 4;          // 0-4 cracks, then broken
const BOIL_LIMIT = 20;         // seconds of boiling = game over
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
  cracks: 0,
  crackCooldown: 0,      // seconds remaining
  boilSeconds: 0,
  prevWhiteTemp: 323     // for crack detection
};

let camera = { x: 0, y: 0 };
let keys = {};
let lastTime = 0;
let thermalAccum = 0;    // accumulator for 1-second thermal ticks
let score = 0;
let highScores = JSON.parse(localStorage.getItem('caldara_scores') || '[]');

// ── Particle Systems ──
let steamParticles = [];
let thrustParticles = [];

// ── Helper Functions ──
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function outsideTemp(depth) {
  return 323 + 0.05 * depth; // K
}

function outsidePressure(depth) {
  const T = outsideTemp(depth);
  return 0.12 * Math.pow(T / 323, 4.33); // bars
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

// ── Input Handling ──
document.addEventListener('keydown', e => {
  keys[e.key] = true;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) {
    e.preventDefault();
  }
  // Close instructions
  if ((e.key === 'q' || e.key === 'Q' || e.key === 'x' || e.key === 'X') && gameState === 'instructions') {
    gameState = 'opening';
    openingTimer = 0;
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
    if (gameState === 'gameover' || gameState === 'scoring') {
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

  // Save previous white temp for crack detection
  thermal.prevWhiteTemp = thermal.eggWhiteTemp;

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

  // Shell cracking
  if (thermal.crackCooldown > 0) {
    thermal.crackCooldown -= 1;
  }
  const deltaWhite = Math.abs(thermal.eggWhiteTemp - thermal.prevWhiteTemp);
  if (deltaWhite >= CRACK_THRESHOLD && thermal.crackCooldown <= 0) {
    thermal.cracks++;
    thermal.crackCooldown = CRACK_COOLDOWN;
    if (thermal.cracks > MAX_CRACKS) {
      gameState = 'gameover';
      gameOverReason = 'Shell shattered! The egg broke apart.';
      return;
    }
  }

  // Boiling check
  if (thermal.eggWhiteTemp > boilingPointK) {
    thermal.boilSeconds++;
    if (thermal.boilSeconds > BOIL_LIMIT) {
      gameState = 'gameover';
      gameOverReason = 'Egg boiled! The interior pressure burst the egg.';
      return;
    }
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
  // Steam/atmosphere particles
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
        size: 3 + Math.random() * 8
      });
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
  const whiteScore = 100 * peak(thermal.whiteGelation, 0.9, 0.15);
  const yolkScore = 100 * peak(thermal.yolkGelation, 0.6, 0.15);
  const boilPenalty = thermal.boilSeconds * 10;
  const crackPenalty = thermal.cracks * thermal.cracks * 20;
  score = Math.round(Math.max(0, whiteScore + yolkScore - boilPenalty - crackPenalty));

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
    cracks: 0,
    crackCooldown: 0,
    boilSeconds: 0,
    prevWhiteTemp: 323
  };
  steamParticles = [];
  thrustParticles = [];
  thermalAccum = 0;
  score = 0;
  openingTimer = 0;
  gameState = 'instructions';
  gameOverReason = '';
}

// ═══════════════════════════════════════════════════════════════
// RENDERING
// ═══════════════════════════════════════════════════════════════

// ── Background ──
function renderBackground() {
  // Depth-dependent gradient for gas giant atmosphere
  const depth = Math.max(0, device.y);
  const t = clamp(depth / WORLD_BOTTOM, 0, 1);

  // Sky color transitions: pale blue → amber → deep orange → dark red
  const r1 = Math.floor(40 + t * 180);
  const g1 = Math.floor(30 + t * 60 - t * t * 80);
  const b1 = Math.floor(80 - t * 60);
  const r2 = Math.floor(20 + t * 140);
  const g2 = Math.floor(15 + t * 30 - t * t * 40);
  const b2 = Math.floor(60 - t * 50);

  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, `rgb(${r2},${g2},${b2})`);
  grad.addColorStop(1, `rgb(${r1},${g1},${b1})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Swirling current streaks
  ctx.save();
  const streakAlpha = 0.03 + t * 0.06;
  ctx.strokeStyle = `rgba(255,200,100,${streakAlpha})`;
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

  // Steam particles (rendered in world space later)
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

  // Simple chickens (small shapes)
  for (let i = 0; i < 3; i++) {
    const cx = bx - 25 + i * 20;
    const cy = by - 14;
    // Body
    ctx.fillStyle = '#e8d4a0';
    ctx.beginPath();
    ctx.ellipse(cx, cy, 5, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    // Head
    ctx.fillStyle = '#d44';
    ctx.beginPath();
    ctx.arc(cx + 4, cy - 3, 2, 0, Math.PI * 2);
    ctx.fill();
  }

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

  // Door
  ctx.fillStyle = '#5a3a1a';
  ctx.fillRect(hx - 4, hy - 20, 8, 12);

  // Window
  ctx.fillStyle = '#ffdd88';
  ctx.fillRect(hx + 8, hy - 26, 7, 6);

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
  // Egg
  ctx.fillStyle = '#f4ead0';
  ctx.beginPath();
  ctx.ellipse(dx, dy - 1, 4, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  // Cracks on egg
  if (thermal.cracks > 0) {
    ctx.strokeStyle = '#664';
    ctx.lineWidth = 0.8;
    for (let c = 0; c < Math.min(thermal.cracks, MAX_CRACKS); c++) {
      const angle = (c * 1.3 + 0.5);
      ctx.beginPath();
      ctx.moveTo(dx + Math.cos(angle) * 2, dy - 1 + Math.sin(angle) * 2);
      ctx.lineTo(dx + Math.cos(angle) * 5, dy - 1 + Math.sin(angle) * 5);
      ctx.stroke();
    }
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
  for (const p of steamParticles) {
    const alpha = (p.life / p.maxLife) * 0.15;
    const depth = Math.max(0, device.y);
    const t = clamp(depth / WORLD_BOTTOM, 0, 1);
    const r = Math.floor(200 + t * 55);
    const g = Math.floor(180 + t * 20);
    const b = Math.floor(160 - t * 60);
    ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
    ctx.beginPath();
    ctx.arc(p.x - ox, p.y - oy, p.size, 0, Math.PI * 2);
    ctx.fill();
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

// ═══════════════════════════════════════════════════════════════
// HUD / INSTRUMENT PANEL (Prototype 3)
// ═══════════════════════════════════════════════════════════════

function renderHUD() {
  ctx.save();

  const panelX = 8;
  const panelY = 8;
  const panelW = 185;
  const panelH = 250;

  // Panel background
  ctx.fillStyle = 'rgba(10,15,30,0.75)';
  ctx.fillRect(panelX, panelY, panelW, panelH);
  ctx.strokeStyle = 'rgba(100,130,180,0.4)';
  ctx.lineWidth = 1;
  ctx.strokeRect(panelX, panelY, panelW, panelH);

  ctx.font = '11px monospace';
  ctx.textAlign = 'left';
  let y = panelY + 16;
  const x = panelX + 8;
  const lh = 16; // line height

  // Depth
  ctx.fillStyle = '#8ac';
  ctx.fillText(`Depth: ${Math.round(device.y)} m`, x, y);
  y += lh;

  // Outside conditions
  const outTemp = kelvinToCelsius(outsideTemp(device.y));
  const outPres = outsidePressure(device.y);
  ctx.fillStyle = '#a96';
  ctx.fillText(`Ext: ${outTemp.toFixed(0)}°C  ${outPres.toFixed(2)} bar`, x, y);
  y += lh;

  // Pod air
  const podC = kelvinToCelsius(thermal.podAirTemp);
  const podPres = (thermal.podAirTemp / 298).toFixed(2);
  ctx.fillStyle = '#9a8';
  ctx.fillText(`Pod: ${podC.toFixed(1)}°C  ${podPres} bar`, x, y);
  y += lh;

  // Egg temps
  const whiteC = kelvinToCelsius(thermal.eggWhiteTemp);
  const yolkC = kelvinToCelsius(thermal.yolkTemp);
  ctx.fillStyle = '#dda';
  ctx.fillText(`White: ${whiteC.toFixed(1)}°C`, x, y);
  y += lh;
  ctx.fillStyle = '#da8';
  ctx.fillText(`Yolk:  ${yolkC.toFixed(1)}°C`, x, y);
  y += lh;

  // Boiling point
  const podPressure = thermal.podAirTemp / 298;
  const bpK = 4894 / (13.12 - Math.log(podPressure / 1.013));
  const bpC = kelvinToCelsius(bpK);
  const nearBoil = whiteC > bpC - 10;
  ctx.fillStyle = nearBoil ? '#f66' : '#88a';
  ctx.fillText(`Boil pt: ${bpC.toFixed(0)}°C${nearBoil ? ' ⚠' : ''}`, x, y);
  y += lh + 4;

  // White gelation bar
  renderGelationBar(x, y, 160, 10, thermal.whiteGelation, 0.9, WHITE_GEL_CAP, '#dda', 'White');
  y += 18;

  // Yolk gelation bar
  renderGelationBar(x, y, 160, 10, thermal.yolkGelation, 0.6, YOLK_GEL_CAP, '#da8', 'Yolk');
  y += 22;

  // Shell integrity
  renderShellIntegrity(x, y);
  y += 18;

  // Boiling counter
  if (thermal.boilSeconds > 0) {
    ctx.fillStyle = thermal.boilSeconds > 10 ? '#f44' : '#fa8';
    ctx.fillText(`Boiling: ${thermal.boilSeconds}/${BOIL_LIMIT}s`, x, y);
  }

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

function renderShellIntegrity(x, y) {
  ctx.font = '11px monospace';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#aaa';
  ctx.fillText('Shell: ', x, y);

  // Draw egg icons showing cracks
  const ex = x + 42;
  const ey = y - 4;

  // Egg shape
  ctx.fillStyle = thermal.cracks > MAX_CRACKS ? '#844' : '#f4ead0';
  ctx.beginPath();
  ctx.ellipse(ex + 6, ey, 6, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#664';
  ctx.lineWidth = 0.8;
  ctx.stroke();

  // Draw crack lines
  for (let c = 0; c < Math.min(thermal.cracks, MAX_CRACKS + 1); c++) {
    ctx.strokeStyle = '#442';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const a = c * 1.5 + 0.3;
    ctx.moveTo(ex + 6 + Math.cos(a) * 2, ey + Math.sin(a) * 2);
    ctx.lineTo(ex + 6 + Math.cos(a) * 7, ey + Math.sin(a) * 7);
    if (c > 1) {
      ctx.lineTo(ex + 6 + Math.cos(a + 0.4) * 5, ey + Math.sin(a + 0.4) * 5);
    }
    ctx.stroke();
  }

  // Status text
  if (thermal.cracks > MAX_CRACKS) {
    ctx.fillStyle = '#f44';
    ctx.fillText('BROKEN', ex + 18, y);
  } else if (thermal.cracks > 0) {
    ctx.fillStyle = '#fa8';
    ctx.fillText(`${thermal.cracks} crack${thermal.cracks > 1 ? 's' : ''}`, ex + 18, y);
  } else {
    ctx.fillStyle = '#8c8';
    ctx.fillText('intact', ex + 18, y);
  }
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
  ctx.fillText(`${Math.round(device.x)}m / ${JONES_X}m`, barX + barW / 2, barY + barH + 14);
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
    'Your job: deliver it 3km through the atmosphere.',
    '',
    'As you descend, the air gets hotter — cooking the egg.',
    'Oscillate your altitude to cook it just right:',
    '  White gelation target: 0.9  |  Yolk target: 0.6',
    '',
    'But watch out:',
    '  - Rapid temperature swings crack the shell',
    '  - Go too deep and the egg boils',
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
  ];
  for (let i = 0; i < controls.length; i++) {
    ctx.fillText(controls[i], W / 2, 420 + i * 20);
  }

  // Dismiss
  ctx.fillStyle = '#ffcc66';
  ctx.font = 'bold 14px monospace';
  ctx.fillText('Press Q or X to start', W / 2, 540);
}

function renderOpening(dt) {
  openingTimer += dt;

  // Show farm scene, egg dropping onto device
  renderBackground();
  const ox = camera.x;
  const oy = camera.y;
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
  } else if (openingTimer < 2.0) {
    ctx.fillText('Thruster disengaging...', W / 2, H - 40);
  } else {
    ctx.fillText('You\'re on your own!', W / 2, H - 40);
  }

  if (openingTimer >= OPENING_DURATION) {
    gameState = 'playing';
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
  ctx.font = 'bold 24px monospace';
  ctx.fillText('EGG DELIVERED!', W / 2, 80);

  renderFinalStats(130);

  // Score
  ctx.fillStyle = '#ffcc66';
  ctx.font = 'bold 20px monospace';
  ctx.fillText(`SCORE: ${score}`, W / 2, 420);

  // High scores
  ctx.fillStyle = '#8899bb';
  ctx.font = '13px monospace';
  ctx.fillText('— HIGH SCORES —', W / 2, 460);
  for (let i = 0; i < highScores.length; i++) {
    ctx.fillStyle = i === highScores.indexOf(score) ? '#ffcc66' : '#667788';
    ctx.fillText(`${i + 1}. ${highScores[i]}`, W / 2, 480 + i * 18);
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
  const whiteFeedback = thermal.whiteGelation < 0.75 ? 'Undercooked' :
    thermal.whiteGelation > 1.05 ? 'Overcooked' : 'Just right!';
  ctx.fillStyle = whiteFeedback === 'Just right!' ? '#6f6' : '#f88';
  ctx.fillText(whiteFeedback, W / 2, y);
  y += 25;

  // Yolk gelation bar
  ctx.fillStyle = '#da8';
  ctx.fillText('Egg Yolk Gelation', W / 2, y);
  y += 5;
  renderScoringBar(W / 2 - 120, y, 240, 14, thermal.yolkGelation, 0.6, YOLK_GEL_CAP);
  y += 22;
  const yolkFeedback = thermal.yolkGelation < 0.45 ? 'Undercooked' :
    thermal.yolkGelation > 0.75 ? 'Overcooked' : 'Just right!';
  ctx.fillStyle = yolkFeedback === 'Just right!' ? '#6f6' : '#f88';
  ctx.fillText(yolkFeedback, W / 2, y);
  y += 25;

  // Cracks
  ctx.fillStyle = thermal.cracks === 0 ? '#8c8' : '#fa8';
  ctx.fillText(`Shell cracks: ${thermal.cracks}  (−${thermal.cracks * thermal.cracks * 20} pts)`, W / 2, y);
  y += 20;

  // Boiling
  ctx.fillStyle = thermal.boilSeconds === 0 ? '#8c8' : '#fa8';
  ctx.fillText(`Boiling time: ${thermal.boilSeconds}s  (−${thermal.boilSeconds * 10} pts)`, W / 2, y);
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

  // ── Update ──
  if (gameState === 'playing') {
    updatePhysics(dt);
    updateCamera();
    updateParticles(dt);

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
  } else if (gameState === 'playing') {
    renderBackground();
    const ox = camera.x;
    const oy = camera.y;
    renderSteamParticles(ox, oy);
    renderFarm(ox, oy);
    renderJonesHouse(ox, oy);
    renderThrustParticles(ox, oy);
    renderDevice(ox, oy);
    renderHUD();
    renderDeliveryPrompt();
  } else if (gameState === 'gameover') {
    renderBackground();
    const ox = camera.x;
    const oy = camera.y;
    renderSteamParticles(ox, oy);
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
