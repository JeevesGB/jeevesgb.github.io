// Feed The King — web port of the PyQt6 desktop game
(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const overlay = document.getElementById('overlay');
  const startBtn = document.getElementById('start-btn');
  const muteBtn = document.getElementById('mute-btn');
  const restartBtn = document.getElementById('restart-btn');

  const W = canvas.width;
  const H = canvas.height;

  const FOOD_DATA = [
    { name: 'beans',       points: 10,   bad: false },
    { name: 'mayo',        points: 5,    bad: false },
    { name: 'pizza',       points: 20,   bad: false },
    { name: 'sausage',     points: 25,   bad: false },
    { name: 'salad',       points: -5,   bad: true },
    { name: 'water',       points: -10,  bad: true },
    { name: 'dr-now',      points: -50,  bad: true },
    { name: 'liposuction', points: -100, bad: true },
  ];

  const MAX_FOOD_SIZE = 70;
  const MAX_PLAYER_SIZE = 70;

  function loadImage(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  function loadSound(src) {
    const audio = new Audio(src);
    audio.preload = 'auto';
    return audio;
  }

  // Scale like Qt's KeepAspectRatio to a max bounding box
  function scaledSize(img, maxSize) {
    if (!img) return { w: maxSize, h: maxSize };
    const ratio = Math.min(maxSize / img.width, maxSize / img.height, 1);
    return { w: img.width * ratio, h: img.height * ratio };
  }

  const state = {
    running: false,
    score: 0,
    playerX: 0,
    playerY: 0,
    playerSize: { w: MAX_PLAYER_SIZE, h: MAX_PLAYER_SIZE },
    speed: 8,
    keys: new Set(),
    food: null,          // {name, points, bad, img, x, y, w, h}
    foodSpeed: 4,
    feedbackText: '',
    feedbackColor: '#7cd88c',
    feedbackTimer: 0,
    flashRed: 0,
    musicMuted: false,
  };

  let images = {};
  let sounds = {};
  let bgImg = null;
  let playerImg = null;

  async function preload() {
    const foodNames = FOOD_DATA.map(f => f.name);
    const imgPromises = foodNames.map(n => loadImage(`img/${n}.png`).then(img => { images[n] = img; }));
    const playerPromise = loadImage('img/player.png').then(img => { playerImg = img; });
    const bgPromise = loadImage('img/bg.png').then(img => { bgImg = img; });

    sounds = {
      start: loadSound('snd/start.wav'),
      mayo: loadSound('snd/mayo.wav'),
      ohyeah: loadSound('snd/ohyeah.wav'),
      ooh: loadSound('snd/ooh.wav'),
      dayum: loadSound('snd/dayum.wav'),
      'dr-now': loadSound('snd/now.wav'),
    };
    sounds.music = loadSound('snd/music.wav');
    sounds.music.loop = true;
    sounds.music.volume = 0.35;

    await Promise.all([...imgPromises, playerPromise, bgPromise]);
  }

  function playSound(key) {
    const s = sounds[key];
    if (!s) return;
    try {
      const clone = s.cloneNode();
      clone.volume = s.volume || 0.9;
      clone.play().catch(() => {});
    } catch (e) { /* ignore */ }
  }

  function resetGame() {
    state.score = 0;
    state.speed = 8;
    state.foodSpeed = 4;
    state.feedbackTimer = 0;
    state.flashRed = 0;
    state.playerSize = scaledSize(playerImg, MAX_PLAYER_SIZE);
    state.playerX = (W - state.playerSize.w) / 2;
    state.playerY = H - state.playerSize.h - 20;
    spawnFood();
  }

  function spawnFood() {
    const data = FOOD_DATA[Math.floor(Math.random() * FOOD_DATA.length)];
    const img = images[data.name];
    const size = scaledSize(img, MAX_FOOD_SIZE);
    const x = 20 + Math.random() * (W - size.w - 40);
    state.food = {
      ...data,
      img,
      w: size.w,
      h: size.h,
      x,
      y: -size.h,
    };
  }

  function rectsIntersect(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x &&
           a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function update() {
    let dx = 0;
    if (state.keys.has('ArrowLeft') || state.keys.has('a') || state.keys.has('A')) dx -= state.speed;
    if (state.keys.has('ArrowRight') || state.keys.has('d') || state.keys.has('D')) dx += state.speed;

    state.playerX += dx;
    state.playerX = Math.max(0, Math.min(state.playerX, W - state.playerSize.w));

    const f = state.food;
    f.y += state.foodSpeed;

    if (f.y > H) {
      spawnFood();
    } else {
      const playerRect = { x: state.playerX, y: state.playerY, w: state.playerSize.w, h: state.playerSize.h };
      if (rectsIntersect(playerRect, f)) {
        const points = f.points;
        state.score = Math.max(0, state.score + points);

        if (points > 0) {
          state.feedbackText = `+${points}`;
          state.feedbackColor = '#50dc64';
        } else {
          state.feedbackText = `${points}`;
          state.feedbackColor = '#ff5050';
          state.flashRed = 15;
        }

        if (f.name === 'mayo') playSound('mayo');
        else if (f.name === 'dr-now') playSound('dr-now');
        else if (f.bad) playSound('dayum');
        else if (Math.random() < 0.4) playSound('ohyeah');

        state.feedbackTimer = 40;
        state.foodSpeed = 4 + Math.floor(state.score / 30);
        spawnFood();
      }
    }

    if (state.feedbackTimer > 0) state.feedbackTimer--;
    if (state.flashRed > 0) state.flashRed--;
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);

    if (bgImg) {
      ctx.drawImage(bgImg, 0, 0, W, H);
    } else {
      ctx.fillStyle = '#1e1e28';
      ctx.fillRect(0, 0, W, H);
    }

    if (state.flashRed > 0) {
      ctx.fillStyle = `rgba(200, 30, 30, ${0.39 * (state.flashRed / 15)})`;
      ctx.fillRect(0, 0, W, H);
    }

    const f = state.food;
    if (f && f.img) {
      ctx.drawImage(f.img, f.x, f.y, f.w, f.h);
    }

    if (playerImg) {
      ctx.drawImage(playerImg, state.playerX, state.playerY, state.playerSize.w, state.playerSize.h);
    }

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px Arial';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`Score: ${state.score}`, 20, 40);

    if (state.feedbackTimer > 0) {
      ctx.fillStyle = state.feedbackColor;
      ctx.font = 'bold 28px Arial';
      ctx.fillText(
        state.feedbackText,
        state.playerX + state.playerSize.w / 2 - 30,
        state.playerY - 10
      );
    }

    const instructions = '← → or A D  •  Catch good food, avoid the bad ones!';
    ctx.font = '12px Arial';
    ctx.fillStyle = '#a0a0aa';
    const textWidth = ctx.measureText(instructions).width;
    ctx.fillText(instructions, W - textWidth - 20, 30);
  }

  let lastTime = 0;
  const STEP = 16; // ms, matches original 60fps-ish timer
  let acc = 0;

  function loop(ts) {
    if (!state.running) return;
    if (!lastTime) lastTime = ts;
    let delta = ts - lastTime;
    lastTime = ts;
    acc += delta;

    while (acc >= STEP) {
      update();
      acc -= STEP;
    }
    draw();
    requestAnimationFrame(loop);
  }

  function startGame() {
    overlay.style.display = 'none';
    restartBtn.style.display = 'inline-block';
    resetGame();
    playSound('start');
    sounds.music.currentTime = 0;
    sounds.music.play().catch(() => {});
    state.running = true;
    lastTime = 0;
    acc = 0;
    requestAnimationFrame(loop);

    if (window._oohInterval) clearInterval(window._oohInterval);
    window._oohInterval = setInterval(() => {
      if (Math.random() < 0.3) playSound('ooh');
    }, 8000);
  }

  window.addEventListener('keydown', (e) => {
    if (['ArrowLeft', 'ArrowRight', 'a', 'A', 'd', 'D'].includes(e.key)) {
      e.preventDefault();
    }
    state.keys.add(e.key);
  });
  window.addEventListener('keyup', (e) => {
    state.keys.delete(e.key);
  });

  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    startBtn.textContent = 'Loading…';
    await preload();
    startBtn.disabled = false;
    startGame();
  });

  restartBtn.addEventListener('click', () => {
    resetGame();
    playSound('start');
  });

  muteBtn.addEventListener('click', () => {
    state.musicMuted = !state.musicMuted;
    sounds.music.muted = state.musicMuted;
    muteBtn.textContent = state.musicMuted ? 'Unmute Music' : 'Mute Music';
  });
})();
