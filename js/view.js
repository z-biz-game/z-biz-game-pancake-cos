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

export function createView(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const listener = opts.onFlip || (() => {});
  const motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reduce = !!(motionQuery && motionQuery.matches);
  let geom = { n: 0, burnt: false, rowH: 0, x0: 0, maxW: 0, y0: 0, w: 0, h: 0, dpr: 1 };
  let anim = null;
  let flash = null;
  let press = null;
  let shown = { sizes: [], sides: [] };
  let frameWanted = false;

  function measure() {
    const box = canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
    const w = Math.max(240, Math.round(box.width || canvas.width));
    const h = Math.max(200, Math.round((box.width || 620) * 0.72));
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
    ctx.fillStyle = withAlpha(cssColor('--plate'), 0.42);
    ctx.beginPath();
    ctx.ellipse(geom.w / 2, plateY, geom.maxW * 0.62, 11, 0, 0, Math.PI * 2);
    ctx.fill();

    const slots = positions(n);
    for (let d = 0; d < n; d++) {
      paintPancake(slots[d].rect, shown.sizes[d], n, shown.sides[d], slots[d].pressed, slots[d].drag);
    }

    // the spatula line: where a tap would cut
    if (press !== null && press >= 0) {
      const r = rectFor(press, n, shown.sizes);
      ctx.strokeStyle = withAlpha(cssColor('--warn'), 0.85);
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(geom.x0 - 14, r.y + r.h + 2.5);
      ctx.lineTo(geom.x0 + geom.maxW + 12, r.y + r.h + 2.5);
      ctx.stroke();
      ctx.setLineDash([]);
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
  // 暂停闸门。anim.start 是 performance.now() 的时间戳，anim.t = (ts - anim.start) / span
  // 直接拿墙钟差做缓动 ⇒ 暂停期间憋下的时间会在恢复那一帧一次性灌进来，翻牌直接"啪"地跳到终点。
  // 所以：暂停时不再排 rAF（anim.t 不再推进），恢复时把 anim.start 整体后移暂停时长，
  // 剩余时长原样接着走 —— 既不丢进度，也不会有恢复尖峰。
  let paused = false;
  let pausedAt = 0;
  function tick(ts) {
    raf = null;
    if (paused) return;                       // 暂停中：一步都不许推进
    if (anim) {
      const span = reduce ? 1 : Number(cssColor('--dur-flip').replace('ms', '')) || 340;
      anim.t = Math.min(1, (ts - anim.start) / span);
      if (anim.t >= 1) {
        const done = anim.done;
        anim = null;
        if (done) done();
      }
    }
    want();
    if (anim) raf = requestAnimationFrame(tick);
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
    setPaused(v) {
      v = !!v;
      if (v === paused) return paused;
      paused = v;
      if (v) {
        pausedAt = performance.now();
        if (raf) cancelAnimationFrame(raf);
        raf = null;                            // 心跳停掉，anim.t 冻结在暂停那一刻
      } else if (anim) {
        // 关键：把起算点后移暂停时长，恢复后的 (ts - anim.start) 与暂停前连续 ⇒ 无跳变
        anim.start += performance.now() - pausedAt;
        raf = requestAnimationFrame(tick);
      }
      return paused;
    },
    isPaused: () => paused,
    animProgress: () => (anim ? anim.t : null),
    // True while a flip is mid-air. The gate waits on this instead of on a sleep, so "the animation
    // finished" is an observation and not an assumption about how long rAF takes in headless Chrome.
    get busy() {
      return !!anim;
    },
    setMotion(off) {
      reduce = !!off;
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
      if (paused) { if (done) done(); return; }   // 暂停中直接落定，不排动画
      if (reduce || !k) {
        want();
        if (done) done();
        return;
      }
      anim = { k, t: 0, start: performance.now(), done };
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
    depthAt(clientX, clientY) {
      const box = canvas.getBoundingClientRect();
      const y = clientY - box.top;
      const n = shown.sizes.length;
      if (!n) return -1;
      const scale = box.width / geom.w || 1;
      for (let d = 0; d < n; d++) {
        const r = rectFor(d, n, shown.sizes);
        if (y * scale >= r.y - geom.rowH * 0.28 && y * scale <= r.y + r.h + 2) return d;
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

  canvas.addEventListener('pointerdown', (ev) => {
    const d = view.depthAt(ev.clientX, ev.clientY);
    press = d;
    want();
    if (typeof canvas.setPointerCapture === 'function' && ev.pointerId !== undefined) {
      try {
        canvas.setPointerCapture(ev.pointerId);
      } catch {
        /* a synthetic event has no pointer to capture */
      }
    }
  });
  canvas.addEventListener('pointerup', (ev) => {
    const d = view.depthAt(ev.clientX, ev.clientY);
    press = null;
    want();
    if (d < 0) {
      listener(-1);
      return;
    }
    listener(d + 1);
  });
  canvas.addEventListener('pointercancel', () => {
    press = null;
    want();
  });

  measure();
  return view;
}
