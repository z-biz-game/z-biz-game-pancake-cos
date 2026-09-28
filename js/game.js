// One run of one level: the move list, the undo tape, the hint budget, and nothing about pixels.
//
// The engine side of this repo is provable; this file is the part that can still lie, so it keeps
// its own bookkeeping auditable: `moves` is the exact list the player entered, `position` is
// recomputed from the *start* position plus that list rather than mutated in place, and the
// solved flag is only set after `solved()` has looked at the recomputed stack. A view that paints
// a win the model has not reached is a defect the browser gate checks for, not one it hopes for.

import { start, clone, flipAt, solved } from './engine/rules.js';
import { field } from './engine/graph.js';
import { stackOf } from './engine/make.js';

export function createGame(level) {
  const burnt = level.mode === 'burnt';
  const begin = start(level.code, level.n, burnt);
  const f = field(level.n, burnt);
  const tape = [];
  let pos = begin;
  let hints = 0;
  const subs = new Set();

  const emit = (ev) => {
    for (const fn of subs) fn(ev);
  };

  const api = {
    level,
    get par() {
      return level.par;
    },
    get n() {
      return level.n;
    },
    get burnt() {
      return burnt;
    },
    get position() {
      return pos;
    },
    get stack() {
      return pos.sizes;
    },
    get sides() {
      return pos.sides;
    },
    get moves() {
      return tape.slice();
    },
    get count() {
      return tape.length;
    },
    get hints() {
      return hints;
    },
    get over() {
      return tape.length - level.par;
    },
    get solved() {
      return solved(pos);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    // A rejected tap returns false and *why*; the caller is expected to make noise about it.
    flip(k) {
      if (api.solved) return { ok: false, reason: 'already-solved', k };
      const r = flipAt(pos, k);
      if (!r.ok) return r;
      tape.push(k);
      pos = r.pos;
      const done = solved(pos);
      emit({ type: done ? 'solved' : 'flip', k, count: tape.length, over: tape.length - level.par });
      return { ok: true, k, solved: done };
    },
    undo() {
      if (!tape.length) return false;
      tape.pop();
      pos = replay(begin, tape);
      emit({ type: 'undo', count: tape.length });
      return true;
    },
    // The tape is cleared; the hint counter is not. Laundering "I was shown the answer" by
    // pressing restart would make the hinted flag meaningless.
    restart() {
      tape.length = 0;
      pos = clone(begin);
      emit({ type: 'restart' });
    },
    // The hint is the first move of a shortest path out of the current stack, read off the same
    // exhaustive table that produced the level's par. That means it is an answer, not a nudge, and
    // the UI has to present it that way: `hints > 0` marks the run forever (see grade()).
    hint() {
      const { order, bits } = stackOf(pos.code, pos.n, burnt);
      const path = f.solve(order, bits);
      if (!path || !path.length) return null;
      hints++;
      emit({ type: 'hint', k: path[0], remaining: path.length });
      return { k: path[0], remaining: path.length, parFromHere: path.length };
    },
    // The whole optimal continuation, for the replay/verification path in the tests and the
    // "看一遍最优解" screen. Same table, same promise.
    optimalPath() {
      const { order, bits } = stackOf(pos.code, pos.n, burnt);
      return f.solve(order, bits);
    },
  };
  return api;
}

// Recomputing from the start position instead of trusting an incremental mutation is the whole
// point: it makes `undo` exact by construction, and it means a wrong `flipAt` cannot desynchronise
// the model from the move list.
function replay(begin, tape) {
  let pos = clone(begin);
  for (const k of tape) {
    const r = flipAt(pos, k);
    if (!r.ok) throw new Error(`tape contains an illegal flip ${k}: ${r.reason}`);
    pos = r.pos;
  }
  return pos;
}
