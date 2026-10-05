// Frame-rate invariance and the controls that are "行为成立, not string-hit": the flip animation
// advances by accumulating each frame's dt, a pause stops the simulation without billing the wall
// clock on resume, mute truly suspends the AudioContext and creates no new oscillator while off,
// and a restart resets the run while keeping the hint ledger.
//
// The bug class this file locks down: the official cos_frame_probe.js cannot load a bare-ES-module
// repo at all (vm.runInContext throws on `import`), so dt-invariance had no committed guard here —
// only an ephemeral harness. Part A replays the same virtual duration at 30/60/120Hz and asserts
// animT agrees to <1e-6 at shared checkpoints; a `dt = ts - lastTs` -> constant mutation makes those
// three runs diverge, so this assertion fails on exactly the regression it is meant to catch.
//
// view.js reads `document`, `requestAnimationFrame`, `performance`, `matchMedia`, `getComputedStyle`
// as free globals inside its functions, so a small virtual clock is installed on globalThis. Each
// suite file runs in its own node process, so this stays contained to this file.

import { suite } from '../tools/harness.mjs';
import { LOTS } from '../js/data/lots.js';
import { createGame } from '../js/game.js';
import { createAudio } from '../js/audio/synth.js';
import { createView } from '../js/view.js';

const t = suite('frame');

// ---------- a controllable virtual rAF + DOM, installed for view.js ----------
const env = (() => {
  let clock = 1000;
  let fps = 60;
  let rafId = 1;
  const rafMap = new Map();
  const requestAnimationFrame = (cb) => { const id = rafId++; rafMap.set(id, cb); return id; };
  const cancelAnimationFrame = (id) => rafMap.delete(id);
  const rect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 };
  const ctx2d = new Proxy({}, {
    get: (o, k) => (k === 'getImageData' ? () => ({ data: new Uint8ClampedArray(4) })
      : k === 'measureText' ? () => ({ width: 10 }) : () => {}),
    set: () => true,
  });
  const noopEl = { style: {}, dataset: {}, getBoundingClientRect: () => rect, getContext: () => ctx2d, addEventListener() {}, setPointerCapture() {} };
  const documentStub = {
    documentElement: { dataset: {}, style: {} }, body: { dataset: {} },
    createElement: () => noopEl, querySelector: () => noopEl, querySelectorAll: () => [],
    getComputedStyle: () => ({ getPropertyValue: () => '' }), addEventListener() {},
  };
  const performanceStub = { now: () => clock, timeOrigin: 1000 };
  const matchMediaStub = () => ({ matches: false, addEventListener() {}, addListener() {} });
  for (const [k, v] of Object.entries({
    window: { performance: performanceStub, devicePixelRatio: 1, addEventListener() {} },
    document: documentStub, location: { search: '', hash: '' }, performance: performanceStub,
    requestAnimationFrame, cancelAnimationFrame, matchMedia: matchMediaStub, devicePixelRatio: 1,
    getComputedStyle: documentStub.getComputedStyle, setTimeout: () => 1, clearTimeout() {},
    setInterval: () => 1, clearInterval() {}, Image: function () { return { addEventListener() {} }; },
  })) Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true });
  globalThis.window.window = globalThis.window;
  const frameTo = (t2) => { clock = t2; const batch = [...rafMap.values()]; rafMap.clear(); for (const cb of batch) cb(clock); };
  const advanceTo = (target) => { const step = 1000 / fps; while (clock + step <= target - 1e-9) frameTo(clock + step); if (clock < target - 1e-9) frameTo(target); };
  return {
    canvas: () => ({ getContext: () => ctx2d, getBoundingClientRect: () => rect, addEventListener() {}, setPointerCapture() {}, style: {}, width: 0, height: 0 }),
    setFps(f) { fps = f; },
    reset() { clock = 1000; rafMap.clear(); },
    advanceTo,
  };
})();

const START = { n: 5, burnt: false, sizes: [3, 1, 5, 2, 4], sides: [] };
const newView = () => createView(env.canvas(), {});

t.where('帧率无关: 翻面动画按 dt 累加, 同一虚拟时长在 30/60/120Hz 下 animT 一致');
{
  const cps = [1200, 1300, 1400]; // span defaults to 340ms, so these are all mid-flight (0<t<1)
  const runs = {};
  for (const fps of [30, 60, 120]) {
    env.setFps(fps); env.reset();
    const view = newView();
    view.show(START);
    env.advanceTo(1100); // settle; lastTs = performance.now() = 1100 at flip start
    view.animateFlip(3, () => {});
    const s = {};
    for (const c of cps) { env.advanceTo(c); s[c] = view.animProgress(); }
    runs[fps] = s;
  }
  let maxSpread = 0;
  for (const c of cps) {
    const v = [30, 60, 120].map((f) => runs[f][c]);
    maxSpread = Math.max(maxSpread, Math.max(...v) - Math.min(...v));
  }
  t.ok('动画确实随虚拟时长推进 (非静止快照)', runs[60][1200] > 0 && runs[60][1200] < runs[60][1300] && runs[60][1300] < runs[60][1400] && runs[60][1400] < 1);
  t.near('三档逐检查点最大偏差 < 1e-6', maxSpread, 0, 1e-6);
}

t.where('暂停是真停: 冻结的动画不随虚拟时长推进, 恢复不补记暂停掉的秒数');
{
  env.setFps(60); env.reset();
  const view = newView();
  view.show(START);
  view.animateFlip(3, () => {});
  env.advanceTo(1100); // +100ms -> t = 100/340
  const before = view.animProgress();
  view.freeze();
  env.advanceTo(2100); // 1000ms of frames elapse while paused
  const during = view.animProgress();
  t.ok('暂停前动画在推进', before > 0 && before < 1);
  t.eq('freeze 置位', view.paused, true);
  t.eq('+1000ms 虚拟时长后 animT 纹丝不动', during - before, 0);
  view.resume();
  const atResume = view.animProgress();
  env.advanceTo(2200); // +100ms after resume
  const after = view.animProgress();
  t.eq('resume 不跳变 (暂停的时间没被补记)', atResume - during, 0);
  t.near('resume 后只按 +100ms 推进', after - atResume, 100 / 340, 1e-6);
}

t.where('静音: 真 suspend AudioContext, 静音态不再新建振荡器节点');
{
  const stat = { osc: 0, susp: 0, resume: 0 };
  function FakeAC() {
    const self = this; self.state = 'suspended'; self.currentTime = 0; self.sampleRate = 44100; self.destination = {};
    self.createOscillator = () => { stat.osc++; return { connect: (d) => d, start() {}, stop() {}, frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, type: 'x' }; };
    self.createGain = () => ({ connect: (d) => d, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } });
    self.suspend = () => { stat.susp++; self.state = 'suspended'; return Promise.resolve(); };
    self.resume = () => { stat.resume++; self.state = 'running'; return Promise.resolve(); };
  }
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  const a = createAudio(storage, { AudioContext: FakeAC, enabled: true });
  a.unlock(); a.flip(3, 8); a.flip(2, 8);
  t.ok('有声音时振荡器被创建且上下文运行', stat.osc > 0 && a.running === true);
  a.setEnabled(false);
  t.eq('静音把上下文 suspend (running=false)', a.running, false);
  const atMute = stat.osc;
  a.flip(3, 8); a.flip(2, 8); a.reject(); a.hint();
  t.eq('静音态再玩不新建任何振荡器', stat.osc - atMute, 0);
  a.setEnabled(true); a.unlock(); a.flip(4, 8);
  t.ok('取消静音后恢复发声', stat.osc > atMute);
}

t.where('重开: 复位走带与牌面, 但保留提示台账');
{
  const row = LOTS.find((r) => r.mode === 'plain' && r.n >= 4);
  const g = createGame(row);
  const startStack = g.position.sizes.join(',');
  const p = g.optimalPath();
  for (let i = 0; i < Math.min(2, p.length); i++) g.flip(p[i]);
  const midStack = g.position.sizes.join(',');
  g.hint();
  const hints = g.hints;
  g.restart();
  t.eq('走带清零', g.count, 0);
  t.eq('牌面回到起手 (且起手不等于中间态)', [g.position.sizes.join(','), midStack !== startStack], [startStack, true]);
  t.ok('提示次数不被重开洗掉', g.hints === hints && hints >= 1);
}

t.done();
