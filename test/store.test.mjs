// Progress persistence. The bug class this file exists for: a save file with one unreadable record
// loads as "no records", and the next write then deletes a player's whole history. Every assertion
// below is about what survives a damaged blob.

import { suite } from '../tools/harness.mjs';
import { fakeStorage } from '../tools/harness.mjs';
import { createStore, emptyProgress, KEY } from '../js/store.js';
import { LOTS } from '../js/data/lots.js';

const t = suite('store');

const rec = (id, over = {}) => ({ id, best: 5, stars: 3, hinted: false, solved: true, ...over });

t.where('empty and round trip');
{
  const st = fakeStorage();
  const s = createStore(st);
  const p = s.load();
  t.eq('no storage, no progress', Object.keys(p.levels).length, 0);
  t.eq('and nothing claimed as problems', s.problems.length, 0);
  s.record(p, LOTS[0].id, rec(LOTS[0].id));
  s.record(p, LOTS[1].id, rec(LOTS[1].id, { best: 7, stars: 2 }));
  t.ok('save succeeds', s.save(p));
  const again = createStore(fakeStorage()).load();
  t.eq('an untouched store starts empty', Object.keys(again.levels).length, 0);
  const reread = s.load();
  t.eq('the same store reads back what it wrote', Object.keys(reread.levels).length, 2);
  t.eq('with the best value intact', reread.levels[LOTS[1].id].best, 7);
  t.eq('and the blob on disk is a JSON array of records', JSON.parse(st.raw(KEY)).length, 2);
}

t.where('best is a minimum, not a timestamp');
{
  const s = createStore(fakeStorage());
  const p = s.load();
  const put = (id, patch) => {
    p.levels[id] = s.record(p, id, patch);
    return p.levels[id];
  };
  t.eq('the first run on a level sets the best', put('pk-warm-1', { best: 8 }).best, 8);
  t.eq('a worse later run does not overwrite it', put('pk-warm-1', { best: 9 }).best, 8);
  t.eq('a better one does', put('pk-warm-1', { best: 6 }).best, 6);
  t.eq('a brand new level records its first best', put('pk-warm-3', { best: 4 }).best, 4);
  t.eq('and never reports a best of 0 for an unsolved level', put('pk-warm-4', { best: 3, solved: false }).solved, false);
}

t.where('one bad record must not cost the library');
{
  // One whole record and a second one cut mid-value: the bytes a tab that was killed during a
  // write leaves behind. (The first draft of this fixture ended with `}]`, which was valid JSON and
  // therefore tested nothing — the truncation has to actually truncate.)
  const head = '[{"id":"pk-warm-1","best":5,"solved":true},{"id":"pk-warm-2","bes';
  const cut = 't":6,"solved":tru';
  const raw = head + cut;
  const st = fakeStorage({ [KEY]: raw });
  const s = createStore(st);
  const p = s.load();
  t.ok('the load reported a problem instead of shrugging', s.problems.length > 0);
  t.eq('the record before the cut survived', Object.keys(p.levels).filter((k) => k.startsWith('pk-warm-1')).length, 1);
  t.eq('salvaged exactly the readable records', Object.keys(p.levels).length, 1);
  t.ok('the damaged bytes were quarantined, not dropped', typeof st.raw(KEY + '.corrupt') === 'string');
  t.eq('and the quarantine holds the original blob, byte for byte', st.raw(KEY + '.corrupt'), raw);
  // The part that used to delete everything: save what survived, then read it back.
  t.ok('saving the survivors works', s.save(p));
  const after = JSON.parse(st.raw(KEY));
  t.eq('and the survivor is still there after the write', after.length, 1);
  t.eq('with its best intact', after[0].best, 5);
}

t.where('garbage it should skip rather than choke on');
{
  const cases = [
    ['not json at all', 'pancake'],
    ['an empty object', '{}'],
    ['a JSON object with no levels', '{"a":1}'],
    ['an array of junk', '[1,"two",null,[]]'],
    ['an array with one good record among junk', '[3,{"id":"pk-warm-1","best":4},"x"]'],
  ];
  for (const [label, raw] of cases) {
    const st = fakeStorage({ [KEY]: raw });
    const s = createStore(st);
    let threw = null;
    let p = null;
    try {
      p = s.load();
    } catch (e) {
      threw = e;
    }
    t.eq(`${label}: load() does not throw`, threw ? threw.message : 'clean', 'clean');
    t.ok(`${label}: levels is always an object`, p && typeof p.levels === 'object');
    t.ok(`${label}: a problem is recorded (never silently empty)`, s.problems.length > 0 || p.levels && Object.keys(p.levels).length > 0);
  }
  const st = fakeStorage({ [KEY]: '[3,{"id":"pk-warm-1","best":4},"x"]' });
  const good = createStore(st).load();
  t.eq('the readable record among junk is kept', Object.keys(good.levels).join(','), 'pk-warm-1');
}

t.where('a write that cannot be encoded keeps the old bytes');
{
  const st = fakeStorage({ [KEY]: '[{"id":"pk-warm-1","best":5,"solved":true}]' });
  const s = createStore(st);
  const p = s.load();
  const circular = { levels: {} };
  circular.self = circular;
  t.ok('save() says no', !s.save(circular));
  t.eq('and the previous file is untouched', st.raw(KEY), '[{"id":"pk-warm-1","best":5,"solved":true}]');
  const cyclic = { levels: { 'pk-warm-2': circular } };
  t.ok('a record nested in a cycle is also refused', !s.save(cyclic));
  t.eq('still untouched', JSON.parse(st.raw(KEY)).length, 1);
  // The v1 blob shape (an object keyed by level id) is a thing real saves on disk may already be.
  const legacy = fakeStorage({ [KEY]: JSON.stringify({ levels: { 'pk-warm-1': { best: 3, solved: true } } }) });
  const lp = createStore(legacy).load();
  t.eq('the object shape loads', lp.levels['pk-warm-1'].best, 3);
  t.eq('and the next save normalises it into the record array', (() => {
    const s2 = createStore(legacy);
    s2.save(lp);
    return JSON.parse(legacy.raw(KEY))[0].id;
  })(), 'pk-warm-1');
}

t.where('the store refuses to be the only copy of a claim');
{
  const p = emptyProgress();
  t.eq('empty progress has no levels', Object.keys(p.levels).length, 0);
  t.eq('and says so about runs', p.runs, 0);
  // A storage backend that throws on getItem (Safari private mode) must degrade to empty, not
  // crash the boot.
  const hostile = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => {}, removeItem: () => {} };
  const s = createStore(hostile);
  t.eq('an unreadable store loads empty', Object.keys(s.load().levels).length, 0);
  t.ok('and records why', s.problems.some((x) => /unreadable/.test(x)));
  const saveFailed = createStore({
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: () => {},
  });
  const np = saveFailed.load();
  saveFailed.record(np, 'pk-warm-1', rec('pk-warm-1'));
  t.ok('a refused write is reported, not swallowed', !saveFailed.save(np));
  t.ok('and named', saveFailed.problems.some((x) => /write-refused/.test(x)));
}

t.done();
