// The canvas: a stack of pancakes you can click under.
//
// Geometry lives here and nowhere else — `rectFor(depth)` is the same function the pointer handler
// and the browser gate use, so a hit-test that only works where the code was written is not
// possible. Sizes are 1..n (1 = smallest); depth 0 is the top of the stack, which on screen is the
// *narrowest* pancake, and the widths grow downward.
//
// prefers-reduced-motion is read once at construction and again by setMotion(); with motion off the
// flip is drawn as its end state, because "no animation" has to mean the game still plays.

const PAD_X = 26;
const TOP_PAD = 34;
const BOT_PAD = 26;
// iOS 的拇指下限是 44pt，这里按 CSS px 同一尺度用。画布只在 0.72 比例给的高度里排饼：
// 桌面 728px 宽时行距顶到 46px 够用，380px 手机上 8 层只剩 22.75px —— 那才是点 A 打 B 的来源。
// 所以 measure() 只在"排不下"时长高画布，本来就够的关卡（n=3 手机上行距 46）比例不动。
const MIN_HIT = 44;

// 母题的两张位图，由 assets/gen/make_art.py 现产（颜色抽自 css/game.css 的 token）。
// 铲刃就是图标上那一铲，画在切线上；颗粒是中性明度的铁板麻点，以 overlay 压在盘面上。
const SPATULA_SRC = 'art/spatula-720x96.png';
const GRAIN_SRC = 'art/grain-256.png';
const SPATULA_W = 720;
const SPATULA_H = 96;

export function createView(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const listener = opts.onFlip || (() => {});
  const motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reduce = !!(motionQuery && motionQuery.matches);
  let geom = { n: 0, burnt: false, rowH: 0, x0: 0, maxW: 0, y0: 0, w: 0, h: 0, need: 0, dpr: 1 };
  let anim = null;
  let flash = null;
  let press = null;
  let shown = { sizes: [], sides: [] };
  let frameWanted = false;
  // Null until (and unless) the sheet decodes: file://, an offline first paint and this repo's node
  // harness all leave these empty, and the vector fallbacks below are what those cases draw.
  let spatula = null;
  let grain = null;

  function loadArt() {
    if (typeof Image !== 'function') return;
    const blade = new Image();
    blade.onload = () => {
      if (!blade.naturalWidth && !blade.width) return;
      spatula = blade;
      want();
    };
    blade.src = SPATULA_SRC;
    const tile = new Image();
    tile.onload = () => {
      // A 0x0 source throws in some engines, and a throw here would take the whole board down.
      if (!(tile.naturalWidth || tile.width)) return;
      try {
        grain = ctx.createPattern(tile, 'repeat');
      } catch {
        grain = null;
      }
      want();
    };
    tile.src = GRAIN_SRC;
  }
  loadArt();

  function measure() {
    const box = canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
    const w = Math.max(240, Math.round(box.width || canvas.width));
    const aspect = Math.round(w * 0.72);
    // 0.72 is the shape the layout gate measures; a stack that cannot fit its thumb rows inside it
    // grows the canvas instead, so the rows never shrink below MIN_HIT.
    const need = TOP_PAD + BOT_PAD + Math.max(0, geom.n) * MIN_HIT;
    const h = Math.max(200, aspect, need);
    // What the 44px row floor demands, exposed so the layout gate can check both branches of the
    // rule ("0.72 ratio when it fits, row floor when it does not") instead of only the first.
    geom.need = need;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    geom.w = w;
    geom.h = h;
    geom.dpr = dpr;
    return geom;
  }

  function layout(n) {
    const rows = Math.max(1, n);
    geom.x0 = PAD_X + 18;
    geom.maxW = Math.max(60, geom.w - geom.x0 - PAD_X - 26);
    geom.y0 = TOP_PAD;
    geom.rowH = Math.max(14, Math.min(46, (geom.h - TOP_PAD - BOT_PAD) / rows));
  }

  // The pancake at `depth`: its rect in CSS pixels, plus the x-offset the flip animation uses.
  function rectFor(depth, n, sizes) {
    const size = sizes[depth] || 1;
    const w = geom.maxW * (0.34 + 0.66 * (size / Math.max(1, n)));
    const x = geom.x0 + (geom.maxW - w) / 2;
    const y = geom.y0 + depth * geom.rowH;
    return { x, y, w, h: Math.max(10, geom.rowH - 5) };
  }

  function draw() {
    frameWanted = false;
    const n = shown.sizes.length;
    ctx.clearRect(0, 0, geom.w, geom.h);
    if (!n) return;

    // plate — a token colour, because "the theme changed" has to be visible on the canvas too, not
    // only in the DOM. platePoint() hands the gate the exact pixel to read.
    const plateY = geom.y0 + n * geom.rowH + 6;
    ctx.beginPath();
    ctx.ellipse(geom.w / 2, plateY, geom.maxW * 0.62, 11, 0, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(cssColor('--plate'), 0.42);
    ctx.fill();
    if (grain) {
      // The ellipse path is still current, so clip() + fill() puts the pitting on the plate and
      // nowhere else. 'overlay' on a neutral-luminance tile: darks deepen, lights lift, neither
      // palette tints. The small inner hole keeps platePoint() honest: this plate is translucent
      // (alpha 0.42), so 'overlay' would mix the tile's own grey into the sampled pixel and the
      // theme gate would read a colour that is not the --plate token.
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(geom.w / 2, plateY, geom.maxW * 0.62, 11, 0, 0, Math.PI * 2);
      ctx.ellipse(geom.w / 2, plateY, 6, 4, 0, 0, Math.PI * 2, true);
      ctx.clip('evenodd');
      ctx.globalCompositeOperation = 'overlay';
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = grain;
      ctx.fill();
      ctx.restore();
    }

    const slots = positions(n);
    for (let d = 0; d < n; d++) {
      paintPancake(slots[d].rect, shown.sizes[d], n, shown.sides[d], slots[d].pressed, slots[d].drag);
    }

    // the spatula line: where a tap would cut
    if (press !== null && press >= 0) {
      const r = rectFor(press, n, shown.sizes);
      const cutY = r.y + r.h + 2.5;
      const x0 = geom.x0 - 14;
      const w = geom.maxW + 26;
      if (spatula) {
        // The sheet keeps its own shape; its centre line sits on exactly the y the hit band was
        // computed from, so what the player sees and what the tap means cannot drift apart.
        const h = w * (SPATULA_H / SPATULA_W);
        ctx.save();
        ctx.globalAlpha = 0.97;
        ctx.drawImage(spatula, x0, cutY - h / 2, w, h);
        ctx.restore();
      } else {
        ctx.strokeStyle = withAlpha(cssColor('--warn'), 0.85);
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x0, cutY);
        ctx.lineTo(x0 + w, cutY);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // the count column: how many pancakes a tap here moves
    ctx.font = '600 12px ' + (cssColor('--mono') || 'monospace');
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (let d = 0; d < n; d++) {
      ctx.fillStyle = d === 0 && !geom.burnt ? withAlpha(cssColor('--bad'), 0.95) : withAlpha(cssColor('--ink-dim'), 0.98);
      ctx.fillText(String(d + 1), slots[d].rect.x - 12, slots[d].rect.y + slots[d].rect.h / 2);
    }
  }

  // Where each depth is drawn right now, including the in-flight offsets of a flip.
  function positions(n) {
    const out = [];
    for (let d = 0; d < n; d++) {
      let rect = rectFor(d, n, shown.sizes);
      let drag = false;
      if (anim && d < anim.k) {
        const target = anim.k - 1 - d;
        const to = rectFor(target, n, shown.sizes);
        const t = anim.t;
        const lift = Math.sin(Math.PI * t);
        rect = {
          x: rect.x + lift * (geom.w * 0.06),
          y: rect.y + (to.y - rect.y) * t,
          w: rect.w,
          h: rect.h * (1 - 0.28 * lift),
        };
        drag = true;
      }
      out.push({ rect, pressed: flash && flash.depth === d, drag });
    }
    return out;
  }

  function paintPancake(r, size, n, burntSide, pressed, dragging) {
    const tone = 0.42 + 0.58 * (size / Math.max(1, n));
    const base = geom.burnt ? mix('--pancake-plain', '--pancake-plain-2', tone) : mix('--pancake-plain', '--pancake-syrup', tone);
    const rad = Math.min(r.h / 2, 11);
    round(r.x, r.y, r.w, r.h, rad);
    ctx.fillStyle = base;
    ctx.fill();
    if (pressed) {
      ctx.fillStyle = withAlpha(cssColor('--press-light'), 0.18);
      ctx.fill();
    }
    // The burnt side is a physical face: draw it on the top edge when that face is up, on the
    // bottom edge otherwise. A stack that is sorted but face-up has to *look* unfinished.
    if (geom.burnt) {
      const edgeH = Math.max(4, r.h * 0.34);
      const y = burntSide ? r.y : r.y + r.h - edgeH;
      ctx.save();
      round(r.x, r.y, r.w, r.h, rad);
      ctx.clip();
      ctx.fillStyle = cssColor('--pancake-burnt');
      ctx.fillRect(r.x, y, r.w, edgeH);
      ctx.fillStyle = cssColor('--pancake-edge');
      ctx.fillRect(r.x, y === r.y ? y + edgeH - 2 : y, r.w, 2);
      ctx.restore();
    }
    ctx.lineWidth = dragging ? 2 : 1;
    ctx.strokeStyle = dragging ? cssColor('--warn') : withAlpha(cssColor('--stack-line'), 0.4);
    round(r.x, r.y, r.w, r.h, rad);
    ctx.stroke();
    ctx.fillStyle = withAlpha(cssColor('--label-ink'), 0.7);
    ctx.font = '700 ' + Math.max(10, Math.min(15, r.h * 0.62)) + 'px ' + cssFont();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(size), r.x + r.w / 2, r.y + r.h / 2 + 0.5);
  }

  function cssFont() {
    return 'ui-monospace, SFMono-Regular, Menlo, monospace';
  }

  function round(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  const tokenCache = new Map();
  function cssColor(name) {
    if (!tokenCache.has(name)) {
      tokenCache.set(name, getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888');
    }
    return tokenCache.get(name);
  }
  function mix(a, b, k) {
    return blend(cssColor(a), cssColor(b), k);
  }
  function parse3(c) {
    const s = c.replace('#', '');
    const v = s.length === 3 ? s.split('').map((x) => x + x) : [s.slice(0, 2), s.slice(2, 4), s.slice(4, 6)];
    return v.map((x) => parseInt(x, 16) || 0);
  }
  // The palette is hex, the canvas wants an rgba() string, and the alpha belongs on the drawing call
  // rather than baked into a second set of literals — otherwise a theme swap changes the token and
  // the plate stays the colour it was drawn with on the first frame.
  function withAlpha(color, a) {
    const [r, g, b] = color.startsWith('#') ? parse3(color) : color.replace(/[^\d,]/g, '').split(',').map(Number);
    return `rgba(${r},${g},${b},${a})`;
  }
  function blend(c1, c2, k) {
    const A = parse3(c1);
    const B = parse3(c2);
    return `rgb(${A.map((x, i) => Math.round(x + (B[i] - x) * k)).join(',')})`;
  }

  let raf = null;
  let lastTs = 0;
  let frozen = false;

  // The flip advances by accumulating each frame's delta instead of reading the wall clock: a paused
  // animation then simply stops accumulating, and resume() re-bases `lastTs` so the seconds the
  // player spent paused are never billed to the animation. Summing deltas also means 30 Hz and 144 Hz
  // traverse the same `span` of milliseconds.
  function tick(ts) {
    raf = null;
    if (!anim || frozen) return;
    const span = reduce ? 1 : Number(cssColor('--dur-flip').replace('ms', '')) || 340;
    const dt = Math.max(0, ts - lastTs);
    lastTs = ts;
    anim.elapsed = Math.min(span, anim.elapsed + dt);
    anim.t = anim.elapsed / span;
    if (anim.t >= 1) {
      const done = anim.done;
      anim = null;
      if (done) done();
      want();
      return;
    }
    want();
    raf = requestAnimationFrame(tick);
  }

  function want() {
    if (frameWanted) return;
    frameWanted = true;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => draw());
    else draw();
  }

  const view = {
    canvas,
    get reduced() {
      return reduce;
    },
    // 对外的暂停口就是 freeze/resume：主程序只认这一个布尔返回值，内部状态仍只有 `frozen` 一份。
    setPaused(v) {
      const on = !!v;
      if (on === frozen) return frozen;
      if (on) this.freeze(); else this.resume();
      return frozen;
    },
    // True while a flip is mid-air. The gate waits on this instead of on a sleep, so "the animation
    // finished" is an observation and not an assumption about how long rAF takes in headless Chrome.
    get busy() {
      return !!anim;
    },
    setMotion(off) {
      reduce = !!off;
    },
    // How far the flip in the air has got, 0..1, or null when the stack is at rest. `null` and `0`
    // are different facts — "no flip in the air" vs "a flip at its first frame" — and the gate reads
    // the difference to tell "paused before anything moved" from "landed without easing".
    animProgress() {
      return anim ? anim.t : null;
    },
    get paused() {
      return frozen;
    },
    // Stop mid-flip with the elapsed time kept: the model already flipped, so resuming has to finish
    // *that* flip. Restarting it from 0 would replay a catch-up toward a stack the game left behind.
    freeze() {
      frozen = true;
      if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
      want();
    },
    resume() {
      if (!frozen) return false;
      frozen = false;
      // Re-based, not carried: the wall-clock time spent paused must not count as animation time.
      lastTs = performance.now();
      if (anim && raf === null) raf = requestAnimationFrame(tick);
      return true;
    },
    // A theme switch changes what the tokens *say*, and this cache is keyed by property name, not
    // by value — so dropping it is the difference between a palette that repaints and one that
    // remembers the scheme it was first drawn under.
    retoken() {
      tokenCache.clear();
      want();
    },
    // The spatula line without a pointer: keyboard play drives it from the focused depth.
    preview(depth) {
      press = typeof depth === 'number' && depth >= 0 ? depth : null;
      want();
    },
    resize() {
      measure();
      layout(shown.sizes.length);
      want();
    },
    // Paint a level from scratch (a new game, an undo, a restart).
    show(pos) {
      geom.n = pos.n;
      geom.burnt = pos.burnt;
      shown = { sizes: pos.sizes.slice(), sides: pos.sides.slice() };
      measure();
      layout(pos.n);
      anim = null;
      frozen = false;
      want();
    },
    // The model has already flipped, so `pos` is the *new* stack. Take it and draw it arriving from
    // the slots it came out of: rectFor(d) is where depth d now belongs and rectFor(k-1-d) is where
    // it was, which is exactly the interpolation positions() applies for d < k. No re-measure here —
    // the stack height has not changed, and getBoundingClientRect per move is a forced layout.
    flipTo(pos, k, done) {
      geom.n = pos.n;
      geom.burnt = pos.burnt;
      shown = { sizes: pos.sizes.slice(), sides: pos.sides.slice() };
      layout(pos.n);
      view.animateFlip(k, done);
    },
    // After the model has flipped: run the visual catch-up, then hand control back.
    animateFlip(k, done) {
      if (reduce || !k) {
        want();
        if (done) done();
        return;
      }
      anim = { k, t: 0, elapsed: 0, done };
      lastTs = performance.now();
      if (raf !== null) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    },
    reject(depth) {
      flash = depth === undefined ? null : { depth };
      want();
      setTimeout(() => {
        flash = null;
        want();
      }, 260);
    },
    // Depth under a client coordinate, or -1 when the tap missed the stack.
    // Each band is the row centred on its pancake and extended to the full pitch: no gap that would
    // read as a miss, and no overlap that lets the row above steal a tap aimed at the one below.
    // `measure()` is what keeps that pitch at or above MIN_HIT.
    depthAt(clientX, clientY) {
      const box = canvas.getBoundingClientRect();
      const y = clientY - box.top;
      const n = shown.sizes.length;
      if (!n) return -1;
      // `geom.w` is the CSS width the stack was laid out against; the box may since have changed
      // (rotation, a layout shift before the resize handler runs). The forward map is
      // screen = drawing * scale, so the inverse is a division — multiplying lands the tap on the
      // wrong row, which is exactly "点 A 打 B".
      const scale = box.width / geom.w;
      if (!(scale > 0)) return -1;
      const v = y / scale;
      for (let d = 0; d < n; d++) {
        const r = rectFor(d, n, shown.sizes);
        const half = Math.max(r.h / 2, geom.rowH / 2);
        const c = r.y + r.h / 2;
        if (v >= c - half && v <= c + half) return d;
      }
      return -1;
    },
    // Client-space point of a tap that would flip `k` pancakes — used by the pointer gate and by
    // keyboard focus drawing.
    pointFor(k) {
      const d = Math.max(0, Math.min(shown.sizes.length - 1, k - 1));
      const box = canvas.getBoundingClientRect();
      const scale = box.width / geom.w || 1;
      const r = rectFor(d, shown.sizes.length, shown.sizes);
      return {
        x: box.left + (r.x + r.w / 2) * scale,
        y: box.top + (r.y + r.h / 2) * scale,
        rect: { x: r.x, y: r.y, w: r.w, h: r.h },
        depth: d,
        k: d + 1,
      };
    },
    // Whether each sheet actually reached the canvas, and under which path: a harness asserts on
    // this plus the recorded draw calls instead of trusting a screenshot.
    artState() {
      return { spatula: !!spatula, grain: !!grain, sources: [SPATULA_SRC, GRAIN_SRC] };
    },
    geom() {
      // `press` is the depth the spatula line is currently drawn at, and it has to be readable: a
      // line left on screen after the pointer went up is a cut the player thinks is still armed.
      return { ...geom, count: shown.sizes.length, press };
    },
    // Where the plate ellipse is solid, in CSS pixels: the one place on the canvas whose colour is
    // the --plate token and nothing else, so a theme gate can compare it to the stylesheet.
    platePoint() {
      const n = shown.sizes.length;
      return { x: geom.w / 2, y: geom.y0 + n * geom.rowH + 6, empty: !n };
    },
    pixels(x, y) {
      const dpr = geom.dpr;
      const px = Math.round(x * dpr);
      const py = Math.round(y * dpr);
      const d = ctx.getImageData(px, py, 1, 1).data;
      return [d[0], d[1], d[2]];
    },
  };

  // Where a press began, in drawing space, and what a release at the same place means.
  const pressDown = (clientX, clientY) => {
    press = view.depthAt(clientX, clientY);
    want();
  };
  const pressUp = (clientX, clientY) => {
    const d = view.depthAt(clientX, clientY);
    press = null;
    want();
    listener(d < 0 ? -1 : d + 1);
  };

  // Read at construction, not at module load, so the fallback branch is reachable in a harness.
  const supportsPointer = typeof window !== 'undefined' && 'onpointerdown' in window;
  if (supportsPointer) {
    canvas.addEventListener('pointerdown', (ev) => {
      pressDown(ev.clientX, ev.clientY);
      if (typeof canvas.setPointerCapture === 'function' && ev.pointerId !== undefined) {
        try {
          canvas.setPointerCapture(ev.pointerId);
        } catch {
          /* a synthetic event has no pointer to capture */
        }
      }
    });
    canvas.addEventListener('pointerup', (ev) => pressUp(ev.clientX, ev.clientY));
    canvas.addEventListener('pointercancel', () => {
      press = null;
      want();
    });
  } else {
    const first = (ev) => (ev.touches && ev.touches[0]) || (ev.changedTouches && ev.changedTouches[0]) || null;
    // passive:false because a touch that starts on the stack must not scroll the page underneath it,
    // and preventDefault on touchend is what stops the browser firing a *second* flip as a
    // compatibility mousedown/mouseup pair.
    canvas.addEventListener('touchstart', (ev) => {
      const p = first(ev);
      if (p) pressDown(p.clientX, p.clientY);
      if (ev.preventDefault) ev.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchend', (ev) => {
      const p = (ev.changedTouches && ev.changedTouches[0]) || first(ev);
      if (p) pressUp(p.clientX, p.clientY);
      if (ev.preventDefault) ev.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchcancel', () => {
      press = null;
      want();
    });
    canvas.addEventListener('mousedown', (ev) => pressDown(ev.clientX, ev.clientY));
    canvas.addEventListener('mouseup', (ev) => pressUp(ev.clientX, ev.clientY));
  }

  measure();
  return view;
}
