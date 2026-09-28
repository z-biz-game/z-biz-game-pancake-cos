// The claim this repo is built on: `par` is the true minimum number of flips.
//
// Two things could make that false while every other test still passes: the move generator could
// disagree with the game's rules, or the BFS could fail to visit part of the graph. So this file
// recomputes the distances with a *different implementation on a different representation* —
// signed-size arrays, string-keyed Maps, `slice().reverse().map(negate)` instead of in-place bit
// twiddling, and a queue that grows instead of an Int32Array cursor — and compares the two tables
// entry by entry over the whole state space.
//
// It then checks the graph-level facts: every position reachable, distances change by at most one
// along an edge, every non-goal position has a move that shortens it, the measured diameters are
// the published pancake numbers, and the census cells the difficulty ladder is built on exist (and
// the ones that do not are asserted not to).

import { suite } from '../tools/harness.mjs';
import { field, DistanceField, MAX_STATES } from '../js/engine/graph.js';
import { sizeOf, rng, flip, isGoal } from '../js/engine/perms.js';
import { stackOf, measure } from '../js/engine/make.js';
import { LOTS, MEASURED_DIAMETER } from '../js/data/lots.js';

const t = suite('graph');

// Independent reference: no ranks, no codes, no typed arrays. A state is a list of signed sizes,
// where the sign is the burnt side and the magnitude is the pancake. Flipping the top k reverses
// that prefix and negates each entry.
function reference(n, burnt) {
  const key = (st) => st.join(',');
  const goal = [];
  for (let i = 1; i <= n; i++) goal.push(i);
  const dist = new Map([[key(goal), 0]]);
  const queue = [goal];
  for (let head = 0; head < queue.length; head++) {
    const st = queue[head];
    const d = dist.get(key(st));
    for (let k = burnt ? 1 : 2; k <= n; k++) {
      const next = st.slice(0, k).reverse().map((v) => (burnt ? -v : v)).concat(st.slice(k));
      const kk = key(next);
      if (!dist.has(kk)) {
        dist.set(kk, d + 1);
        queue.push(next);
      }
    }
  }
  let diameter = 0;
  for (const v of dist.values()) if (v > diameter) diameter = v;
  return { dist, diameter };
}

const signed = (order, bits, burnt) =>
  Array.from(order, (v, i) => (burnt && (bits >> i) & 1 ? -(v + 1) : v + 1)).join(',');

t.where('engine BFS vs an independent implementation');
for (const [n, burnt] of [[4, false], [6, false], [7, false], [3, true], [4, true]]) {
  const f = field(n, burnt);
  const ref = reference(n, burnt);
  const label = `n=${n} ${burnt ? 'burnt' : 'plain'}`;
  t.eq(`${label}: same number of positions`, ref.dist.size, f.size);
  let mismatch = 0;
  let firstBad = '';
  for (let code = 0; code < f.size; code++) {
    const s = stackOf(code, n, burnt);
    const want = ref.dist.get(signed(s.order, s.bits, burnt));
    if (want === undefined || want !== f.dist[code]) {
      mismatch++;
      if (!firstBad) firstBad = `code ${code}: engine ${f.dist[code]} reference ${want}`;
      break;
    }
  }
  t.eq(`${label}: every one of ${f.size} distances agrees`, mismatch ? firstBad : 0, 0);
  t.eq(`${label}: diameters agree`, f.diameter, ref.diameter);
}

t.where('published pancake numbers (the external cross-check)');
// P_n / B_n: the diameter of the prefix-reversal graph, as published. A wrong move generator or a
// wrong rank would reproduce neither sequence. Burnt n=1 is left out rather than fudged: our legal
// moves include turning one pancake over, which makes it 1 instead of the 0 some tables print.
const PUBLISHED = {
  plain: [null, 0, 1, 3, 4, 5, 7, 8, 9, 10],
  burnt: [null, null, 4, 6, 8, 10, 12, 14],
};
for (let n = 1; n <= 9; n++) t.eq(`plain P_${n}`, field(n, false).diameter, PUBLISHED.plain[n]);
for (let n = 2; n <= 7; n++) t.eq(`burnt B_${n}`, field(n, true).diameter, PUBLISHED.burnt[n]);

t.where('what taking the k=1 move away would do to the burnt graph');
// perms.js states why k=1 is legal in burnt mode, and the sentence it gives is a measurement claim,
// so it is measured here rather than trusted: without k=1 the three-layer burnt graph splits, but
// from four layers up the remaining moves already reach every stack. That is why the comment says
// "a single pancake can be turned over" and not "this is what keeps the graph connected".
function reachWithoutK1(n) {
  const key = (st) => st.join(',');
  const goal = [];
  for (let i = 1; i <= n; i++) goal.push(i);
  const seen = new Set([key(goal)]);
  const queue = [goal];
  for (let head = 0; head < queue.length; head++) {
    const st = queue[head];
    for (let k = 2; k <= n; k++) {
      const next = st.slice(0, k).reverse().map((v) => -v).concat(st.slice(k));
      const kk = key(next);
      if (!seen.has(kk)) {
        seen.add(kk);
        queue.push(next);
      }
    }
  }
  return seen.size;
}
t.eq('burnt n=3 without k=1: 12 of the 48 stacks left in the piece', reachWithoutK1(3), 12);
t.eq('burnt n=4 without k=1: still every stack', reachWithoutK1(4), 384);
t.eq('burnt n=5 without k=1: still every stack', reachWithoutK1(5), 3840);

t.where('graph-level invariants over the whole space');
for (const [n, burnt] of [[6, false], [8, false], [5, true]]) {
  const f = field(n, burnt);
  const label = `n=${n} ${burnt ? 'burnt' : 'plain'}`;
  t.eq(`${label}: connected, so no stack is unsolvable`, f.reached, f.size);
  t.ok(`${label}: nothing left unvisited in the table`, Array.from(f.dist).every((d) => d >= 0));
  let parDisagree = 0;
  let noDescent = 0;
  let tooFar = 0;
  let edgeJump = 0;
  let detourWrong = 0;
  const cur = new Uint8Array(n);
  for (let code = 0; code < f.size; code++) {
    const m = measure(f, code);
    const d = f.dist[code];
    if (m.par !== d) parDisagree++;
    if (d > 0 && m.starts < 1) noDescent++;
    if (d === 0 && m.starts !== 0) noDescent++;
    // An edge moves the distance by at most one, and the neighbour set is re-numbered locally so
    // this loop is not using the code path whose table it audits. detour is then checked against
    // the max it claims to summarise, which pins the formula as well as the bound.
    const s = stackOf(code, n, burnt);
    cur.set(s.order);
    let maxNeighbour = -1;
    for (let k = burnt ? 1 : 2; k <= n; k++) {
      const nb = flip(cur, s.bits, k, burnt);
      const nd = f.dist[encodeLocal(cur, nb, n, burnt)];
      if (Math.abs(nd - d) > 1) edgeJump++;
      if (nd > maxNeighbour) maxNeighbour = nd;
      flip(cur, nb, k, burnt);
    }
    if (maxNeighbour > f.diameter) tooFar++;
    if (m.detour !== 1 + maxNeighbour - d) detourWrong++;
  }
  t.eq(`${label}: measure() reproduces the table for every code`, parDisagree, 0);
  t.eq(`${label}: every non-goal position has a shortening first move`, noDescent, 0);
  t.eq(`${label}: no move jumps more than one ring`, edgeJump, 0);
  t.eq(`${label}: no opening reaches past the farthest ring`, tooFar, 0);
  t.eq(`${label}: detour is exactly 1 + (worst neighbour) - par`, detourWrong, 0);
}

// lehmer() again on purpose: same maths, separate code, so a silent change to the ranking in
// js/engine/perms.js has to break two places at once to pass this file.
function encodeLocal(order, bits, n, burnt) {
  let r = 0;
  for (let i = 0; i < n; i++) {
    let d = 0;
    for (let j = i + 1; j < n; j++) if (order[j] < order[i]) d++;
    r = r * (n - i) + d;
  }
  return r * (burnt ? 1 << n : 1) + (burnt ? bits : 0);
}

t.where('the census cells the ladder is built on');
// tiers.js builds its rungs out of two census readings: `par` and `starts`. The shape it relies on
// is that at the sizes the steep rungs use (plain n>=6, burnt n>=3) no position *at* the diameter
// has a unique opening — the farthest ring is the least forced one in the graph. That is a fact
// about those sizes, not a theorem: plain n=5 puts 5 of its 20 diameter positions at starts 1, and
// the shipped table contains one of them. Both halves are asserted below, because the second half is
// what stops the comment from being stronger than the data.
function census(n, burnt) {
  const f = field(n, burnt);
  const by = new Map();
  for (let code = 0; code < f.size; code++) {
    const m = measure(f, code);
    by.set(`${m.par}/${m.starts}`, (by.get(`${m.par}/${m.starts}`) || 0) + 1);
  }
  return { by, diameter: f.diameter };
}
{
  const c5 = census(5, false);
  t.eq('plain n=5: 5 of the 20 farthest positions have a unique opening', c5.by.get('5/1'), 5);
  const c2 = census(2, false);
  t.eq('plain n=2: its one diameter position is uniquely openable', c2.by.get('1/1'), 1);
  const reg1 = LOTS.find((r) => r.id === 'pk-reg-1');
  t.eq('pk-reg-1 sits on the diameter this census just measured', reg1.par, c5.diameter);
  t.eq('pk-reg-1 is one of the five uniquely openable farthest stacks', reg1.starts, 1);

  const c6 = census(6, false);
  t.eq('plain n=6: the 2 antipodes are at par 7 with 5 optimal openings each', c6.by.get('7/5'), 2);
  t.eq('plain n=6: no antipode has a unique opening', c6.by.get(`${c6.diameter}/1`) || 0, 0);
  t.eq('plain n=6: the rung the ladder uses (par 6, starts 1) is populated', c6.by.get('6/1'), 33);

  const c7 = census(7, false);
  t.eq('plain n=7: no par-8 position has a unique opening', c7.by.get('8/1') || 0, 0);
  t.eq('plain n=7: par 7 with starts 1 has 281 candidates', c7.by.get('7/1'), 281);

  const c8 = census(8, false);
  t.eq('plain n=8: no par-9 position has a unique opening', c8.by.get('9/1') || 0, 0);
  t.eq('plain n=8: par 8 with starts 1 has 2395 candidates', c8.by.get('8/1'), 2395);

  const b6 = census(6, true);
  t.eq('burnt n=6: exactly one position sits at the diameter, and it has 6 openings', b6.by.get('12/6'), 1);
  t.eq('burnt n=6: par 12 with a unique opening does not exist', b6.by.get('12/1') || 0, 0);
  t.eq('burnt n=6: par 10 with starts 1 has 71 candidates', b6.by.get('10/1'), 71);

  const b4 = census(4, true);
  t.eq('burnt n=4: the far ring (par 8) holds 3 positions', (b4.by.get('8/2') || 0) + (b4.by.get('8/3') || 0), 3);
}

t.where('shortest paths out of real positions');
for (const [n, burnt] of [[7, false], [9, false], [6, true]]) {
  const f = field(n, burnt);
  const rand = rng(1000 + n);
  let badLength = 0;
  let badWalk = 0;
  let illegal = 0;
  for (let i = 0; i < 200; i++) {
    const code = Math.floor(rand() * f.size);
    const s = stackOf(code, n, burnt);
    const path = f.solve(s.order, s.bits);
    if (!path) {
      badLength++;
      continue;
    }
    if (path.length !== f.dist[code]) badLength++;
    const cur = new Uint8Array(n);
    cur.set(s.order);
    let b = s.bits;
    for (const k of path) {
      if (k < (burnt ? 1 : 2) || k > n || !Number.isInteger(k)) illegal++;
      b = flip(cur, b, k, burnt);
    }
    if (!isGoal(cur, b, n, burnt)) badWalk++;
  }
  const label = `n=${n} ${burnt ? 'burnt' : 'plain'}`;
  t.eq(`${label}: 200 sampled solves return exactly par moves`, badLength, 0);
  t.eq(`${label}: every move in them is legal`, illegal, 0);
  t.eq(`${label}: and they land on the goal`, badWalk, 0);
}

t.where('the table on disk');
const built = new Map();
for (const r of LOTS) {
  const key = `${r.n}|${r.mode === 'burnt'}`;
  if (!built.has(key)) built.set(key, field(r.n, r.mode === 'burnt'));
  const f = built.get(key);
  t.ok(`${r.id}: n=${r.n} ${r.mode} is inside the state table`, r.code >= 0 && r.code < f.size);
  t.eq(`${r.id}: par is what the graph says`, f.dist[r.code], r.par);
}
for (const [key, entry] of Object.entries(MEASURED_DIAMETER)) {
  const [n, mode] = key.split('|');
  const f = field(Number(n), mode === 'burnt');
  t.eq(`MEASURED_DIAMETER[${key}].diameter`, entry.diameter, f.diameter);
  t.eq(`MEASURED_DIAMETER[${key}].states`, entry.states, f.size);
}

t.where('the cache and the cap');
t.ok('field() memoises by (n, mode)', field(5, false) === field(5, false));
t.ok('a plain and a burnt table for the same n are different objects', field(5, false) !== field(5, true));
t.ok('MAX_STATES covers everything the ladder ships', MAX_STATES > sizeOf(9, false));
let refused = false;
try {
  new DistanceField(10, true);
} catch (e) {
  refused = /cap/.test(String(e && e.message)) || String(e && e.name) === 'RangeError';
}
t.ok('an oversized table is refused instead of attempted', refused);

t.done();
