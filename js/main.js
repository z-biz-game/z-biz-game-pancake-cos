// The page: routes, the HUD, the pointer/keyboard path into the model, and progress on disk.
//
// Two invariants this file is written to keep:
//   - the DOM never states a number the engine did not produce. par / starts / detour / best all come
//     from LOTS or from the distance field, and `window.pancake.verifyTable()` re-derives the
//     whole table in the browser the gate runs in;
//   - every way the player can try to move goes through `game.flip`, including the ones that are not
//     moves. A rejected tap produces a reason, a toast, a shake and a different sound; a silent
//     rejection is indistinguishable from a dropped input, which is a bug the player cannot report.
import { LOTS, MEASURED_DIAMETER } from './data/lots.js';
import { TIERS, tierIdOf } from './engine/tiers.js';
import { checkRows, sampleLevel, SEED_BASE } from './engine/library.js';
import { field } from './engine/graph.js';
import { grade } from './engine/rules.js';
import { createGame } from './game.js';
import { createView } from './view.js';
import { createStore } from './store.js';
import { createTheme } from './theme.js';
import { createAudio } from './audio/synth.js';

const VERSION = '1.0.0';
const SEED_KEY = 'pancake.seed.v1';

const q = new URLSearchParams(location.search);
const storage = (() => {
  try {
    if (window.localStorage) return window.localStorage;
  } catch {
    /* private mode, or a storage partition that throws on touch */
  }
  const mem = new Map();
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
})();

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt !== undefined) n.textContent = txt;
  return n;
};

const REASONS = {
  'not-a-number': '那一下没落在饼摞里',
  'past-the-bottom': '铲子插到盘子底下了，下面没有饼',
  'one-plain-pancake-does-not-move': '只翻最上面一张，等于没翻 —— 从第二张下面插',
  'too-shallow': '太浅了，这一铲翻不动',
  illegal: '这一铲不合法',
  'already-solved': '这一摞已经叠好了',
};

const theme = createTheme(storage);
if (q.get('theme')) theme.set(q.get('theme'), false);
const audio = createAudio(storage);
const store = createStore(storage);
const progress = store.load();

let game = null;
let row = null;
let screen = 'menu';
let focusDepth = 0;
let toastTimer = null;

const view = createView($('#board'), { onFlip: (k) => onFlip(k) });
// ?motion=off is the only way to reach the reduced-motion path from a headless browser that cannot
// be told to prefer it: Emulation.setEmulatedMedia is a second driver, and this repo's gate is one.
if (q.get('motion') === 'off') view.setMotion(true);
theme.onChange(() => view.retoken());

// ---------- routes ----------

// `#pk-<tier>-<k>` is a baked row; `#pk-<tier>-r<seed36>` is a freshly sampled one whose seed is in
// the address, so any link someone pastes you replays exactly.
function parseRoute(hash) {
  const h = decodeURIComponent((hash || '').replace(/^#/, ''));
  if (!h || h === 'menu') return { screen: 'menu' };
  const m = /^pk-([a-z]+)-(r[0-9a-z]+|\d+)$/.exec(h);
  if (!m) return { screen: 'menu', unknown: h };
  const tier = tierIdOf(h);
  if (!tier) return { screen: 'menu', unknown: h };
  if (m[2][0] === 'r') {
    const seed = parseInt(m[2].slice(1), 36);
    const found = Number.isFinite(seed) ? sampleLevel(tier, seed) : null;
    return found ? { screen: 'board', row: found, seed } : { screen: 'menu', unknown: h };
  }
  const found = LOTS.find((r) => r.id === h) || null;
  return found ? { screen: 'board', row: found } : { screen: 'menu', unknown: h };
}

function navigate(id) {
  const next = '#' + id;
  if (location.hash === next) apply();
  else location.hash = next;
}

function apply() {
  const route = parseRoute(location.hash);
  if (route.screen === 'board') {
    const note = $('#menu-note');
    if (note) {
      note.hidden = true;
      note.textContent = '';
    }
    startLevel(route.row);
    return;
  }
  if (route.unknown) {
    const note = $('#menu-note');
    if (note) {
      note.textContent = `没有 ${route.unknown} 这一关：地址栏里的关卡号要么打错了，要么不属于这版的关卡表。下面是全部 ${LOTS.length} 关。`;
      note.hidden = false;
    }
    history.replaceState(null, '', location.pathname + location.search + '#menu');
  }
  showScreen('menu');
  buildMenu();
}

function showScreen(name) {
  screen = name;
  for (const s of document.querySelectorAll('.screen')) {
    s.classList.toggle('on', s.id === (name === 'menu' ? 'menu' : name === 'board' ? 'board-screen' : 'win'));
  }
  document.body.dataset.screen = name;
}

// ---------- levels ----------

function startLevel(next) {
  row = next;
  game = createGame(row);
  game.subscribe(onEvent);
  // A plain level cannot flip one pancake, so the keyboard never starts on an illegal depth.
  focusDepth = row.mode === 'burnt' ? 0 : 1;
  $('#hint-line').textContent = '';
  $('#explain').textContent = explainText(row);
  logMoves();
  // The screen has to be visible before the canvas is measured: a display:none box reports width 0,
  // and the view would then lay the stack out against its 240 px floor.
  showScreen('board');
  view.show(game.position);
  view.preview(focusDepth);
  updateHud();
  document.title = `${row.tierName} ${row.id} · 烙饼 PANCAKE`;
  const board = $('#board-screen');
  board.dataset.id = row.id;
  board.dataset.n = String(row.n);
  board.dataset.mode = row.mode;
  board.dataset.par = String(row.par);
  board.dataset.seed = row.seed === undefined ? '' : String(row.seed);
}

function record() {
  return progress.levels[row.id] || null;
}

function updateHud() {
  $('#level-name').textContent = `${row.tierName} · ${row.id}`;
  $('#hud-par').textContent = String(row.par);
  $('#hud-moves').textContent = String(game.count);
  const over = game.over;
  const cell = $('#hud-over');
  // par is a lower bound, so "under par" is not a thing a player can be: before you have spent par
  // moves the honest reading is 0 over, not a negative number that looks like a record.
  cell.textContent = over > 0 ? `+${over}` : '0';
  cell.className = 'hud-v ' + (over > 0 ? 'bad' : over === 0 && game.count > 0 ? 'good' : '');
  const rec = record();
  $('#hud-best').textContent = rec && rec.best !== null && rec.best !== undefined ? String(rec.best) : '—';
  $('#btn-undo').disabled = game.count === 0;
  $('#btn-hint').disabled = game.solved;
  $('#seed-shown').textContent = row.seed === undefined ? `${row.id}（关卡表）` : `${row.id} seed=${row.seed}`;
}

function logMoves() {
  const ul = $('#move-log');
  ul.textContent = '';
  const tape = game.moves;
  if (!tape.length) {
    ul.appendChild(el('li', '', '还没有一步。'));
    return;
  }
  tape.forEach((k, i) => {
    const li = el('li', '', `第 ${i + 1} 步 · 铲起 ${k} 张`);
    // Marking a move optimal would be a per-step oracle: the player could always step down. The
    // promise here is that par is a true lower bound, so the tally stays a tally.
    li.dataset.k = String(k);
    ul.appendChild(li);
  });
}

function explainText(r) {
  const mode =
    r.mode === 'burnt'
      ? '这一摞有焦边：每张饼烙焦的那一面画在边上，最后必须全部朝下。翻动会把焦面一并翻过去。'
      : '普通烙饼：两面都一样，只看大小顺序。';
  return `${mode} 把铲子插到某张饼下面，那张饼和它上面的一切整段倒过来；左边的数字就是这一铲翻几张。
    本关 par = ${r.par} 是把 ${r.n} 层的全部 ${fmt(diamOf(r))} 个局面做完广度优先量出来的下界，
    起手只有 ${r.starts} 种翻法不绕路，最坏的第一铲要多花 ${r.detour} 步。
    你每走一步之后还剩几步，界面故意不显示 —— 显示了就不是谜题，是连线。`;
}

function diamOf(r) {
  const d = MEASURED_DIAMETER[`${r.n}|${r.mode}`];
  return d ? d.states : field(r.n, r.mode === 'burnt').size;
}

function fmt(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// ---------- play ----------

function onFlip(k) {
  if (!game) return;
  audio.unlock();
  if (k < 0) {
    reject('not-a-number');
    return;
  }
  focusDepth = Math.max(0, Math.min(game.n - 1, k - 1));
  const r = game.flip(k);
  if (!r.ok) {
    reject(r.reason, k);
    return;
  }
  logMoves();
  updateHud();
  audio.flip(k, game.n);
  view.flipTo(game.position, k, () => {
    if (game.solved) onWin();
  });
}

function reject(reason, k) {
  audio.reject();
  const msg = REASONS[reason] || '这一铲不行';
  toast(msg);
  const board = $('#board');
  board.classList.remove('shake');
  // Without a reflow between remove and add the browser coalesces the two class writes and the
  // animation restart never happens — the shake becomes a no-op on the second rejection.
  void board.offsetWidth;
  board.classList.add('shake');
  clearTimeout(board._shake);
  board._shake = setTimeout(() => board.classList.remove('shake'), 380);
  view.reject(typeof k === 'number' ? Math.max(0, k - 1) : undefined);
  const li = $('#move-log').lastElementChild;
  if (li) li.title = `${li.textContent}（${msg}）`;
}

function onEvent(ev) {
  if (ev.type === 'hint') {
    $('#hint-line').textContent = `提示：铲起 ${ev.k} 张 —— 这是从当前局面出发的最优首步，后面还要 ${ev.remaining} 步。本关已记为“带提示”。`;
    audio.hint();
    store.record(progress, row.id, { hinted: true });
    store.save(progress);
    updateHud();
    return;
  }
  if (ev.type === 'undo' || ev.type === 'restart') {
    $('#hint-line').textContent = '';
    // Restart hands back the start position, so the keyboard cursor goes back to the shallowest
    // legal depth too — leaving it where the last tap was makes the Enter key flip a different
    // pancake than the one the player was looking at before the reset.
    if (ev.type === 'restart') focusDepth = game.burnt ? 0 : 1;
    logMoves();
    updateHud();
    view.show(game.position);
    view.preview(focusDepth);
  }
}

function onWin() {
  const g = grade(game.count, row.par, game.hints);
  const prev = record();
  // A run that was shown the optimal first move is not a clear: the ladder says par is a true
  // minimum, and claiming the level as beaten after being handed that minimum would make stars
  // meaningless. Once cleared without help, though, using a hint later does not un-clear it.
  const cleared = !g.hinted || !!(prev && prev.solved);
  const rec = store.record(progress, row.id, {
    id: row.id,
    best: game.count,
    stars: g.stars,
    hinted: g.hinted,
    solved: cleared,
    n: row.n,
    mode: row.mode,
    par: row.par,
  });
  const ok = store.save(progress);
  audio.solve(g.over);
  const dl = $('#win-stats');
  dl.textContent = '';
  stat(dl, '关卡', `${row.tierName} · ${row.id}`);
  stat(dl, '步数 / par', `${game.count} / ${row.par}`);
  stat(dl, '偏离下界', g.over === 0 ? '0（正好是量出来的下界）' : `+${g.over}`);
  stat(dl, '评级', '★'.repeat(g.stars) + '☆'.repeat(3 - g.stars), 'stars');
  stat(dl, '提示', game.hints ? `用了 ${game.hints} 次` : '没用');
  stat(dl, '最佳', String(rec.best));
  $('#win-note').textContent = !ok
    ? '进度没能写进本机存储（隐私模式或配额已满），这一局的星级只在这个标签页里有效。'
    : g.hinted
      ? '这一关记为“带提示”，不算通关：提示交出的是最优首步本身，重来也洗不掉这个标记。'
      : g.over === 0
        ? '一步没多：你走的这条路长度就等于广度优先量出的下界。'
        : `多花了 ${g.over} 步。下界是 ${row.par}，不是“大概需要”。`;
  showScreen('win');
}

function stat(dl, label, value, cls) {
  const box = el('div');
  box.appendChild(el('dt', '', label));
  box.appendChild(el('dd', cls || '', value));
  dl.appendChild(box);
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 1900);
}

// ---------- menu ----------

function buildMenu() {
  const list = $('#tier-list');
  list.textContent = '';
  TIERS.forEach((tier, ti) => {
    const rows = LOTS.filter((r) => r.tier === tier.id);
    const box = el('section', 'tier');
    box.dataset.tier = tier.id;
    const head = el('div', 'tier-head');
    head.appendChild(el('span', 'idx', `${ti + 1}/${TIERS.length}`));
    head.appendChild(el('h3', '', tier.name));
    head.appendChild(el('span', 'tier-note', `共 ${rows.length} 关 · par ${Math.min(...rows.map((r) => r.par))}–${Math.max(...rows.map((r) => r.par))}`));
    box.appendChild(head);
    box.appendChild(el('p', 'tier-note', tier.note));
    const cards = el('div', 'cards');
    for (const r of rows) {
      const rec = progress.levels[r.id];
      const b = el('button', 'card' + (rec && rec.solved ? ' done' : ''));
      b.type = 'button';
      b.dataset.id = r.id;
      if (row && row.id === r.id) b.dataset.current = '1';
      b.appendChild(el('span', 'cid', r.id));
      const meta = el('span', 'cmeta');
      meta.appendChild(el('b', '', `par ${r.par}`));
      meta.appendChild(document.createTextNode(` · ${r.n} 层${r.mode === 'burnt' ? ' 焦边' : ''} · 起手 ${r.starts}`));
      b.appendChild(meta);
      if (rec && rec.best !== null && rec.best !== undefined) {
        b.appendChild(el('span', 'cid', `最佳 ${rec.best}${rec.hinted ? ' · 带提示' : ''}`));
      }
      b.addEventListener('click', () => navigate(r.id));
      cards.appendChild(b);
    }
    box.appendChild(cards);
    list.appendChild(box);
  });

  const rb = $('#random-buttons');
  rb.textContent = '';
  for (const tier of TIERS) {
    const b = el('button', '', tier.name);
    b.type = 'button';
    b.dataset.random = tier.id;
    b.addEventListener('click', () => {
      const seed = nextSeed(tier.id);
      navigate(`pk-${tier.id}-r${seed.toString(36)}`);
    });
    rb.appendChild(b);
  }
  $('#seed-shown').textContent = '随机一局：种子进地址栏，可以原样复现';
  $('#claim').textContent = `零依赖 · 纯 ES module · ${LOTS.length} 关的 par 全部由全图广度优先量出 · 最大 ${maxPlainN()} 层 ${fmt(MEASURED_DIAMETER[`${maxPlainN()}|plain`].states)} 局面，直径 ${MEASURED_DIAMETER[`${maxPlainN()}|plain`].diameter} 步`;
}

// A per-tier counter, not the clock: "换一局" has to keep handing out different levels, while the
// seed it used stays readable in the address bar. A date seed would silently give every player the
// same board all day and still print a seed as if it were random.
function nextSeed(tierId) {
  let used = {};
  try {
    used = JSON.parse(storage.getItem(SEED_KEY) || '{}') || {};
  } catch {
    used = {};
  }
  const ti = TIERS.findIndex((t) => t.id === tierId);
  const n = (typeof used[tierId] === 'number' ? used[tierId] : 0) + 1;
  used[tierId] = n;
  try {
    storage.setItem(SEED_KEY, JSON.stringify(used));
  } catch {
    /* the seed is in the URL regardless, so the run stays reproducible */
  }
  return SEED_BASE + (ti + 1) * 100003 + n;
}

function maxPlainN() {
  return Math.max(...LOTS.filter((r) => r.mode === 'plain').map((r) => r.n));
}

// ---------- controls ----------

$('#btn-menu').addEventListener('click', () => navigate('menu'));
$('#btn-menu-2').addEventListener('click', () => navigate('menu'));
$('#btn-undo').addEventListener('click', () => game && game.undo());
$('#btn-restart').addEventListener('click', () => {
  if (!game) return;
  game.restart();
  $('#hint-line').textContent = '';
});
$('#btn-hint').addEventListener('click', () => {
  if (!game) return;
  if (game.hint() === null) toast('这一摞已经是最优了');
});
$('#btn-replay').addEventListener('click', () => startLevel(row));
const onNext = () => {
  const i = LOTS.findIndex((r) => row && r.id === row.id);
  if (i < 0 || i + 1 >= LOTS.length) {
    navigate('menu');
    return;
  }
  navigate(LOTS[i + 1].id);
};
$('#btn-next').addEventListener('click', onNext);
$('#btn-after-win').addEventListener('click', onNext);
$('#btn-sound').addEventListener('click', (ev) => {
  const on = audio.setEnabled(!audio.enabled);
  ev.currentTarget.setAttribute('aria-pressed', on ? 'true' : 'false');
  if (on) audio.unlock();
});
$('#btn-theme').addEventListener('click', () => {
  theme.cycle();
  $('#btn-theme').dataset.scheme = theme.scheme;
});

window.addEventListener('hashchange', apply);
window.addEventListener('resize', () => {
  if (screen !== 'board' || !game) return;
  view.resize();
  view.preview(focusDepth);
});

document.addEventListener('keydown', (ev) => {
  if (screen !== 'board' || !game) return;
  const tag = (ev.target && ev.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  const k = ev.key;
  if (k === 'ArrowUp' || k === 'ArrowDown') {
    ev.preventDefault();
    const lo = game.burnt ? 0 : 1;
    focusDepth = Math.max(lo, Math.min(game.n - 1, focusDepth + (k === 'ArrowUp' ? -1 : 1)));
    view.preview(focusDepth);
    return;
  }
  if (k === 'Enter' || k === ' ') {
    // Only when the canvas itself has focus: a focused button owns Enter/Space, and taking them
    // here would fire a flip *and* the button.
    if (ev.target === $('#board')) {
      ev.preventDefault();
      onFlip(focusDepth + 1);
    }
    return;
  }
  const low = k.toLowerCase();
  if (low === 'u') game.undo();
  else if (low === 'r') game.restart();
  else if (low === 'h') {
    if (game.hint() === null) toast('这一摞已经是最优了');
  } else if (/^[1-9]$/.test(k)) {
    const want = Number(k);
    if (want <= game.n) {
      focusDepth = want - 1;
      onFlip(want);
    }
  }
});

// ---------- boot ----------

buildMenu();
apply();
$('#btn-theme').dataset.scheme = theme.scheme;
$('#btn-sound').setAttribute('aria-pressed', audio.enabled ? 'true' : 'false');

const api = {
  version: VERSION,
  // Witness for the save/resume gate: a hash-only navigation does not create a new document, so a
  // leg that claims to have reloaded has to show a different timeOrigin.
  bootAt: performance.timeOrigin,
  engine: { LOTS, MEASURED_DIAMETER, TIERS, field, checkRows, sampleLevel, grade, SEED_BASE, storage },
  view,
  theme,
  audio,
  get game() {
    return game;
  },
  get state() {
    const pos = game ? game.position : null;
    return {
      screen,
      id: row ? row.id : null,
      tier: row ? row.tier : null,
      n: row ? row.n : 0,
      mode: row ? row.mode : null,
      par: row ? row.par : 0,
      starts: row ? row.starts : 0,
      detour: row ? row.detour : 0,
      seed: row && row.seed !== undefined ? row.seed : null,
      count: game ? game.count : 0,
      over: game ? game.over : 0,
      solved: game ? game.solved : false,
      hints: game ? game.hints : 0,
      moves: game ? game.moves : [],
      stack: pos ? pos.sizes : [],
      sides: pos ? pos.sides : [],
      focusDepth,
      theme: theme.scheme,
      effectiveTheme: theme.effective,
      motion: view.reduced,
      sound: audio.enabled,
      records: Object.keys(progress.levels).length,
      salvaged: progress.salvaged || 0,
      problems: store.problems,
    };
  },
  go: navigate,
  tap: (k) => onFlip(k),
  flip: (k) => (game ? game.flip(k) : null),
  undo: () => game && game.undo(),
  restart: () => game && game.restart(),
  hint: () => game && game.hint(),
  optimal: () => (game ? game.optimalPath() : null),
  // Drives the *input* path, not the model: each step goes through onFlip, so a green win scenario
  // has exercised the animation callback, the HUD and the progress write, not just game.flip.
  // With ?motion=off the flip lands synchronously, which is what the gate relies on.
  solveAll: () => {
    if (!game) return null;
    game.restart();
    const path = game.optimalPath() || [];
    for (const k of path) onFlip(k);
    return { count: game.count, solved: game.solved, steps: path.length };
  },
  rows: () => LOTS.slice(),
  buildRows: () => LOTS.slice(),
  verifyTable: (rows, opts) => checkRows(rows || LOTS, opts || {}),
  progress: () => JSON.parse(JSON.stringify(progress.levels)),
  setTheme: (s) => theme.set(s),
  setSound: (v) => audio.setEnabled(v),
  begin: (id) => navigate(id),
};

window.pancake = api;

// ---- 全屏开关（#btn-fullscreen）----
// 绑的是本页 HUD 上真实存在的那个按钮。全屏最常见的假实现就是引用一个并不存在的
// id：点下去什么也不会发生，量具却算它"已实现"。所以这里找不到按钮就直接不装。
(function bindFullscreen() {
  const btn = document.getElementById('btn-fullscreen');
  if (!btn) return;
  const root = document.documentElement;
  // 只做特性检测，不嗅探 UA：iOS Safari 是 webkitRequestFullscreen，老 Edge 是 ms 前缀，
  // 而 UA 字符串随时会改。"有没有这个能力"是查出来的，不是猜出来的。
  const req = root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  const current = () => document.fullscreenElement || document.webkitFullscreenElement
    || document.msFullscreenElement || null;

  // 不支持也要给个说法：只把按钮灰掉而不解释，玩家会以为这功能没做完。
  // supported 这枚标记不能省：下面 sync() 每次都会重写 title，不挡住的话，装的时候刚写
  // 进去的人话原因会被随后的 sync() 立刻抹成"全屏 (F)"——禁用就变成一句没有理由的禁用。
  let supported = !!req;
  const unsupported = () => {
    supported = false;
    btn.disabled = true;
    btn.title = '这个浏览器不提供元素全屏（iOS Safari 请用「添加到主屏幕」独立打开）';
  };
  if (!req) unsupported();

  // fullscreen 返回 Promise，被拒时必须吃掉：iOS Safari 对多数非 video 元素直接拒绝，
  // 让这个 rejection 冒泡出去会变成一条未捕获错误，整局游戏跟着挂。
  const settle = (p) => { if (p && p.catch) p.catch(unsupported); };

  // 进出都能走：已经全屏时这次调用是退出，不是"再进一次"。
  function toggle() {
    try {
      if (current()) {
        if (exit) settle(exit.call(document));
      } else if (req) {
        settle(req.call(root));
      } else {
        unsupported();
      }
    } catch (e) {
      unsupported();
    }
  }

  // Esc 和系统手势退出都不经过我们的代码，按钮状态只能靠 fullscreenchange 回写，
  // 否则用户已经退出、HUD 还停在"退出全屏"，下一次点击反而会重新进全屏。
  function sync() {
    const on = !!current();
    btn.setAttribute('aria-pressed', String(on));
    // 图标按钮不换字形（换字形会把 HUD 的视觉语言换掉），改成把可读名与提示写回无障碍属性。
    const say = on ? "退出全屏" : "全屏";
    btn.setAttribute('aria-label', say);
    if (supported) btn.title = say + '（F）';
    const body = document.body;
    if (body && body.classList) body.classList.toggle('fullscreen', on);
  }

  btn.addEventListener('click', toggle);
  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'f' && ev.key !== 'F') return;
    const t = ev.target;
    // 盘号 / 种子这类输入框里打字不能触发全屏，否则玩家输 seed 输到一半屏幕没了。
    if (t && /input|textarea|select/i.test(t.tagName || '')) return;
    if (ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    ev.preventDefault();
    toggle();
  });
  window.addEventListener('fullscreenchange', sync);
  window.addEventListener('webkitfullscreenchange', sync);
  window.addEventListener('MSFullscreenChange', sync);
  sync();
})();

// ---- 暂停：真的把仿真冻住 ----
//
// 本仓没有计时器，唯一持续推进的仿真是 view.js 里那次翻牌缓动（anim.t 靠 performance.now()
// 的时间戳差推进）。所以暂停直接交给 view.setPaused()：它停掉 rAF 心跳把 anim.t 冻在暂停那一刻，
// 恢复时把 anim.start 后移暂停时长，剩余时长原样接着走 —— 既不丢进度，也没有恢复尖峰。
// 用 var 不用 let：本段在文件末尾，view 早已建好，但 let 的 TDZ 在被别处提前调用时会直接抛。
var paused = false;
function setPaused(v) {
  v = !!v;
  if (v === paused) return paused;
  paused = view.setPaused(v);
  // topbar-actions 一排都是 38×34 的 .icon 按钮，所以这里也用图标约定：
  // 字形 ⏸/▶ 切换，aria-label 与 title 始终写明"按下去会发生什么"，aria-pressed 给出当前开关态。
  var b = document.getElementById('btn-pause');
  if (b) {
    b.setAttribute('aria-pressed', String(paused));
    b.textContent = paused ? '▶' : '⏸';
    b.setAttribute('aria-label', paused ? '继续' : '暂停');
    b.title = paused ? '继续 (P)' : '暂停 (P)';
  }
  return paused;
}
function togglePause() { return setPaused(!paused); }
function isPaused() { return paused; }

document.getElementById('btn-pause').addEventListener('click', togglePause);
window.addEventListener('keydown', function (ev) {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.target && /input|textarea|select/i.test(ev.target.tagName)) return;
  if (ev.key === 'p' || ev.key === 'P') { ev.preventDefault(); togglePause(); }
});

// 给真浏览器闸 / 量尺读的台面（简报 §3 要求把窗口状态挂出来，否则判据无法复验）。
window.pancake = {
  view,
  setPaused, togglePause, isPaused,
  animProgress: () => view.animProgress(),
  state: () => ({ screen, paused, hasGame: !!game, n: game && game.n, moves: game && game.moves }),
  startLevel: (i) => startLevel(i),
};
