// The exact distance field: one breadth-first pass over the whole move graph of a given (n, mode),
// from the solved stack outward. This is the reason the repo is allowed to print the word "par".
//
// The graph is small enough to be solved *completely* — 9! = 362 880 stacks plain, 2^7·7! = 645 120
// burnt — so a level's par is not a heuristic, not an upper bound, not "the number of moves some
// solver happened to find". It is the true minimum, read out of a table that was built by visiting
// every reachable position. `diameter` is likewise measured, and the node suite asserts it against
// the published pancake numbers.
//
// Flip is its own inverse, so the walk explores a neighbour and restores the parent in place: no
// array is allocated per state, which is what keeps a full 9! pass sub-second.

import { sizeOf, encode, decode, flip, isGoal, legal, minFlip } from './perms.js';

// Beyond this the browser would need tens of megabytes for one table (burnt n=8 is 10.3M states),
// so a level that asks for it is a design error, not a slow start.
export const MAX_STATES = 1 << 21;

export class DistanceField {
  constructor(n, burnt = false) {
    this.n = n;
    this.burnt = burnt;
    this.size = sizeOf(n, burnt);
    if (this.size > MAX_STATES) {
      throw new RangeError(`(${n}, ${burnt ? 'burnt' : 'plain'}) has ${this.size} positions, over the ${MAX_STATES} cap`);
    }
    this.dist = new Int16Array(this.size).fill(-1);
    this.reached = 0;
    this.diameter = 0;
    this.build();
  }

  build() {
    const { n, burnt, size, dist } = this;
    const order = new Uint8Array(n);
    const avail = new Uint8Array(n);
    const queue = new Int32Array(size);
    // The solved stack is sizes 0..n-1 top to bottom with every burnt side down, which encodes to
    // code 0 (Lehmer 0, bits 0). Asserted rather than assumed, because an off-by-one here would
    // quietly make every par wrong.
    for (let i = 0; i < n; i++) order[i] = i;
    if (encode(order, 0, n, burnt) !== 0) throw new Error('the solved stack must encode to 0');
    let head = 0;
    let tail = 0;
    dist[0] = 0;
    queue[tail++] = 0;
    this.reached = 1;
    while (head < tail) {
      const code = queue[head++];
      const d = dist[code];
      const bits = decode(code, n, burnt, order, avail);
      for (let k = minFlip(burnt); k <= n; k++) {
        const nb = flip(order, bits, k, burnt);
        const nc = encode(order, nb, n, burnt);
        if (dist[nc] === -1) {
          dist[nc] = d + 1;
          if (d + 1 > this.diameter) this.diameter = d + 1;
          this.reached++;
          queue[tail++] = nc;
        }
        flip(order, nb, k, burnt);
      }
    }
    this.queue = null;
  }

  // Every position must be reachable: any stack can be sorted. If this ever fails the game has
  // dead positions in it, and "no dead ends" would be a lie in the README.
  get complete() {
    return this.reached === this.size;
  }

  distAt(code) {
    return this.dist[code];
  }

  distOf(order, bits) {
    return this.dist[encode(order, bits, this.n, this.burnt)];
  }

  // The flips that shorten the stack: neighbours one closer to solved. Their count is the level's
  // `optimalStarts` — the honest difficulty signal, since a stack with exactly one of them has
  // n-2 wrong-looking-but-forced-looking first moves and no way for a player to check.
  optimalMoves(order, bits) {
    const { n, burnt, dist } = this;
    const d = dist[encode(order, bits, n, burnt)];
    const out = [];
    const scratch = new Uint8Array(n);
    scratch.set(order);
    for (let k = minFlip(burnt); k <= n; k++) {
      const nb = flip(scratch, bits, k, burnt);
      if (dist[encode(scratch, nb, n, burnt)] === d - 1) out.push(k);
      flip(scratch, nb, k, burnt);
    }
    return out;
  }

  moves() {
    const out = [];
    for (let k = minFlip(this.burnt); k <= this.n; k++) if (legal(k, this.n, this.burnt)) out.push(k);
    return out;
  }

  // Shortest path out of a position, as the move list the player would have to enter. `pick`
  // chooses among equally-optimal first moves so the hint can vary; the length never does, and
  // that length equality is exactly what the test suite asserts.
  solve(order, bits, pick = 0) {
    const { n, burnt } = this;
    const cur = new Uint8Array(n);
    cur.set(order);
    let b = bits;
    const path = [];
    for (let guard = 0; guard <= this.diameter + 2; guard++) {
      if (isGoal(cur, b, n, burnt)) return path;
      const opts = this.optimalMoves(cur, b);
      if (!opts.length) return null;
      const k = opts[Math.min(opts.length - 1, Math.abs(pick) % opts.length)];
      b = flip(cur, b, k, burnt);
      path.push(k);
    }
    return null;
  }

  // The path as the sequence of stacks it walks through, for the viewer's replay and the tests.
  states(order, bits) {
    const seq = [{ order: Array.from(order), bits }];
    const cur = new Uint8Array(this.n);
    cur.set(order);
    let b = bits;
    for (const k of this.solve(order, bits) || []) {
      b = flip(cur, b, k, this.burnt);
      seq.push({ order: Array.from(cur), bits: b });
    }
    return seq;
  }
}

const cache = new Map();

export function field(n, burnt = false) {
  const key = `${n}|${burnt ? 'b' : 'p'}`;
  let f = cache.get(key);
  if (!f) {
    f = new DistanceField(n, burnt);
    cache.set(key, f);
  }
  return f;
}

export function clearFields() {
  cache.clear();
}
