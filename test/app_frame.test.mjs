// The 关卡内 three-ladder reading the org probe cannot produce for an ES-module repo.
//
// `cos_frame_probe.js` runs index.html's `<script src>` through `vm.runInContext` as classic
// scripts, so this repo answers `结论：无法比对（SyntaxError: Cannot use import statement outside a
// module）` — 55 of the 95 repos in the 2026-10-03 sweep are ESM and every one of them reads the
// same way. BRIEF_COS §3 says such a reading is *not* a pass and the writer has to supply the
// judgement himself, so this file boots the real page (js/main.js) on tools/dom_stub.mjs, enters a
// level through the same `hashchange` a click produces, taps the canvas with client coordinates
// that go through `depthAt`, and replays one virtual duration at 30/60/120Hz.
//
// Two things are measured, deliberately differently:
//   - `animT` at *forced shared checkpoints*: the flip's elapsed time is an accumulator, so at the
//     same virtual instant every ladder must report the same number to <1e-6. This is the claim a
//     player feels ("the flip takes 340 ms, not 340 ms divided by however fast you render").
//   - the frame on which the flip *lands*: that is quantised to the frame grid by construction, so
//     the honest rule is the probe's own — spread/gap ≤ 3.0 is a ruler boundary, > 3.6 is a frame
//     rate dependency. Both numbers are printed.
//
// The negative control (§6: pin the mutation to a line that still eats frame dt) mutates
// `anim.elapsed + dt` into `anim.elapsed + 16.666` in a /tmp copy of view.js and re-runs the same
// sampler. If that does not go red, the ruler here is running empty and this file is worthless.

import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { suite } from '../tools/harness.mjs';
import { installDom } from '../tools/dom_stub.mjs';
import { createView } from '../js/view.js';

const t = suite('app-frame');
const env = installDom();

await import('../js/main.js');
const app = env.win.pancake;
if (!app) {
  t.fail('js/main.js 没有挂出 window.pancake，任何探针都读不到状态');
  t.done();
}

const LEVEL = 'pk-reg-1'; // n=5, par 5: one flip cannot win it, so the ladder watches a mid-flight board
const CPS = [1120, 1150, 1200, 1250, 1300, 1340, 1400, 1500];
const FLIP_START = 1100;

function snap() {
  const s = app.state;
  return {
    animT: s.animT,
    count: s.count,
    over: s.over,
    stack: s.stack.join(','),
    sides: s.sides.join(','),
    screen: s.screen,
    solved: s.solved,
    paused: s.paused,
    busy: app.view.busy ? 1 : 0,
    press: app.view.geom().press,
  };
}

// A real pointer gesture at the pixel that means "flip k": down and up both go through
// view.depthAt(), which is the only place the CSS-scaled coordinate is turned back into a row.
function tapAt(k) {
  const p = app.view.pointFor(k);
  env.board.dispatch('pointerdown', { clientX: p.x, clientY: p.y, pointerId: 1, isPrimary: true });
  env.board.dispatch('pointerup', { clientX: p.x, clientY: p.y, pointerId: 1, isPrimary: true });
}

function enterBoard() {
  env.reset();
  app.begin(LEVEL);
  env.advanceTo(FLIP_START);
}

function ladder(fps, k) {
  env.setFps(fps);
  enterBoard();
  const rows = {};
  tapAt(k);
  for (const c of CPS) {
    env.advanceTo(c);
    rows[c] = snap();
  }
  return rows;
}

// Landing time is read by stepping the ladder's own frame grid, never by forcing a checkpoint.
function landing(fps, k) {
  env.setFps(fps);
  enterBoard();
  tapAt(k);
  const step = 1000 / fps;
  for (let n = 1; app.view.busy && n < 600; n++) env.frameTo(FLIP_START + n * step);
  return env.clock;
}

t.where('进得了关卡：注入的 hashchange 真的把页面推进 board 态（探针的 ⚪ 仅标题态）');
{
  env.setFps(60);
  enterBoard();
  const s = app.state;
  t.eq('screen', s.screen, 'board');
  t.eq('不是暂停态（Space 被按成 PAUSED 是实测踩过的坑）', s.paused, false);
  t.eq('关卡号', s.id, LEVEL);
  t.eq('层数', s.n, 5);
  t.ok('牌面非空', s.stack.length === 5);
}

t.where('三档对拍：同一虚拟时长的 animT / 离散状态逐字段一致');
const runs = { 30: ladder(30, 3), 60: ladder(60, 3), 120: ladder(120, 3) };
{
  let worst = 0;
  const lines = [];
  for (const c of CPS) {
    const v = [30, 60, 120].map((f) => runs[f][c].animT);
    const spread = Math.max(...v) - Math.min(...v);
    worst = Math.max(worst, spread);
    lines.push(`  t=${c}ms animT 30/60/120 = ${v.map((x) => x.toFixed(9)).join(' / ')}  spread=${spread.toExponential(2)}`);
  }
  console.log(lines.join('\n'));
  t.ok('动画确实在推进（静止快照会被这条洗掉）', runs[60][1120].animT > 0 && runs[60][1500].animT === 0);
  t.near('八检查点 animT 最大偏差 < 1e-6', worst, 0, 1e-6);
  const discreteFields = ['count', 'over', 'stack', 'sides', 'screen', 'solved', 'paused', 'press', 'busy'];
  let diffs = 0;
  for (const c of CPS) {
    for (const f of discreteFields) {
      if (runs[30][c][f] !== runs[60][c][f] || runs[60][c][f] !== runs[120][c][f]) diffs++;
    }
  }
  t.eq('离散字段（步数/牌面/焦面/屏/暂停/铲线）三档零差异', diffs, 0);
}

t.where('落定时刻：按帧栅格量化，判据用 spread/gap 比值（>3.6 才算帧率依赖）');
{
  const land = { 30: landing(30, 3), 60: landing(60, 3), 120: landing(120, 3) };
  const vals = [land[30], land[60], land[120]];
  const spread = Math.max(...vals) - Math.min(...vals);
  const gap = 1000 / 30; // the coarsest ladder's frame pitch is the quantisation unit
  const ratio = spread / gap;
  console.log(`  落定虚拟时刻 30/60/120Hz = ${land[30].toFixed(4)} / ${land[60].toFixed(4)} / ${land[120].toFixed(4)} ms  spread=${spread.toFixed(4)} gap=${gap.toFixed(4)} 比值=${ratio.toFixed(3)}`);
  t.ok('翻面在 340ms 之后、400ms 之前落定（span 来自 --dur-flip）', land[60] >= 1440 && land[60] <= 1500);
  t.ok('比值 ≤ 3.0：一阶采样滞后属探针边界，不是缺陷', ratio <= 3.0, `ratio=${ratio}`);
}

t.where('阴性对照：把累加器改成常量，同一把尺必须变红');
{
  const src = readFileSync(new URL('../js/view.js', import.meta.url), 'utf8');
  const needle = 'anim.elapsed = Math.min(span, anim.elapsed + dt);';
  const hits = src.split(needle).length - 1;
  t.eq('js/view.js 里那行吃帧 dt 的累加器还在（改了就换靶子）', hits, 1);
  const mutant = src.replace(needle, 'anim.elapsed = Math.min(span, anim.elapsed + 16.666);');
  const file = path.join(tmpdir(), 'pancake-view-mutant.mjs');
  writeFileSync(file, mutant);
  const { createView: createMutantView } = await import(pathToFileURL(file).href);
  const POS = { n: 5, burnt: false, sizes: [4, 1, 3, 5, 2], sides: [] };
  const runMutant = (fps) => {
    env.setFps(fps);
    env.reset();
    const mv = createMutantView(env.board, {});
    mv.show(POS);
    env.advanceTo(FLIP_START);
    mv.animateFlip(3, () => {});
    const at = {};
    for (const c of CPS) {
      env.advanceTo(c);
      at[c] = mv.animProgress();
    }
    const step = 1000 / fps;
    for (let n = 1; mv.busy && n < 900; n++) env.frameTo(FLIP_START + n * step);
    return { at, land: env.clock };
  };
  const m = { 30: runMutant(30), 60: runMutant(60), 120: runMutant(120) };
  let mSpread = 0;
  for (const c of CPS) {
    const v = [30, 60, 120].map((f) => m[f].at[c]);
    mSpread = Math.max(mSpread, Math.max(...v) - Math.min(...v));
  }
  const mLand = [m[30].land, m[60].land, m[120].land];
  const mRatio = (Math.max(...mLand) - Math.min(...mLand)) / (1000 / 30);
  console.log(`  变异体 animT 八检查点最大偏差 = ${mSpread.toFixed(6)}；落定 ${mLand.map((x) => x.toFixed(1)).join('/')} 比值=${mRatio.toFixed(2)}`);
  t.ok('变异体 animT 跨档发散（尺子不是空跑）', mSpread > 0.05);
  t.ok('变异体落定时刻比值 > 3.6', mRatio > 3.6);
}

t.where('暂停是真停（页面级）：P 键冻结，恢复后不补记暂停掉的秒数');
{
  env.setFps(60);
  enterBoard();
  tapAt(3);
  env.advanceTo(1150);
  const before = app.state.animT;
  env.doc.dispatch('keydown', { key: 'p', target: env.board });
  t.eq('P 键把页面推进暂停态', app.state.paused, true);
  env.advanceTo(2150);
  t.eq('暂停 1000ms 后 animT 不动', app.state.animT - before, 0);
  t.eq('暂停期间铲子拒绝再翻', (tapAt(4), app.state.count), 1);
  env.doc.dispatch('keydown', { key: 'p', target: env.board });
  const atResume = app.state.animT;
  env.advanceTo(2200);
  t.near('恢复后只按 +50ms 推进', app.state.animT - atResume, 50 / 340, 1e-6);
  t.eq('恢复后牌面没有多翻一张', app.state.count, 1);
}

t.where('M 键静音：AudioContext 真 suspend，静音态不再新建振荡器');
{
  env.setFps(60);
  enterBoard();
  tapAt(3);
  env.advanceTo(1600);
  const ctx = env.audioContexts[0];
  t.ok('首次交互后上下文在跑且有振荡器', !!ctx && ctx.state === 'running' && ctx.oscCount > 0);
  env.doc.dispatch('keydown', { key: 'm', target: env.board });
  t.eq('M 键关掉音效', app.state.sound, false);
  t.eq('上下文被 suspend', ctx.state, 'suspended');
  const at = ctx.oscCount;
  tapAt(4);
  tapAt(5);
  t.eq('静音态再翻不产生任何振荡器', ctx.oscCount - at, 0);
  env.doc.dispatch('keydown', { key: 'm', target: env.board });
  tapAt(4);
  t.ok('取消静音后恢复发声', ctx.oscCount > at);
}

t.where('R 重开：走带清零、提示台账保留；H 交出最优首步');
{
  env.setFps(60);
  enterBoard();
  env.doc.dispatch('keydown', { key: 'h', target: env.board });
  const hints = app.state.hints;
  tapAt(3);
  env.advanceTo(1600);
  t.eq('先记一步', app.state.count, 1);
  env.doc.dispatch('keydown', { key: 'r', target: env.board });
  t.eq('R 键清零步数', app.state.count, 0);
  t.eq('牌面回到起手', app.state.stack, [4, 1, 3, 5, 2]);
  t.ok('提示次数不被重开洗掉', app.state.hints === hints && hints >= 1);
}

t.where('坐标按 CSS 缩放换算：画布被缩放后点第 3 张仍然翻第 3 张');
{
  const scaledTap = (ratio) => {
    env.setFps(60);
    enterBoard();
    // 缩放发生在 measure() 之后：geom 仍是 800 空间，盒子换成 800*ratio 且整体偏移。
    // 任何把 client 坐标再乘一次 scale 的写法在这里就会翻错张（实测：0.5x 时翻到第 1 张）。
    env.setRect({ left: 120, top: 64, width: 800 * ratio, height: 576 * ratio });
    const p = app.view.pointFor(3);
    t.ok(`命中点落在缩放后的盒子里 (${ratio}x)`, p.x >= 120 && p.x <= 120 + 800 * ratio && p.y >= 64 && p.y <= 64 + 576 * ratio);
    env.board.dispatch('pointerdown', { clientX: p.x, clientY: p.y, pointerId: 1, isPrimary: true });
    env.board.dispatch('pointerup', { clientX: p.x, clientY: p.y, pointerId: 1, isPrimary: true });
    env.advanceTo(1600);
    t.eq(`缩放 ${ratio}x 后翻的还是第 3 张`, app.state.moves.join(','), '3');
    env.setRect({ left: 0, top: 0, width: 800, height: 576 });
  };
  scaledTap(0.5);
  scaledTap(1.5);
}

t.where('输入回落：没有 Pointer Events 的浏览器（老 iOS Safari）靠 touch/mouse 一样能翻');
{
  const canvas2 = env.doc.createElement('canvas');
  canvas2._rect = { left: 0, top: 0, width: 800, height: 576 };
  const taps = [];
  env.setPointerSupport(false);
  const v2 = createView(canvas2, { onFlip: (k) => taps.push(k) });
  env.setPointerSupport(true);
  v2.show({ n: 5, burnt: false, sizes: [4, 1, 3, 5, 2], sides: [] });
  const p = v2.pointFor(4);
  let prevented = 0;
  const touch = (type, at) => {
    const q = at || p;
    return canvas2.dispatch(type, {
      touches: type === 'touchstart' ? [{ clientX: q.x, clientY: q.y }] : [],
      changedTouches: [{ clientX: q.x, clientY: q.y }],
      preventDefault() { prevented++; },
    });
  };
  touch('touchstart');
  t.eq('touchstart 把铲线停在第 4 张下面', v2.geom().press, 3);
  touch('touchend');
  t.eq('touchend 交出第 4 张', taps.join(','), '4');
  t.eq('两端各 preventDefault 一次（挡住页面滚动与兼容 click）', prevented, 2);
  canvas2.dispatch('mousedown', { clientX: p.x, clientY: p.y });
  canvas2.dispatch('mouseup', { clientX: p.x, clientY: p.y });
  t.eq('纯鼠标机器上 mousedown/up 也能翻', taps.join(','), '4,4');
  canvas2.dispatch('pointerdown', { clientX: p.x, clientY: p.y });
  canvas2.dispatch('pointerup', { clientX: p.x, clientY: p.y });
  t.eq('回落分支不再同时听 pointer 事件，不会双触发', taps.join(','), '4,4');
  const miss = { x: p.x, y: canvas2._rect.top + 5 };
  touch('touchstart', miss);
  touch('touchend', miss);
  t.eq('落在摞外的触摸报 -1，让页面去解释而不是静默吞掉', taps.join(','), '4,4,-1');
}

t.done();
