// Progress on disk: best run per level, stars, and whether a level was ever finished with help.
//
// The failure mode this file exists to prevent: `try { JSON.parse(raw) } catch { return [] }`
// followed by any write silently deletes a player's whole history because one record out of
// thirty got truncated by a half-finished tab close. So decoding is per record, not per blob:
// a blob that will not parse is re-scanned object by object, the survivors are kept, and the
// corpse is copied aside instead of dropped.
//
// `storage` is injected so the node suite can hand it a fake that returns whatever bytes a real
// tab would have left behind.

export const KEY = 'pancake.progress.v1';
const RECORD = /^\s*\{[^{}]*\}\s*$/;

export function emptyProgress() {
  return { levels: {}, runs: 0, solved: 0 };
}

// Records are stored individually so a bad one costs one level, not the library.
function salvage(raw) {
  const out = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        const piece = raw.slice(start, i + 1);
        if (RECORD.test(piece)) {
          try {
            const rec = JSON.parse(piece);
            if (rec && typeof rec.id === 'string') out.push(rec);
          } catch {
            /* this one is unreadable; the rest still count */
          }
        }
        start = -1;
      }
    }
  }
  return out;
}

export function createStore(storage, opts = {}) {
  const key = opts.key || KEY;
  const bad = [];
  // One read helper, so getItem throwing (private mode, a full quota) is handled in exactly one
  // place instead of wherever a caller happened to need the bytes.
  const read = () => {
    try {
      return storage.getItem(key);
    } catch (e) {
      bad.push('unreadable:' + (e && e.name));
      return null;
    }
  };
  const store = {
    get problems() {
      return bad.slice();
    },
    load() {
      let raw = null;
      try {
        raw = storage.getItem(key);
      } catch (e) {
        bad.push('unreadable:' + (e && e.name));
        return emptyProgress();
      }
      if (raw === null || raw === undefined || raw === '') return emptyProgress();
      let records = null;
      try {
        const parsed = JSON.parse(raw);
        records = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.levels) ? parsed.levels : null;
        if (records === null && parsed && typeof parsed === 'object' && parsed.levels && typeof parsed.levels === 'object') {
          // the v1 blob shape: { levels: {id: rec}, ... }
          return normalize(parsed);
        }
      } catch (e) {
        bad.push('corrupt-blob:' + (e && e.name));
      }
      if (records === null) {
        // Whole-blob parse failed. Keep whatever individual records still parse, and quarantine
        // the original bytes so a player's history is never *only* in memory after this point.
        const found = salvage(raw);
        bad.push(`salvaged:${found.length}`);
        try {
          storage.setItem(key + '.corrupt', raw);
        } catch (e) {
          bad.push('quarantine-refused:' + (e && e.name));
        }
        return { levels: fromRecords(found), runs: found.length, solved: found.filter((r) => r.solved).length, salvaged: found.length };
      }
      const levels = fromRecords(records);
      // Parsed fine but nothing usable in it: that is a damaged file too, and saying so is what
      // keeps "an empty library" from being indistinguishable from "a corrupt one".
      if (!Object.keys(levels).length && records.length) bad.push(`no-records-in-blob:${records.length}`);
      return {
        levels,
        runs: Object.keys(levels).length,
        solved: Object.values(levels).filter((r) => r.solved).length,
      };
    },
    // The two ways this function can destroy a history are a payload it cannot encode and an empty
    // one it encodes happily, so both are refused before a byte is written: a failed save is a lost
    // update, not an erased library.
    save(progress) {
      const bag = progress && typeof progress === 'object' ? progress.levels : null;
      if (!bag || typeof bag !== 'object') {
        bad.push('not-a-progress');
        return false;
      }
      const records = Object.values(bag);
      let encoded;
      try {
        // Encoded record by record: one unencodable entry (a cycle, a BigInt from some future
        // field) has to abort the write, not vanish from the file.
        encoded = '[' + records.map((r) => JSON.stringify(r)).join(',') + ']';
        if (/null/.test(encoded) && records.every(Boolean) === false) throw new Error('null record');
      } catch (e) {
        bad.push('encode-refused:' + (e && e.message || e && e.name));
        return false;
      }
      if (!records.length) {
        const existing = read();
        if (existing && existing.length > 2 && /\{/.test(existing)) {
          bad.push('refused-empty-overwrite');
          return false;
        }
      }
      try {
        storage.setItem(key, encoded);
        return true;
      } catch (e) {
        bad.push('write-refused:' + (e && e.name));
        return false;
      }
    },
    record(progress, id, patch) {
      const prev = progress.levels[id] || { id, best: null, stars: 0, hinted: false, solved: false };
      const next = { ...prev, ...patch };
      if (typeof patch.best === 'number') {
        next.best = prev.best === null ? patch.best : Math.min(prev.best, patch.best);
      }
      progress.levels[id] = next;
      return next;
    },
  };
  return store;
}

function fromRecords(records) {
  const levels = {};
  for (const r of records) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string') continue;
    levels[r.id] = r;
  }
  return levels;
}

function normalize(blob) {
  const levels = {};
  for (const [id, rec] of Object.entries(blob.levels || {})) {
    if (rec && typeof rec === 'object') levels[id] = { id, ...rec };
  }
  return { levels, runs: Object.keys(levels).length, solved: Object.values(levels).filter((r) => r.solved).length };
}
