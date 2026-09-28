// Minimal CDP driver for headless playtesting (Node 22+ global WebSocket/fetch).
//
// env: CDP_PORT (devtools port, default 9386), BASE_URL (page origin, default
//      http://127.0.0.1:5266/), EMULATE=WxHxD (device metrics for this invocation)
//
//   node tools/playtest.cjs open <url>          fresh tab at <url>, prints boot logs
//   node tools/playtest.cjs eval '<expr>'       evaluate, await promises, print result
//   node tools/playtest.cjs eval '<expr>' nonav don't navigate first
//   node tools/playtest.cjs scenario <name>     inject tools/scenarios.js, run __ng.<name>()
//   node tools/playtest.cjs shot <file.png>
//   node tools/playtest.cjs metrics 380x780x2   force a mobile viewport (real layout viewport)
//   node tools/playtest.cjs logs
//
// Which page to attach to is decided by BASE_URL's origin, never by a hard-coded port:
// an `eval` that silently lands on an about:blank target reads like a broken deploy.
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.CDP_PORT || 9386);
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5266/';
const ORIGIN = new URL(BASE).origin;
const cmd = process.argv[2];
const arg = process.argv[3];
const rest = process.argv[4];
const isOurs = (u) => typeof u === 'string' && u.startsWith(ORIGIN);

const logs = [];

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) this.consume(msg);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  consume(m) {
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails;
      logs.push(`[EXCEPTION] ${e.exception?.description || e.text}\n  at ${e.url}:${e.lineNumber}`);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error') logs.push(`[log:error] ${e.text} ${e.url || ''}`);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevTools(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return res.json();
    } catch {
      /* not bound yet */
    }
    if (Date.now() > deadline) throw new Error(`devtools never bound on :${PORT}`);
    await sleep(250);
  }
}

async function main() {
  const info = await waitForDevTools();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const cdp = new CDP(ws);

  let list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  if (cmd === 'open') {
    for (const t of list) {
      if (t.type === 'page' && isOurs(t.url)) {
        try {
          await cdp.send('Target.closeTarget', { targetId: t.id || t.targetId });
        } catch { /* already gone */ }
      }
    }
    await sleep(300);
    list = [];
  }
  const existing = cmd === 'open' ? null : list.find((t) => t.type === 'page' && isOurs(t.url));
  let sessionId;
  if (existing) {
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId: existing.id || existing.targetId, flatten: true }));
  } else {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  }

  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  // Emulation lives and dies with the session that set it, so a mobile leg cannot be
  // `playtest.cjs metrics …` followed by a separate `playtest.cjs scenario …` — the second process
  // attaches a new session and gets the desktop viewport back. Set it here, before any navigation,
  // so the page boots inside the device it is being tested as.
  if (process.env.EMULATE) {
    const [w, h, dpr] = process.env.EMULATE.split('x').map(Number);
    if (!w || !h) throw new Error(`EMULATE wants WxHxD, got ${process.env.EMULATE}`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr || 1, mobile: true }, sessionId);
  }

  const evaluate = async (expression) => {
    const r = await cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, timeout: 900000 },
      sessionId
    );
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  };

  const navigate = async (url) => {
    // A navigation that only changes the fragment reuses the live document, so a scenario run after
    // it is reading JavaScript that never booted again — which is exactly how a "reload" gate ends
    // up asserting a page against itself. Stamp the current document and wait for one without the
    // stamp; if that never happens, say so instead of silently testing the stale frame.
    let stamped = false;
    try {
      await evaluate('window.__preNav = 1');
      stamped = true;
    } catch {
      /* no context to stamp (first navigation from about:blank) */
    }
    await cdp.send('Page.navigate', { url }, sessionId);
    for (let i = 0; i < 200; i++) {
      const ready = await evaluate('document.readyState').catch(() => 'loading');
      if (ready === 'complete') {
        if (!stamped) return;
        const stale = await evaluate('window.__preNav === 1').catch(() => false);
        if (!stale) return;
      }
      await sleep(100);
    }
    throw new Error(`navigation to ${url} never committed a new document`);
  };

  if (cmd === 'open') {
    await navigate(arg || BASE);
    await sleep(400);
    console.log('opened ' + (arg || BASE) + '\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'eval') {
    if (rest !== 'nonav') await navigate(BASE);
    const out = await evaluate(arg);
    console.log(typeof out === 'string' ? out : JSON.stringify(out));
  } else if (cmd === 'scenario') {
    const src = fs.readFileSync(path.join(__dirname, 'scenarios.js'), 'utf8');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: src }, sessionId);
    await navigate(BASE);
    // Headless reports the page as hidden, and the render loop is allowed to skip
    // frames when hidden — so a scenario that waits on animation would time out
    // against a browser that is only pretending to be in the background.
    await evaluate(`Object.defineProperty(document,'hidden',{get:()=>false,configurable:true});
      Object.defineProperty(document,'visibilityState',{get:()=>'visible',configurable:true});'ok'`);
    const out = await evaluate(`(async()=>{
      if (!window.__ng) throw new Error('scenarios.js never installed');
      const r = await window.__ng[${JSON.stringify(arg)}]();
      return JSON.stringify(r);
    })()`);
    // Console noise first, machine-readable line last: the parser in verify.sh takes the
    // final RESULT line, so a stray '{' in a log cannot hijack the report.
    if (logs.length) console.error(logs.slice(-40).join('\n'));
    console.log('RESULT ' + out);
  } else if (cmd === 'shot') {
    // A background tab only pushes compositor frames when something repaints it, so a
    // capture taken right after a pure CSS state change (hiding one screen, showing
    // another) can return the previous frame. Bringing the target forward forces one.
    await cdp.send('Page.bringToFront', {}, sessionId);
    await sleep(250);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.mkdirSync(path.dirname(arg), { recursive: true });
    fs.writeFileSync(arg, Buffer.from(data, 'base64'));
    console.log('wrote ' + arg);
  } else if (cmd === 'logs') {
    console.log(logs.join('\n') || '(clean)');
  } else if (cmd === 'metrics') {
    // A real viewport change, not a resized window: the mobile media query keys off the layout
    // viewport, and --window-size includes chrome that headless-new does not draw.
    const [w, h, dpr] = (arg || '380x780x2').split('x').map(Number);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr || 2, mobile: true }, sessionId);
    await sleep(300);
    console.log(JSON.stringify(await evaluate('JSON.stringify({w:innerWidth,h:innerHeight,dpr:devicePixelRatio,mq:matchMedia("(max-width: 520px)").matches})')));
  } else if (cmd === 'reload-logs') {
    await navigate(BASE);
    console.log(logs.join('\n') || '(clean)');
  } else {
    console.error('unknown command: ' + cmd);
    process.exit(64);
  }
  ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('ERROR ' + (err.message || err));
  if (logs.length) console.error(logs.slice(-12).join('\n'));
  process.exit(1);
});
