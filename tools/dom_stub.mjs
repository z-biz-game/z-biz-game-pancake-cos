// A browser stub that is honest enough to boot the real page (js/main.js) inside node.
//
// Why this file exists: the org's frame probe (`cos_frame_probe.js`) runs each `<script src>` from
// index.html through `vm.runInContext` as a *classic* script, so it throws on `import` for every
// ES-module repo in the fleet (55 of 95 at the 2026-10-03 sweep, this one included). That leaves
// "same virtual duration, different frame rate" unmeasured by anything the orchestrator runs. The
// substitute has to drive the *page*, not one function: the only dt integrator in this repo is
// `view.tick`'s `anim.elapsed`, and the thing a player feels is when the flip lands — which is
// view + main + the pointer path + the win callback together.
//
// What is modelled, and why each piece is load-bearing rather than decorative:
//   - a virtual clock starting at 1000 ms (starting at 0 gets eaten by `lastTs === 0` sentinels and
//     invents a 25 ms frame-rate dependency), driven by `advanceTo`,
//   - `setTimeout`/`setInterval` that fire on that clock between frames — the toast, the shake and
//     the rejection flash are otherwise dead timers and the app's state stops meaning anything,
//   - a recording 2D context, so "the sprite was drawn" is a call count and not a screenshot hope,
//   - `Image` whose `onload` fires on the next frame, so an art path can be tested both loaded and
//     never-loaded (the file:// / offline case) without a network,
//   - `location.hash` that dispatches `hashchange` synchronously, matching what `navigate()` in
//     main.js assumes, and a per-selector element cache, because main.js compares
//     `ev.target === $('#board')` — a fresh element per call would silently disable Enter/Space.

const DEFAULT_TOKENS = {
  '--dur-flip': '340ms',
  '--plate': '#3a2f22',
  '--pancake-plain': '#e8a34d',
  '--pancake-plain-2': '#c9762f',
  '--pancake-syrup': '#b5541f',
  '--pancake-burnt': '#5a3216',
  '--pancake-edge': '#2a1608',
  '--warn': '#f0b429',
  '--bad': '#d9534f',
  '--ink-dim': '#8a7a66',
  '--press-light': '#ffffff',
  '--stack-line': '#2a1608',
  '--label-ink': '#241a10',
  '--mono': 'ui-monospace',
};

export function installDom(opts = {}) {
  const tokens = { ...DEFAULT_TOKENS, ...(opts.tokens || {}) };
  let clock = 1000;
  let fps = 60;
  let rafId = 1;
  const rafMap = new Map();
  const timers = [];
  let timerId = 1;
  const imageQueue = [];
  const stats = { images: [], drawCalls: 0 };
  const audioContexts = [];

  const classList = (el) => ({
    add(...n) { for (const c of n) el._cls.add(c); },
    remove(...n) { for (const c of n) el._cls.delete(c); },
    contains(c) { return el._cls.has(c); },
    toggle(c, force) {
      const want = force === undefined ? !el._cls.has(c) : !!force;
      if (want) el._cls.add(c); else el._cls.delete(c);
      return want;
    },
  });

  function makeCtx2d(el) {
    const calls = new Map();
    const args = new Map();
    // Every ctx method has to be countable, including the ones that must return a real value:
    // a test asserting "the art was drawn through canvas" reads the call log, so a stubbed method
    // that silently skipped the log would make that claim unfalsifiable.
    const record = (name, impl) => (...a) => {
      calls.set(name, (calls.get(name) || 0) + 1);
      (args[name] = args[name] || []).push(a);
      stats.drawCalls++;
      return impl ? impl(...a) : undefined;
    };
    const base = {
      canvas: el,
      _calls: calls,
      _args: args,
      getImageData: record('getImageData', () => ({ data: el._pixelData || new Uint8ClampedArray([0, 0, 0, 0]) })),
      measureText: record('measureText', () => ({ width: 10 })),
      createPattern: record('createPattern', () => ({ __pattern: true })),
      createLinearGradient: record('createLinearGradient', () => ({ addColorStop() {} })),
      createRadialGradient: record('createRadialGradient', () => ({ addColorStop() {} })),
    };
    return new Proxy(base, {
      get(o, k) {
        if (k in o) return o[k];
        if (typeof k !== 'string') return undefined;
        const fn = (...a) => {
          o._calls.set(k, (o._calls.get(k) || 0) + 1);
          (o._args[k] = o._args[k] || []).push(a);
          stats.drawCalls++;
          return undefined;
        };
        o[k] = fn;
        return fn;
      },
      set(o, k, v) { o[k] = v; return true; },
    });
  }

  function makeEl(tag, id) {
    const text = { nodeType: 3, textContent: '' };
    const el = {
      id: id || '',
      tagName: String(tag || 'div').toUpperCase(),
      nodeType: 1,
      _cls: new Set(),
      _attrs: new Map(),
      _h: {},
      childNodes: [text],
      children: [],
      dataset: {},
      style: {},
      disabled: false,
      hidden: false,
      open: false,
      title: '',
      width: 0,
      height: 0,
      offsetWidth: 800,
      offsetHeight: 600,
      _rect: { left: 0, top: 0, width: 800, height: 600 },
    };
    el.classList = classList(el);
    if (String(tag).toLowerCase() === 'canvas') el._ctx = makeCtx2d(el);
    Object.defineProperties(el, {
      className: {
        get: () => [...el._cls].join(' '),
        set: (v) => { el._cls = new Set(String(v).split(/\s+/).filter(Boolean)); },
      },
      textContent: {
        get: () => (el.children.length ? el.children.map((c) => c.textContent).join('') : text.textContent),
        set: (v) => { el.children.length = 0; el.childNodes.length = 1; text.textContent = v === undefined ? '' : String(v); },
      },
      lastElementChild: { get: () => el.children[el.children.length - 1] || null },
    });
    el.getContext = (k) => (el._ctx || (el._ctx = makeCtx2d(el)));
    el.getBoundingClientRect = () => {
      const r = el._rect;
      return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top };
    };
    el.setPointerCapture = () => {};
    el.releasePointerCapture = () => {};
    el.hasPointerCapture = () => false;
    el.scrollIntoView = () => {};
    el.focus = () => {};
    el.appendChild = (c) => { el.children.push(c); c.parentNode = el; return c; };
    el.removeChild = (c) => { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; };
    el.setAttribute = (k, v) => { el._attrs.set(k, String(v)); if (k === 'id') el.id = String(v); };
    el.getAttribute = (k) => (el._attrs.has(k) ? el._attrs.get(k) : null);
    el.removeAttribute = (k) => el._attrs.delete(k);
    el.addEventListener = (t, cb) => { (el._h[t] = el._h[t] || []).push(cb); };
    el.removeEventListener = (t, cb) => { el._h[t] = (el._h[t] || []).filter((f) => f !== cb); };
    el.dispatch = (t, ev) => {
      const e = { type: t, target: el, currentTarget: el, preventDefault() { e.defaultPrevented = true; }, stopPropagation() {}, ...ev };
      for (const cb of (el._h[t] || []).slice()) cb(e);
      const prop = el['_on' + t];
      if (typeof prop === 'function') prop(e);
      return e;
    };
    el.requestFullscreen = () => { doc.fullscreenElement = el; return Promise.resolve(); };
    el.querySelector = (sel) => doc.querySelector(sel);
    return el;
  }

  const bySelector = new Map();
  const screens = ['menu', 'board-screen', 'win'].map((id) => makeEl('section', id));
  const doc = makeEl('html');
  doc.documentElement = doc;
  doc.body = makeEl('body');
  doc.fullscreenElement = null;
  doc.title = '';
  doc.exitFullscreen = () => { doc.fullscreenElement = null; return Promise.resolve(); };
  doc.querySelector = (sel) => {
    if (!bySelector.has(sel)) {
      const id = /^#([\w-]+)$/.exec(sel);
      bySelector.set(sel, makeEl(id ? 'div' : 'el', id ? id[1] : ''));
    }
    return bySelector.get(sel);
  };
  doc.querySelectorAll = (sel) => (sel === '.screen' ? screens.slice() : []);
  doc.createElement = (tag) => makeEl(tag);
  doc.createTextNode = (text) => ({
    nodeType: 3,
    textContent: String(text === undefined ? '' : text),
    dispatch: () => {},
    classList: classList({ _cls: new Set() }),
    dataset: {},
    children: [],
  });
  doc.getElementById = (id) => doc.querySelector('#' + id);

  const perf = { now: () => clock, timeOrigin: 1000 };
  const mediaQueries = opts.mediaQueries || {};
  const mqlCache = new Map();
  function matchMedia(q) {
    if (!mqlCache.has(q)) {
      const subs = [];
      const l = {
        media: q,
        get matches() { return typeof mediaQueries[q] === 'function' ? mediaQueries[q]() : !!mediaQueries[q]; },
        addEventListener: (t, cb) => { if (t === 'change') subs.push(cb); },
        addListener: (cb) => subs.push(cb),
        removeEventListener() {},
        _fire: (v) => { mediaQueries[q] = v; for (const cb of subs.slice()) cb({ matches: !!v }); },
      };
      mqlCache.set(q, l);
    }
    return mqlCache.get(q);
  }

  function FakeAudioContext() {
    const self = this;
    self.state = 'running';
    self.currentTime = 0;
    self.sampleRate = 44100;
    self.destination = { connect: () => {} };
    self.oscCount = 0;
    self.suspendCount = 0;
    self.resumeCount = 0;
    self.createOscillator = () => {
      self.oscCount++;
      return {
        type: 'sine', connect: (d) => d, disconnect() {}, start() {}, stop() {},
        frequency: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {} },
      };
    };
    self.createGain = () => ({
      connect: (d) => d, disconnect() {},
      gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} },
    });
    self.createBiquadFilter = () => ({ connect: (d) => d, frequency: { value: 0, setValueAtTime() {} }, Q: { value: 1 } });
    self.createBuffer = () => ({ getChannelData: () => new Float32Array(1024) });
    self.createBufferSource = () => ({ connect: (d) => d, start() {}, stop() {}, playbackRate: { value: 1 } });
    self.suspend = () => { self.suspendCount++; self.state = 'suspended'; return Promise.resolve(); };
    self.resume = () => { self.resumeCount++; self.state = 'running'; return Promise.resolve(); };
    self.close = () => Promise.resolve();
    audioContexts.push(self);
  }

  let loadImages = opts.loadImages !== false;
  function FakeImage() {
    const self = this;
    self.width = 0;
    self.height = 0;
    self.naturalWidth = 0;
    self.naturalHeight = 0;
    self.complete = false;
    self._h = {};
    self.addEventListener = (t, cb) => { (self._h[t] = self._h[t] || []).push(cb); };
    self.dispatch = (t) => {
      self.complete = t === 'load';
      if (self.complete) {
        // A decoded bitmap reports its intrinsic size, and view.js refuses to build a pattern from a
        // 0x0 source — so the stub has to answer like a real one.
        const m = /(\d+)x(\d+)/.exec(String(self._src));
        self.naturalWidth = self.width = m ? Number(m[1]) : 256;
        self.naturalHeight = self.height = m ? Number(m[2]) : 256;
      }
      if (typeof self['on' + t] === 'function') self['on' + t]({ type: t });
      for (const cb of (self._h[t] || []).slice()) cb({ type: t });
    };
    Object.defineProperty(self, 'src', {
      get: () => self._src,
      set: (v) => {
        self._src = v;
        stats.images.push(v);
        if (!loadImages) return;
        imageQueue.push(self);
      },
    });
  }

  const store = new Map();
  const localStorageStub = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    get length() { return store.size; },
    key: (i) => [...store.keys()][i] ?? null,
  };

  const location = {
    pathname: '/index.html',
    search: opts.search || '',
    _hash: opts.hash || '',
    protocol: 'http:',
    href: 'http://localhost/index.html',
    get hash() { return this._hash; },
    set hash(v) {
      const next = v && v !== '#' ? (String(v)[0] === '#' ? String(v) : '#' + String(v)) : '';
      if (next === this._hash) return;
      this._hash = next;
      fire(win._h, 'hashchange', { newURL: this.href + next });
    },
  };
  const history = {
    replaceState(state, title, url) {
      if (typeof url === 'string') {
        const m = /([^?#]*)(\?[^#]*)?(#.*)?$/.exec(url);
        if (m) { if (m[2] !== undefined) location.search = m[2]; location.hash = m[3] || ''; }
      }
    },
    pushState() {},
  };

  function fire(handlers, type, ev) {
    for (const cb of ((handlers[type] || []).slice())) cb({ type, target: doc, ...ev, preventDefault() {}, stopPropagation() {} });
  }

  const win = {
    document: doc,
    location,
    history,
    performance: perf,
    localStorage: localStorageStub,
    devicePixelRatio: opts.devicePixelRatio || 2,
    innerWidth: 1200,
    innerHeight: 900,
    AudioContext: FakeAudioContext,
    webkitAudioContext: FakeAudioContext,
    Image: FakeImage,
    matchMedia,
    getComputedStyle: (el) => ({ getPropertyValue: (n) => (tokens[n] !== undefined ? tokens[n] : '') }),
    navigator: { userAgent: 'node-dom-stub', maxTouchPoints: opts.maxTouchPoints || 0, language: 'zh-CN' },
    addEventListener: (t, cb) => { (win._h[t] = win._h[t] || []).push(cb); },
    removeEventListener: (t, cb) => { win._h[t] = (win._h[t] || []).filter((f) => f !== cb); },
    requestAnimationFrame: (cb) => { const id = rafId++; rafMap.set(id, cb); return id; },
    cancelAnimationFrame: (id) => rafMap.delete(id),
    setTimeout: (cb, ms) => { const id = timerId++; timers.push({ at: clock + Math.max(0, Number(ms) || 0), cb, id }); return id; },
    setInterval: (cb, ms) => { const iv = Math.max(1, Number(ms) || 1), id = timerId++; timers.push({ at: clock + iv, cb, id, interval: iv }); return id; },
    clearTimeout: (id) => { const t = timers.find((x) => x.id === id); if (t) t.dead = true; },
    clearInterval: (id) => { const t = timers.find((x) => x.id === id); if (t) t.dead = true; },
    dispatch: (type, ev) => fire(win._h, type, ev),
    _h: {},
    console,
    URLSearchParams,
    fetch: () => Promise.reject(new Error('no network in the stub')),
  };
  win.window = win;
  win.self = win;
  win.globalThis = win;
  // A real window carries these handler slots only when the platform supports that input model, and
  // view.js feature-detects with `'onpointerdown' in window`.
  const POINTER_SLOTS = ['onpointerdown', 'onpointerup', 'onpointercancel', 'onpointermove'];
  const MOUSE_SLOTS = ['onmousedown', 'onmouseup', 'onmousemove'];
  const TOUCH_SLOTS = ['ontouchstart', 'ontouchend', 'ontouchcancel'];
  for (const k of [...POINTER_SLOTS, ...MOUSE_SLOTS, ...TOUCH_SLOTS]) win[k] = null;
  function setPointerSupport(on) {
    for (const k of POINTER_SLOTS) {
      if (on) win[k] = null;
      else delete win[k];
    }
  }

  const g = {
    window: win, document: doc, location, history, performance: perf, localStorage: localStorageStub,
    navigator: win.navigator, devicePixelRatio: win.devicePixelRatio, innerWidth: win.innerWidth, innerHeight: win.innerHeight,
    matchMedia, getComputedStyle: win.getComputedStyle, AudioContext: FakeAudioContext, Image: FakeImage,
    requestAnimationFrame: win.requestAnimationFrame, cancelAnimationFrame: win.cancelAnimationFrame,
    setTimeout: win.setTimeout, setInterval: win.setInterval, clearTimeout: win.clearTimeout, clearInterval: win.clearInterval,
    console, URLSearchParams,
  };
  if (opts.installGlobals !== false) {
    for (const [k, v] of Object.entries(g)) {
      Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true });
    }
  }

  const step = () => 1000 / fps;
  function frameTo(t) {
    clock = t;
    for (const img of imageQueue.splice(0)) img.dispatch('load');
    for (const tm of timers) {
      if (tm.dead || tm.at > clock) continue;
      if (tm.interval) tm.at = clock + tm.interval; else tm.dead = true;
      try { tm.cb(); } catch { /* a timer that throws must not abort the ladder */ }
    }
    for (let i = timers.length - 1; i >= 0; i--) if (timers[i].dead) timers.splice(i, 1);
    const batch = [...rafMap.values()];
    rafMap.clear();
    for (const cb of batch) cb(clock);
  }
  function advanceTo(target) {
    const s = step();
    while (clock + s <= target - 1e-9) frameTo(clock + s);
    if (clock < target - 1e-9) frameTo(target);
  }

  const board = makeEl('canvas', 'board');
  board._rect = { left: 0, top: 0, width: 800, height: 576 };
  bySelector.set('#board', board);
  doc.querySelector = ((real) => (sel) => (sel === '#board' ? board : real(sel)))(doc.querySelector);

  return {
    win, doc, board, screens, tokens, stats, audioContexts, setPointerSupport,
    setLoadImages(on) { loadImages = !!on; },
    el: (sel) => doc.querySelector(sel),
    setFps(f) { fps = f; },
    get fps() { return fps; },
    get clock() { return clock; },
    setRect(rect) { board._rect = { ...board._rect, ...rect }; },
    setToken(name, value) { tokens[name] = value; },
    matchMediaQuery: matchMedia,
    fireTimersTo: advanceTo,
    frameTo,
    advanceTo,
    // Drop everything the previous run left in flight, so ladder 2 does not inherit ladder 1's
    // pending toast. The clock restarts at the same 1000 ms for every run. A pending image decode
    // is *not* dropped: in a real browser setting `src` has already committed the download, and
    // cancelling it here would mean the page's own canvas never receives its art.
    reset() { clock = 1000; rafMap.clear(); timers.length = 0; },
    pixelData: (rgb) => { board._ctx._pixelData = new Uint8ClampedArray([rgb[0], rgb[1], rgb[2], 255]); },
  };
}
