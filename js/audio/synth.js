// Sound, synthesised — no audio files, because a file is a byte the site has to fetch and this repo
// ships zero dependencies.
//
// Two things this file has to get right:
//   - a browser will not let a page make noise before a gesture, so the context is created on the
//     first one and every call before that is a no-op rather than a console error;
//   - the gate cannot listen. So every note is also recorded in `history`, and "the flip that was
//     rejected made a different sound" is a claim about data the tests can actually read.

const KEY = 'pancake.sound.v1';
const MAX_LOG = 24;

export function createAudio(storage, opts = {}) {
  const AC =
    opts.AudioContext ||
    (typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null);
  let ctx = null;
  let on = opts.enabled === undefined ? read() !== false : !!opts.enabled;
  const history = [];

  function read() {
    try {
      const raw = storage && storage.getItem(KEY);
      return raw === null ? null : raw !== 'off';
    } catch {
      return null;
    }
  }

  // Created lazily and never retried after a hard failure: an AudioContext that throws (no output
  // device, blocked by policy) has to silence the game, not break it.
  function ensure() {
    if (!AC || !on) return null;
    if (!ctx) {
      try {
        ctx = new AC();
      } catch {
        on = false;
        return null;
      }
    }
    if (ctx.state === 'suspended' && ctx.resume) {
      const r = ctx.resume();
      if (r && r.catch) r.catch(() => {});
    }
    return ctx;
  }

  function note({ freq, dur = 0.12, type = 'triangle', gain = 0.16, slide = 0, delay = 0 }) {
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(env).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function play(name, notes) {
    history.push({ name, at: Date.now(), notes: notes.map((n) => Math.round(n.freq)) });
    if (history.length > MAX_LOG) history.shift();
    if (!on) return;
    const c = ensure();
    if (!c) return;
    for (const n of notes) note(n);
  }

  const audio = {
    get available() {
      return !!AC;
    },
    get enabled() {
      return on;
    },
    get history() {
      return history.slice();
    },
    get running() {
      return !!ctx && ctx.state === 'running';
    },
    setEnabled(v) {
      on = !!v;
      try {
        storage && storage.setItem(KEY, on ? 'on' : 'off');
      } catch {
        /* the preference lives for this tab either way */
      }
      if (!on) audio.stop();
      return on;
    },
    // The gesture that unlocks audio has to be the one the player made, not a page load.
    unlock() {
      ensure();
    },
    stop() {
      if (!ctx) return;
      try {
        ctx.suspend();
      } catch {
        /* already closed */
      }
      history.length = 0;
    },
    // Flipping the whole stack sounds heavier than flipping two: the base falls as `k` grows.
    flip(k, n) {
      const base = 220 - 12 * k;
      play('flip', [
        { freq: base, dur: 0.1, type: 'triangle', gain: 0.18, slide: -40 },
        { freq: base * 1.5, dur: 0.07, type: 'sine', gain: 0.08, delay: 0.02 },
      ]);
      void n;
    },
    // A rejected tap is a low thud, deliberately unlike any flip sound, so "nothing happened" is
    // never mistaken for "it worked quietly".
    reject() {
      play('reject', [{ freq: 96, dur: 0.13, type: 'square', gain: 0.1, slide: -30 }]);
    },
    hint() {
      play('hint', [
        { freq: 660, dur: 0.08, type: 'sine', gain: 0.12 },
        { freq: 880, dur: 0.09, type: 'sine', gain: 0.1, delay: 0.07 },
      ]);
    },
    // The finish is arpeggiated upward when the run matched par and flat when it did not: the
    // player should hear the difference without being told.
    solve(over) {
      const steps = over <= 0 ? [523, 659, 784, 1046] : over === 1 ? [523, 659, 784] : [523, 622, 740];
      play('solve', steps.map((freq, i) => ({ freq, dur: 0.14, type: 'triangle', gain: 0.14, delay: i * 0.08 })));
    },
  };
  return audio;
}
