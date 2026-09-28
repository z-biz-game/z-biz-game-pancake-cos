// One run of one level. The model recomputes its stack from the start position plus the tape, so
// this suite is mostly about whether that promise holds under undo, restart, hint, and a player who
// keeps flipping after winning.

import { suite } from '../tools/harness.mjs';
import { createGame } from '../js/game.js';
import { grade, flipAt } from '../js/engine/rules.js';
import { field } from '../js/engine/graph.js';
import { flip, encode, decode } from '../js/engine/perms.js';
import { LOTS } from '../js/data/lots.js';

const t = suite('game');
const warm = LOTS.find((r) => r.id === 'pk-warm-2');
const hard = LOTS.find((r) => r.tier === 'exp');
const burnt = LOTS.find((r) => r.mode === 'burnt' && r.n === 6);

t.where('a fresh level');
{
  const g = createGame(warm);
  t.eq('no moves yet', g.count, 0);
  t.eq('over is minus par before anything happens', g.over, -warm.par);
  t.eq('the stack is the baked one', g.stack.join(','), warm.stack.join(','));
  t.eq('par comes from the row, not a re-solve', g.par, warm.par);
  t.ok('it is not solved', !g.solved);
  t.eq('hints start at zero', g.hints, 0);
  // The getter must hand out a copy: a caller that pushes onto `moves` would otherwise rewrite
  // the player's tape.
  g.moves.push(99);
  t.eq('mutating the returned move list does not touch the tape', g.count, 0);
}

t.where('playing the optimum solves in exactly par');
for (const level of [warm, hard, burnt]) {
  const g = createGame(level);
  const path = g.optimalPath();
  t.eq(`${level.id}: an optimum exists`, !!path, true);
  t.eq(`${level.id}: and it is par moves long`, path.length, level.par);
  let ok = true;
  for (const k of path.slice(0, -1)) if (!g.flip(k).ok) ok = false;
  t.ok(`${level.id}: every but the last move accepted`, ok);
  t.eq(`${level.id}: not solved one move early`, g.solved, false);
  t.eq(`${level.id}: count is one short of par`, g.count, level.par - 1);
  const last = g.flip(path[path.length - 1]);
  t.ok(`${level.id}: the last move wins`, last.ok && g.solved);
  t.eq(`${level.id}: over is 0`, g.over, 0);
  t.eq(`${level.id}: graded three stars`, grade(g.count, g.par, g.hints).stars, 3);
}

t.where('par is a lower bound, not a suggestion');
// Two halves. First: a game flip lands on exactly a graph edge, so anything the graph forbids the
// player cannot do either. Second: for the small spaces, enumerate every reachable set of stacks at
// depth 1..par-1 and confirm none of them is the goal — a proof, not a sample.
{
  let offByMoreThanOne = 0;
  let landedOffTable = 0;
  for (const level of [warm, hard, burnt]) {
    const f = field(level.n, level.mode === 'burnt');
    const minK = level.mode === 'burnt' ? 1 : 2;
    const g0 = createGame(level);
    for (let k = minK; k <= level.n; k++) {
      const r = flipAt(g0.position, k);
      if (!r.ok) {
        offByMoreThanOne++;
        continue;
      }
      const d = f.dist[r.pos.code];
      if (Math.abs(d - level.par) > 1) offByMoreThanOne++;
      if (!Number.isInteger(d) || d < 0) landedOffTable++;
    }
  }
  t.eq('every legal tap moves exactly one ring in the table', offByMoreThanOne, 0);
  t.eq('and never lands outside it', landedOffTable, 0);
}
for (const level of [warm, LOTS.find((r) => r.n === 5 && r.mode === 'plain')]) {
  const f = field(level.n, level.mode === 'burnt');
  const minK = level.mode === 'burnt' ? 1 : 2;
  const moves = [];
  for (let k = minK; k <= level.n; k++) moves.push(k);
  const order = new Uint8Array(level.n);
  const avail = new Uint8Array(level.n);
  const step = (code, k) => {
    const b = decode(code, level.n, level.mode === 'burnt', order, avail);
    const nb = flip(order, b, k, level.mode === 'burnt');
    return encode(order, nb, level.n, level.mode === 'burnt');
  };
  let frontier = new Set([level.code]);
  let solvedEarly = 0;
  let sequences = 0;
  for (let depth = 1; depth < level.par; depth++) {
    const next = new Set();
    for (const c of frontier) {
      for (const k of moves) {
        sequences++;
        const p = step(c, k);
        if (f.dist[p] === 0) solvedEarly++;
        else next.add(p);
      }
    }
    frontier = next;
  }
  t.eq(`${level.id}: ${sequences} flips tried over depths 1..${level.par - 1}, none reaches the goal`, solvedEarly, 0);
}

t.where('undo and restart');
{
  const g = createGame(hard);
  const before = g.stack.join(',');
  const path = g.optimalPath();
  for (const k of path.slice(0, 3)) g.flip(k);
  t.eq('three moves in', g.count, 3);
  t.ok('the stack changed', g.stack.join(',') !== before);
  g.undo();
  t.eq('undo takes one back', g.count, 2);
  g.undo();
  g.undo();
  t.eq('and the stack is the starting stack again', g.stack.join(','), before);
  t.eq('nothing is solved by undoing', g.solved, false);
  t.ok('undo on an empty tape says no', !g.undo());
  for (const k of path) g.flip(k);
  t.ok('won', g.solved);
  g.restart();
  t.eq('restart clears the tape', g.count, 0);
  t.eq('restart restores the stack', g.stack.join(','), before);
  const hinted = createGame(warm);
  hinted.hint();
  hinted.restart();
  t.eq('restart clears the tape but not the hint marker', hinted.hints, 1);
}

t.where('flipping after the win');
{
  const g = createGame(warm);
  for (const k of g.optimalPath()) g.flip(k);
  const r = g.flip(2);
  t.ok('a tap after winning is refused, not applied', !r.ok);
  t.eq('with a reason', r.reason, 'already-solved');
  t.eq('the tape did not grow', g.count, warm.par);
}

t.where('hints are answers, and say so');
{
  const g = createGame(hard);
  const f = field(hard.n, false);
  const h = g.hint();
  t.ok('a hint names a move', h && Number.isInteger(h.k));
  t.eq('and the number of moves left is the distance from here', h.remaining, hard.par);
  t.eq('playing it really shortens the stack by one', (() => {
    g.flip(h.k);
    return f.dist[g.position.code];
  })(), hard.par - 1);
  t.eq('the hint counter moved', g.hints, 1);
  const events = [];
  const g2 = createGame(warm);
  g2.subscribe((ev) => events.push(ev.type));
  g2.hint();
  g2.flip(g2.optimalPath()[0]);
  t.eq('subscribers see the hint and the flip', events.join(','), 'hint,flip');
  // optimalPath() is from the *current* stack, so this finishes the level in one more flip.
  for (const k of g2.optimalPath()) g2.flip(k);
  t.eq('the last flip emits solved, not another flip', events.join(','), 'hint,flip,solved');
  t.eq('a hinted-but-optimal run still gets three stars', grade(g2.count, g2.par, g2.hints).stars, 3);
  t.eq('and is reported as hinted', grade(g2.count, g2.par, g2.hints).hinted, true);
  const done = createGame(warm);
  for (const k of done.optimalPath()) done.flip(k);
  t.eq('a solved level has no hint to give', done.hint(), null);
}

t.where('two games on one level agree');
{
  const a = createGame(burnt);
  const b = createGame(burnt);
  const path = a.optimalPath();
  for (const k of path) {
    a.flip(k);
    b.flip(k);
  }
  t.eq('same tape, same stack', a.stack.join(','), b.stack.join(','));
  t.eq('same tape, same code', a.position.code, b.position.code);
  t.eq('same tape, same sides', a.sides.join(','), b.sides.join(','));
  t.ok('both solved', a.solved && b.solved);
}

t.done();
