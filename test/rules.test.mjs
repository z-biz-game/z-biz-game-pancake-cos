// What a tap means. The interesting failures here are the ones where the maths is right and the
// game is wrong: a flip that mutates its input, a rejection that arrives as `undefined`, a tap that
// is legal by the graph but nonsense on screen.

import { suite } from '../tools/harness.mjs';
import { start, clone, flipAt, solved, grade, canFlip, maxFlip } from '../js/engine/rules.js';
import { LOTS } from '../js/data/lots.js';

const t = suite('rules');

// pk-warm-2 is the baked row with stack [3,1,2]: three pancakes, biggest on top of the two small
// ones. Hand-checked against the printed table, not against the code that printed it.
const warm = LOTS.find((r) => r.id === 'pk-warm-2');
t.where('reading a level');
{
  const p = start(warm.code, warm.n, false);
  t.eq('sizes match the printed stack', p.sizes.join(','), warm.stack.join(','));
  t.eq('a plain level has no burnt sides to show', p.sides.join(','), '');
  t.eq('code round-trips', p.code, warm.code);
  const b = LOTS.find((r) => r.mode === 'burnt');
  const q = start(b.code, b.n, true);
  t.eq('a burnt level reports one side per pancake', q.sides.length, b.n);
  t.eq('and the printed sides are the decoded ones', q.sides.join(','), b.burnt.join(','));
}

t.where('flipAt accepts and rejects by name');
{
  const p = start(warm.code, warm.n, false);
  const r = flipAt(p, 2);
  t.ok('a legal flip returns the new position', r.ok && r.pos);
  t.eq('flipping the top two of [3,1,2] gives [1,3,2]', r.pos.sizes.join(','), '1,3,2');
  t.eq('the original did not move (flipAt is pure)', p.sizes.join(','), '3,1,2');
  t.eq('its code did not move either', p.code, warm.code);

  const shallow = flipAt(p, 1);
  t.ok('tapping the topmost plain pancake is refused, not ignored', !shallow.ok);
  t.eq('with a reason the UI can say out loud', shallow.reason, 'one-plain-pancake-does-not-move');
  t.eq('past the bottom is its own reason', flipAt(p, 9).reason, 'past-the-bottom');
  t.eq('a non-integer is its own reason', flipAt(p, 2.5).reason, 'not-a-number');
  t.eq('so is NaN', flipAt(p, NaN).reason, 'not-a-number');
  t.eq('and a numeric string, because the tap handler must convert', flipAt(p, '2').reason, 'not-a-number');
  t.ok('canFlip agrees', canFlip(p, 2) && !canFlip(p, 1));
  t.eq('the deepest insertion is under the bottom pancake', maxFlip(warm.n), warm.n);
}

t.where('the burnt 1-flip');
{
  const b = LOTS.find((r) => r.mode === 'burnt');
  const p = start(b.code, b.n, true);
  const r = flipAt(p, 1);
  t.ok('turning the top pancake over is a move when there is a burnt side', r.ok);
  t.eq('it changes only that one side', r.pos.sides.map((v, i) => (i === 0 ? 1 - v : v)).join(','), p.sides.join(','));
  t.eq('and leaves the order alone', r.pos.sizes.join(','), p.sizes.join(','));
  t.eq('twice is a no-op', flipAt(r.pos, 1).pos.sides.join(','), p.sides.join(','));
}

t.where('solved');
{
  const p = start(warm.code, warm.n, false);
  t.ok('a shipped level does not start solved', !solved(p));
  const sorted = start(0, warm.n, false);
  t.ok('the identity stack is solved', solved(sorted));
  const b = LOTS.find((r) => r.mode === 'burnt');
  const burntButSorted = start(0, b.n, true);
  t.ok('sorted with every burnt side down is solved', solved(burntButSorted));
  // code 1 at n=b.n is "top pancake turned over": right order, wrong side
  const turned = clone(burntButSorted);
  const one = flipAt(turned, 1);
  t.ok('right order, one burnt side up: not solved', !solved(one.pos));
}

t.where('grade');
{
  t.eq('par with no help is three stars', JSON.stringify(grade(5, 5, 0)), JSON.stringify({ over: 0, stars: 3, hinted: false }));
  t.eq('one extra flip is two', grade(6, 5, 0).stars, 2);
  t.eq('two extra is one', grade(7, 5, 0).stars, 1);
  t.eq('and so is ten extra', grade(15, 5, 0).stars, 1);
  t.eq('a run is marked hinted forever', grade(5, 5, 1).hinted, true);
  t.eq('hinted does not change the star count', grade(5, 5, 1).stars, 3);
  // over < 0 is impossible if par is the true minimum, but the rating must not crash on a hand-fed
  // value: the browser gate feeds it from the DOM.
  t.eq('a shorter-than-par run reports a negative over, not a silent 3', grade(4, 5, 0).over, -1);
  t.eq('and still gets three stars rather than throwing', grade(4, 5, 0).stars, 3);
}

t.done();
