// Browser-side scenario suite, injected by tools/playtest.cjs and run against the real page.
//
// The rule for anything asserted here: read the DOM, the geometry and the canvas pixels, not a
// flag. A `solved` boolean says what the code intended; a client rect, a pixel and the bytes in
// localStorage say what the player got. The interesting failures in this game are exactly the ones
// where the model is right and the page is wrong — a burnt face painted on the wrong edge, a hint
// line that names a depth the pointer cannot reach, a star count computed correctly and never
// written into the document.
//
// Every move the scenarios make goes through the *input* path: a PointerEvent at a client
// coordinate, or a click on a real button, or a real keydown. Never game.flip. A green play leg
// therefore proves the hit-test, the animation callback, the HUD repaint and the progress write all
// fired — not just the arithmetic.
//
// ck(name, condition, detail) is truthiness; eq(name, got, want) is equality. Anything that must
// equal goes through eq, because `ck('count', 0)` reads as a failure to a human and a pass to a
// boolean.

((w) => {
  const rows = [];
  const ck = (test, cond, detail) => {
    rows.push({ test, pass: !!cond, detail: cond ? '' : String(detail === undefined ? '' : detail) });
  };
  const eq = (test, got, want) => ck(test, String(got) === String(want), `got ${got} / want ${want}`);
  const report = (extra) => {
    // rows is copied, not aliased: it is cleared below, and a live reference would hand back an
    // empty report that still reads as "0 failed". The envelope keys are written last so a leg's
    // own extra can never replace the row list with a number — the parser would then fail on
    // `int` and a broken leg would look like a crashed gate.
    const out = { ...extra, rows: rows.slice(), fail: rows.filter((r) => !r.pass).length };
    rows.length = 0;
    return out;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const A = () => w.pancake;
  const E = () => w.pancake.engine;
  const $ = (sel) => document.querySelector(sel);
  const text = (sel) => (($.call(document, sel) || {}).textContent || '').trim();
  const shown = (sel) => {
    const e = $(sel);
    if (!e) return false;
    return getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
  };
  const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const rgb = (hex) => {
    const s = hex.replace('#', '');
    const v = s.length === 3 ? s.split('').map((x) => x + x) : [s.slice(0, 2), s.slice(2, 4), s.slice(4, 6)];
    return v.map((x) => parseInt(x, 16) || 0);
  };
  const near = (a, b, tol) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tol);
  const rgbStr = (hex) => {
    const [r, g, b] = rgb(hex);
    return `rgb(${r}, ${g}, ${b})`;
  };
  const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const px = (x, y) => A().view.pixels(x, y);

  // The witness is the surface the legs actually read, not just `version`. main.js once grew a
  // second `window.pancake = {...}` at its tail, which kept the object alive but dropped
  // engine/go/state/view — and `version` alone cannot see that.
  const SURFACE = ['version', 'engine', 'state', 'go', 'view', 'optimal', 'hint', 'solveAll'];
  const missingSurface = () => SURFACE.filter((k) => {
    const v = w.pancake ? w.pancake[k] : undefined;
    return v === undefined || v === null;
  });
  async function ready() {
    for (let i = 0; i < 200; i++) {
      if (w.pancake && w.pancake.engine && w.pancake.engine.TIERS && missingSurface().length === 0) return true;
      await wait(50);
    }
    // A leg that cannot reach the page must say so *as a row*: the harness counts rows, and an
    // empty report reads as "the gate crashed" instead of naming the missing surface.
    ck('window.pancake 台面完整（腿要读的字段都在）', false,
      w.pancake ? '缺 ' + missingSurface().join(',') + ' · 台面上只有 ' + Object.keys(w.pancake).join(',')
        : 'js/main.js never exposed window.pancake');
    return false;
  }

  // Wait for the flip animation to actually finish. A scenario that slept a fixed time instead would
  // also pass against a page whose rAF never ticked, and that is the case worth catching in headless.
  async function settle(ms = 3000) {
    const budget = Math.ceil(ms / 25);
    for (let i = 0; i < budget; i++) {
      if (!A().view.busy) return true;
      await wait(25);
    }
    return !A().view.busy;
  }

  async function goto(id) {
    A().go(id);
    for (let i = 0; i < 120; i++) {
      if (A().state.id === id && shown('#board-screen')) break;
      await wait(25);
    }
    await settle();
    return A().state;
  }

  function rowOf(id) {
    return E().LOTS.find((r) => r.id === id) || null;
  }
  function rowForState(st) {
    return rowOf(st.id) || E().sampleLevel(st.tier, st.seed);
  }

  function pointer(type, x, y) {
    const ev = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      clientX: x,
      clientY: y,
    });
    A().view.canvas.dispatchEvent(ev);
    return ev;
  }

  // A real pointer down/up at the client coordinate the view itself claims hits depth k-1.
  function tapNow(k) {
    const p = A().view.pointFor(k);
    pointer('pointerdown', p.x, p.y);
    pointer('pointerup', p.x, p.y);
    return p;
  }
  async function tap(k) {
    const p = tapNow(k);
    const done = await settle();
    ck(`点 k=${k} 的动画收尾了`, done, 'view.busy never cleared');
    return p;
  }
  async function tapOutside(dx, dy) {
    const p = A().view.pointFor(1);
    pointer('pointerdown', p.x + dx, p.y + dy);
    pointer('pointerup', p.x + dx, p.y + dy);
    await settle();
    return { x: p.x + dx, y: p.y + dy };
  }
  function key(k) {
    // Dispatch on the focused element, not on document: a synthetic event whose target is document
    // proves the listener exists but not that the page respects *where* the player is.
    const t = document.activeElement || document.body;
    t.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  }
  const clearToast = () => {
    $('#toast').classList.remove('on');
    $('#toast').textContent = '';
  };
  const winStats = () => {
    const out = {};
    for (const box of document.querySelectorAll('#win-stats > div')) {
      const dt = box.querySelector('dt');
      const dd = box.querySelector('dd');
      if (dt && dd) out[dt.textContent.trim()] = dd.textContent.trim();
    }
    return out;
  };

  // ---------- boot ----------
  const boot = async () => {
    ck('window.pancake 存在', await ready(), 'js/main.js never exposed window.pancake');
    if (!w.pancake) return report();
    eq('版本可读', A().version, '1.0.0');
    ck('bootAt 是本页 timeOrigin', A().bootAt > 1e12 && Math.abs(A().bootAt - performance.timeOrigin) < 1, A().bootAt);
    eq('开局落在关卡表', document.body.dataset.screen, 'menu');
    ck('菜单可见', shown('#menu'));
    ck('对局页不占位', !shown('#board-screen') && $('#board-screen').getClientRects().length === 0);
    ck('收局页不占位', !shown('#win') && $('#win').getClientRects().length === 0);
    ck('未知关卡提示默认不显示', $('#menu-note').hidden === true && !shown('#menu-note'), 'hidden 被区块自身 display 盖过');
    eq('档位分组数', document.querySelectorAll('#tier-list .tier').length, E().TIERS.length);
    eq('关卡卡片数', document.querySelectorAll('#tier-list .card').length, E().LOTS.length);
    eq('随机按钮数', document.querySelectorAll('#random-buttons button').length, E().TIERS.length);
    const d8 = E().MEASURED_DIAMETER['8|plain'];
    ck('承诺条引用实测状态数', text('#claim').includes(fmt(d8.states)), text('#claim'));
    ck('承诺条引用实测直径', text('#claim').includes(`直径 ${d8.diameter} 步`), text('#claim'));
    ck('承诺条不谎称更大的图', !text('#claim').includes(fmt(362880)), text('#claim'));
    const first = document.querySelector('#tier-list .card');
    ck('卡片真的渲染进了布局', first && first.getBoundingClientRect().width > 60, first && first.getBoundingClientRect().width);
    return report({ claim: text('#claim'), lots: E().LOTS.length });
  };

  // ---------- table ----------
  // The promise of this repo, re-derived inside the browser that ships it.
  const table = async () => {
    if (!(await ready())) return report();
    const problems = A().verifyTable();
    ck('出货表在浏览器里全量复核无问题', problems.length === 0, problems.join(' | '));
    eq('出货 23 关', E().LOTS.length, 23);
    for (const t of E().TIERS) {
      const want = t.specs.reduce((a, s) => a + s.want, 0);
      eq(`档位 ${t.id} 行数`, E().LOTS.filter((r) => r.tier === t.id).length, want);
    }
    // A gate with no teeth is a caption. Break one number and prove checkRows notices.
    const mutated = E().LOTS.map((r) => ({ ...r }));
    mutated[3].par += 1;
    const found = A().verifyTable(mutated);
    ck('改高一个 par 会被抓', found.some((p) => p.indexOf(mutated[3].id) === 0 && /par/.test(p)), found.join(' | '));
    const stacky = E().LOTS.map((r) => ({ ...r }));
    stacky[7].stack = stacky[7].stack.slice().reverse();
    ck('改一张饼的堆叠会被抓', A().verifyTable(stacky).some((p) => /printed stack/.test(p)), 'stack mutation slipped through');
    const stray = E().LOTS.map((r) => ({ ...r }));
    stray[0].code += 6;
    ck('code 出了状态空间会被抓', A().verifyTable(stray).some((p) => /outside/.test(p)), 'code mutation slipped through');
    const free = E().LOTS.map((r) => ({ ...r }));
    free[1].par = 0;
    ck('送一个已经叠好的关卡会被抓', A().verifyTable(free).some((p) => /already solved/.test(p)), 'par 0 slipped through');
    // Published diameters, re-measured in Chrome on the small graphs.
    eq('三层普通直径 3', E().field(3, false).diameter, 3);
    eq('三层普通状态数 6', E().field(3, false).size, 6);
    eq('三层焦边直径 6', E().field(3, true).diameter, 6);
    eq('四层焦边直径 8', E().field(4, true).diameter, 8);
    eq('六层焦边状态数 46080', E().field(6, true).size, 46080);
    ck('八层普通图跑完了', E().field(8, false).complete, E().field(8, false).reached + '/' + E().field(8, false).size);
    eq('八层普通直径与表一致', E().field(8, false).diameter, E().MEASURED_DIAMETER['8|plain'].diameter);
    ck('没有 par 0/1 的关卡', E().LOTS.every((r) => r.par >= 2), E().LOTS.filter((r) => r.par < 2).map((r) => r.id).join(','));
    ck('每关都至少有一种最优起手', E().LOTS.every((r) => r.starts >= 1), E().LOTS.filter((r) => !r.starts).map((r) => r.id).join(','));
    ck('每关的 detour 都非负', E().LOTS.every((r) => r.detour >= 0), E().LOTS.filter((r) => r.detour < 0).map((r) => r.id).join(','));
    return report({ problems: problems.length, lots: E().LOTS.length });
  };

  // ---------- menu ----------
  const menu = async () => {
    if (!(await ready())) return report();
    for (const t of E().TIERS) {
      const box = $(`#tier-list .tier[data-tier="${t.id}"]`);
      ck(`档位 ${t.id} 有分组且可见`, !!box && box.getClientRects().length > 0);
    }
    const cards = [...document.querySelectorAll('#tier-list .card')];
    eq('每张卡片都带 data-id', cards.filter((c) => c.dataset.id).length, cards.length);
    let mismatched = 0;
    const bads = [];
    for (const c of cards) {
      const r = rowOf(c.dataset.id);
      if (!r) {
        mismatched++;
        bads.push(c.dataset.id + ':不在表里');
        continue;
      }
      const t = c.textContent || '';
      if (!t.includes(`par ${r.par}`)) {
        mismatched++;
        bads.push(r.id + ':par 文字');
      }
      if (!t.includes(`${r.n} 层`)) {
        mismatched++;
        bads.push(r.id + ':层数文字');
      }
      if ((r.mode === 'burnt') !== t.includes('焦边')) bads.push(r.id + ':焦边文字');
      if (r.mode === 'burnt' && !t.includes('焦边')) mismatched++;
    }
    eq('卡片文字与出货表一致（错配数）', mismatched, 0);
    ck('错配清单为空', bads.length === 0, bads.join(','));
    const target = E().LOTS[5].id;
    $(`#tier-list .card[data-id="${target}"]`).click();
    await wait(100);
    eq('点卡片进入该关', A().state.id, target);
    eq('地址栏跟着走', location.hash, '#' + target);
    ck('对局页可见', shown('#board-screen'));
    ck('菜单收起来了', !shown('#menu'));
    eq('HUD par 跟表走', text('#hud-par'), String(rowOf(target).par));
    $('#btn-menu').click();
    await wait(100);
    eq('返回关卡表', document.body.dataset.screen, 'menu');
    // 随机一局: the seed has to be in the address, and the same seed has to mean the same stack.
    $('#random-buttons button[data-random="reg"]').click();
    await wait(140);
    const st = A().state;
    ck('随机关落在熟手档', st.tier === 'reg', st.id);
    ck('随机关种子可读', Number.isInteger(st.seed) && st.seed > 0, st.seed);
    eq('地址栏写了种子', location.hash, '#pk-reg-r' + st.seed.toString(36));
    ck('种子行显示种子', text('#seed-shown').includes('seed=' + st.seed), text('#seed-shown'));
    // Same per-row facts as a baked row, without the campaign's row counts: one sampled level has
    // no table to fill, and applying the quota to it would report every tier as short.
    const sampled = A().verifyTable([rowForState(st)], { quotas: false });
    ck('随机关同样过复核', sampled.length === 0, sampled.join(' | '));
    const tampered = A().verifyTable([{ ...rowForState(st), par: st.par + 1 }], { quotas: false });
    ck('随机关的复核也有牙', tampered.some((p) => /par says/.test(p)), tampered.join(' | '));
    ck('随机关的 par 不是 0', st.par > 0, st.par);
    const stackBefore = st.stack.join(',');
    const seed36 = st.seed.toString(36);
    $('#btn-menu').click();
    await wait(80);
    await goto('pk-reg-r' + seed36);
    eq('同一种子回到同一摞饼', A().state.stack.join(','), stackBefore);
    eq('同一种子回到同一个 par', A().state.par, st.par);
    $('#random-buttons button[data-random="reg"]').click();
    await wait(140);
    ck('换一局换了种子', A().state.seed !== st.seed, `${st.seed} -> ${A().state.seed}`);
    A().go('pk-nonsense-1');
    await wait(140);
    eq('未知关卡号回到菜单', document.body.dataset.screen, 'menu');
    ck('未知关卡号写进了页面', !$('#menu-note').hidden && text('#menu-note').includes('pk-nonsense-1'), text('#menu-note'));
    eq('未知关卡号不留在地址栏', location.hash, '#menu');
    return report({ seed: st.seed, id: st.id });
  };

  // ---------- play ----------
  const play = async () => {
    if (!(await ready())) return report();
    const id = 'pk-warm-2';
    const baked = rowOf(id);
    const st0 = await goto(id);
    eq('关卡号', st0.id, id);
    eq('层数', st0.n, baked.n);
    eq('起始堆叠就是表里那张', st0.stack.join(','), baked.stack.join(','));
    eq('开局 0 步', st0.count, 0);
    eq('偏离显示 0', text('#hud-over'), '0');
    eq('步数格显示 0', text('#hud-moves'), '0');
    ck('说明里的 par 与表一致', text('#explain').includes(`par = ${baked.par}`), text('#explain'));
    ck('说明写了状态数', text('#explain').includes(fmt(E().MEASURED_DIAMETER[`${baked.n}|${baked.mode}`].states)), text('#explain'));
    ck('说明承认不显示剩余步数', text('#explain').includes('故意不显示'), text('#explain'));
    // Paint check: the stack is on the canvas, and the space above it is not.
    const bottom = A().view.pointFor(baked.n);
    ck('最底一张有像素', px(bottom.rect.x + bottom.rect.w / 2, bottom.rect.y + bottom.rect.h / 2).some((c) => c > 0), px(bottom.rect.x, bottom.rect.y).join(','));
    eq('饼摞上方不画东西', px(A().view.geom().w / 2, 6).join(','), '0,0,0');
    // Walk the measured optimal path with real pointer taps.
    const path = A().optimal();
    eq('最优路径长度就是 par', path.length, baked.par);
    let prev = st0.stack.join(',');
    for (let i = 0; i < path.length; i++) {
      await tap(path[i]);
      const st = A().state;
      eq(`第 ${i + 1} 铲翻几张`, st.moves[i], path[i]);
      eq(`第 ${i + 1} 步计数`, st.count, i + 1);
      eq(`第 ${i + 1} 步仍是全排列`, st.stack.slice().sort((a, b) => a - b).join(','), st.stack.map((_, j) => j + 1).join(','));
      ck(`第 ${i + 1} 步堆叠真的变了`, st.stack.join(',') !== prev, '模型没动');
      prev = st.stack.join(',');
      eq(`第 ${i + 1} 步 HUD 跟上`, text('#hud-moves'), String(i + 1));
      eq(`第 ${i + 1} 步行列表跟上`, document.querySelectorAll('#move-log li').length, i + 1);
    }
    ck('沿最优走一定叠好', A().state.solved, A().state.moves.join('>'));
    // The gate cannot listen, but it can read the note log: a flip that made no sound at all is
    // indistinguishable from a flip that was dropped.
    ck('每一铲都留了声音痕迹', A().audio.history.filter((x) => x.name === 'flip').length >= path.length, A().audio.history.map((x) => x.name).join(','));
    eq('偏离 0', A().state.over, 0);
    eq('叠好后堆叠是 1..n', A().state.stack.join(','), '1,2,3');
    eq('叠好时 HUD 显示 0 偏离', text('#hud-over'), '0');
    ck('叠好时偏离格标了 good', $('#hud-over').classList.contains('good'), $('#hud-over').className);
    // Undo is exact by construction (the tape is replayed from the start), so it must land on the
    // stack the step before produced — not approximately, but cell for cell.
    const P = path.length;
    const beforeUndo = A().state.stack.join(',');
    $('#btn-undo').click();
    await wait(80);
    eq('撤销退一步', A().state.count, P - 1);
    ck('撤销后没叠好', !A().state.solved);
    eq('撤销后 HUD', text('#hud-moves'), String(P - 1));
    ck('撤销前确实换过堆叠', beforeUndo !== A().state.stack.join(','), beforeUndo);
    $('#btn-undo').click();
    await wait(80);
    eq('再撤一步', A().state.count, P - 2);
    eq('行列表同步退', document.querySelectorAll('#move-log li').length, Math.max(1, P - 2));
    $('#btn-restart').click();
    await wait(80);
    eq('重来清零', A().state.count, 0);
    eq('重来回到原始堆叠', A().state.stack.join(','), baked.stack.join(','));
    eq('重来清空行列表', document.querySelectorAll('#move-log li').length, 1);
    ck('没步数时撤销按钮禁用', $('#btn-undo').disabled);
    eq('偏离格回到 0', text('#hud-over'), '0');
    // Widths follow sizes at every depth: a bigger pancake is drawn wider, and lower.
    const st = A().state;
    let bad = 0;
    for (let d = 1; d < st.n; d++) {
      const a = A().view.pointFor(d);
      const b = A().view.pointFor(d + 1);
      if (b.rect.y <= a.rect.y) bad++;
      if (st.stack[d] > st.stack[d - 1] && b.rect.width <= a.rect.width) bad++;
      if (st.stack[d] < st.stack[d - 1] && b.rect.width >= a.rect.width) bad++;
    }
    eq('宽度随尺寸单调、纵坐标递增（违例数）', bad, 0);
    return report({ path: path.join('>') });
  };

  // ---------- pause ----------
  // 这一腿验"暂停真的把仿真冻住"那句话：进度停在按下那一刻、恢复那一帧不跳完憋下的时间、
  // 这一铲最终落定。判据只读页面自己的量（view.animProgress / view.busy / canvas 像素 /
  // #btn-pause 的无障碍属性），阈值挂在 CSS 的 --dur-flip 与**实测经过的时间**上：
  // "恢复后视觉上多走的 ≤ 恢复之后真正过去的 gap + 一帧"这条式子跟着这台机器走，
  // 不跟着 340 / 40 这种抄来的数走（共享 runner 上 setTimeout 会漂，写死的带会把慢机器判成缺陷）。
  const pause = async () => {
    if (!(await ready())) return report();
    const baked = E().LOTS.filter((r) => r.par >= 4)[0];
    ck('找得到 par≥4 的关（两铲之后不会直接赢）', !!baked, E().LOTS.map((r) => r.par).join(','));
    if (!baked) return report();
    ck('这一腿要有真的翻牌缓动', !A().view.reduced,
      'view.reduced=true：reduced-motion 或 ?motion=off 之下 span=1ms，缓动一帧就走完，"冻住"无从可验');
    const spanMs = Number((token('--dur-flip') || '').replace('ms', '')) || 340;
    ck('缓动时长读得到且不是一帧', spanMs > 50, `--dur-flip=${token('--dur-flip')}`);
    if (A().view.reduced || spanMs <= 50) return report({ spanMs });
    await goto(baked.id);
    const c0 = A().state.count;
    tapNow(A().optimal()[0]);                    // 真指针下的手，不等收尾
    const wTap = performance.now();
    await wait(60);                              // 让缓动走到中段，而不是停在 t=0
    const sinceTap = performance.now() - wTap;
    ck('这一铲还在飞', A().view.busy, 'view.busy=false：动画已经落地，暂停无从可冻');
    const tPause = A().view.animProgress();
    // "中段"跟着**实测的下手时长**走，不跟着 60 这个数走：共享 runner 上 setTimeout(60) 可能真的
    // 过去 200ms，那时 t=0.6 仍然算中段；写死 0.05~0.9 就把一台慢机器判成缺陷。
    ck('暂停发生在缓动中段（既不是起点也不是终点）',
      tPause !== null && tPause > 0 && tPause < 1, `t=${tPause} · 下手后 ${sinceTap.toFixed(0)}ms`);
    const p = A().view.pointFor(A().state.moves[c0]);
    const pxBusy = px(p.rect.x + p.rect.w / 2, p.rect.y + p.rect.h / 2).join(',');
    $('#btn-pause').click();                     // 按玩家那枚按钮，不直接叫动词
    const w0 = performance.now();
    await wait(Math.max(150, Math.round(spanMs * 0.7)));
    const waited = performance.now() - w0;
    ck('暂停期间真的憋了一段时间', waited >= 150,
      `只等了 ${waited.toFixed(0)}ms：等待没跨过终点，"冻住"与"走完了"分不开`);
    eq('进度冻在按下那一刻', A().view.animProgress(), tPause);
    ck('暂停中没有偷偷落地', A().view.busy, 'view.busy 掉了：暂停把这一铲直接做完了');
    eq('画布上那张饼没再动', px(p.rect.x + p.rect.w / 2, p.rect.y + p.rect.h / 2).join(','), pxBusy);
    eq('按钮说「继续」', $('#btn-pause').getAttribute('aria-label'), '继续');
    eq('按钮标出按下态', $('#btn-pause').getAttribute('aria-pressed'), 'true');
    eq('按钮字形换成播放', $('#btn-pause').textContent.trim(), '▶');
    ck('台面读到的暂停态与按钮一致', A().isPaused() === true && A().state.paused === true,
      `${A().isPaused()}/${A().state.paused}`);
    // 恢复：view.setPaused 把 anim.start 后移暂停时长，所以暂停期间不产生视觉进度。
    const w1 = performance.now();
    key('p');                                    // 键盘那条绑定也走一次
    await wait(40);
    const gap = performance.now() - w1;
    const tResume = A().view.animProgress();
    const jumped = tResume === null ? spanMs : (tResume - tPause) * spanMs;
    // 允许走完的只有"恢复之后真正过去的时间"（再加一帧的余量）；多出来的那一段就是被憋下的暂停
    // 时长一次性灌进来的。上限挂在实测的 gap 上而不是 waited/2 上——慢机器上这 40ms 可能真的
    // 过去 200ms，那时走完 200ms 是物理正确，不是缺陷。
    ck('恢复那一帧没有把憋下的时间一次灌进来', jumped <= gap + 60,
      `视觉上走了 ${jumped.toFixed(0)}ms / 恢复后又过了 ${gap.toFixed(0)}ms（暂停憋了 ${waited.toFixed(0)}ms）：anim.start 没后移（或直接落地）`);
    ck('进度没有倒退', tResume === null || tResume >= tPause, `${tPause} → ${tResume}`);
    eq('键盘也把按钮复原', $('#btn-pause').getAttribute('aria-pressed'), 'false');
    ck('这一铲最终落定', await settle(), 'view.busy never cleared');
    eq('暂停没有吞掉这一步', A().state.count, c0 + 1);
    eq('HUD 跟上步数', text('#hud-moves'), String(c0 + 1));
    // 暂停中下的手：animateFlip 直接落定、不排缓动。这是"冻的是仿真不是模型"这句决定的形状，
    // 所以把它写成断言而不是注释——改天有人让暂停期继续排动画，这条会红。
    const c1 = A().state.count;
    $('#btn-pause').click();
    tapNow(A().optimal()[0]);
    await wait(40);
    ck('暂停中下手不排缓动', !A().view.busy && A().view.animProgress() === null,
      `busy=${A().view.busy} t=${A().view.animProgress()}`);
    eq('暂停中那一下仍然记步', A().state.count, c1 + 1);
    $('#btn-pause').click();
    eq('按钮回到「暂停」', $('#btn-pause').getAttribute('aria-label'), '暂停');
    A().setPaused(true); A().setPaused(true);
    eq('重复暂停不退态', A().isPaused(), true);
    A().setPaused(false);
    eq('再按一次解除', A().isPaused(), false);
    return report({
      id: baked.id, spanMs,
      sinceTapMs: Math.round(sinceTap), tPause: Number(tPause.toFixed(3)),
      waitedMs: Math.round(waited), gapMs: Math.round(gap), jumpedMs: Math.round(jumped),
    });
  };

  // ---------- reject ----------
  // A tap that is not a move has to be visible, audible and countable. Silence is indistinguishable
  // from a dropped input, which is the defect class this leg exists to catch.
  const reject = async () => {
    if (!(await ready())) return report();
    const plain = rowOf('pk-warm-4');
    await goto('pk-warm-4');
    eq('普通关模式', A().state.mode, 'plain');
    clearToast();
    A().audio.stop();
    tapNow(1);
    eq('只翻最上面一张不算一步', A().state.count, 0);
    eq('堆叠没变', A().state.stack.join(','), plain.stack.join(','));
    ck('拒绝弹了 toast', $('#toast').classList.contains('on') && text('#toast').length > 0, text('#toast'));
    ck('toast 说的是那张饼', text('#toast').includes('等于没翻'), text('#toast'));
    ck('画布抖了一下', $('#board').classList.contains('shake'), $('#board').className);
    eq('拒绝记了一件事', A().audio.history.length, 1);
    eq('记的是 reject 而不是 flip', A().audio.history[0].name, 'reject');
    ck('拒绝理由写进了行列表 title', ($('#move-log').lastElementChild.title || '').includes('等于没翻'), $('#move-log').lastElementChild.title);
    await settle();
    // The spatula line disappears once the pointer is up — it must not claim a cut that is not armed.
    ck('抬手后不再显示铲位', !A().view.geom().press, JSON.stringify(A().view.geom()));
    // A miss below the plate.
    clearToast();
    A().audio.stop();
    await tapOutside(0, 420);
    eq('插到盘子外面不算一步', A().state.count, 0);
    eq('外面这一下也记了音', A().audio.history[0].name, 'reject');
    ck('外面的 toast 说没落在饼摞里', text('#toast').includes('没落在饼摞里'), text('#toast'));
    // 焦边: flipping one pancake is legal, and it must change the face without moving the order.
    const burnt = rowOf('pk-burnt-1');
    await goto('pk-burnt-1');
    eq('焦边关模式', A().state.mode, 'burnt');
    eq('焦边开局堆叠与表一致', A().state.stack.join(','), burnt.stack.join(','));
    // Which faces start up is a measured property of the row, not a precondition of the mode:
    // pk-burnt-1 is 3,2,1 with every face already down, so the whole puzzle is order plus keeping
    // them down. Assert the table's own sides rather than assuming one is up.
    ck('焦边开局朝向就是表里那一份', A().state.sides.join(',') === burnt.burnt.join(','), `${A().state.sides.join(',')} vs ${burnt.burnt.join(',')}`);
    const sides0 = A().state.sides.join(',');
    clearToast();
    A().audio.stop();
    await tap(1);
    const st1 = A().state;
    eq('焦边关翻一张算一步', st1.count, 1);
    eq('翻一张不改顺序', st1.stack.join(','), burnt.stack.join(','));
    ck('翻一张改了焦面朝向', st1.sides.join(',') !== sides0, `${sides0} -> ${st1.sides.join(',')}`);
    ck('顶部焦面正好被翻过来', st1.sides[0] === 1 - burnt.burnt[0], `表 ${burnt.burnt[0]} -> 现 ${st1.sides[0]}`);
    ck('合法翻动不弹 toast', !$('#toast').classList.contains('on'), text('#toast'));
    ck('合法翻动记的是 flip 音', A().audio.history[0].name === 'flip', A().audio.history.map((x) => x.name).join(','));
    $('#btn-restart').click();
    await wait(80);
    eq('焦边重来后朝向复原', A().state.sides.join(','), burnt.burnt.join(','));
    eq('焦边重来后步数清零', A().state.count, 0);
    // Sound off: the notes still get recorded (the gate cannot listen), and the choice is persisted.
    $('#btn-sound').click();
    await wait(40);
    eq('音效按钮说关', $('#btn-sound').getAttribute('aria-pressed'), 'false');
    eq('音效开关写进了盘上', localStorage.getItem('pancake.sound.v1'), 'off');
    A().audio.stop();
    const beforeMuted = A().state.count;
    tapNow(1);
    await settle();
    eq('静音时照样留痕', A().audio.history.length, 1);
    eq('静音时留痕记的是 flip', A().audio.history[0].name, 'flip');
    eq('静音不改变这一铲是否合法', A().state.count, beforeMuted + 1);
    $('#btn-sound').click();
    await wait(40);
    eq('音效按钮说开', $('#btn-sound').getAttribute('aria-pressed'), 'true');
    eq('音效开也写进了盘上', localStorage.getItem('pancake.sound.v1'), 'on');
    return report({});
  };

  // ---------- hint ----------
  const hint = async () => {
    if (!(await ready())) return report();
    const id = 'pk-exp-1';
    const baked = rowOf(id);
    await goto(id);
    eq('起手唯一的高关卡', A().state.starts, 1);
    eq('par 7', A().state.par, 7);
    eq('开局没用提示', A().state.hints, 0);
    const h = A().hint();
    eq('提示交出的就是最优首步', h.k, A().optimal()[0]);
    eq('提示说的剩余步数', h.remaining, baked.par);
    eq('提示计数', A().state.hints, 1);
    ck('提示行写了铲几张', text('#hint-line').includes(`铲起 ${h.k} 张`), text('#hint-line'));
    ck('提示行承认这是答案', text('#hint-line').includes('最优首步'), text('#hint-line'));
    ck('提示行标了带提示', text('#hint-line').includes('带提示'), text('#hint-line'));
    ck('提示音留痕', A().audio.history.some((x) => x.name === 'hint'), A().audio.history.map((x) => x.name).join(','));
    await tap(h.k);
    eq('照着提示走了一步', A().state.count, 1);
    for (let i = 0; i < baked.par - 1; i++) {
      const g = A().hint();
      eq(`第 ${i + 2} 次提示仍与最优解一致`, g.k, A().optimal()[0]);
      eq(`第 ${i + 2} 次提示的剩余步数`, g.remaining, baked.par - i - 1);
      await tap(g.k);
      eq(`照提示走到第 ${i + 2} 步`, A().state.count, i + 2);
    }
    ck('连着照提示走会叠好', A().state.solved, A().state.moves.join('>'));
    eq('照提示走的步数就是 par', A().state.count, baked.par);
    eq('提示次数累加', A().state.hints, baked.par);
    eq('叠好后提示按钮禁用', $('#btn-hint').disabled, 'true');
    $('#btn-restart').click();
    await wait(80);
    eq('重来清掉步数', A().state.count, 0);
    eq('重来洗不掉带提示', A().state.hints, baked.par);
    const raw = JSON.parse(localStorage.getItem('pancake.progress.v1') || '[]');
    const rec = raw.find((r) => r.id === id);
    ck('带提示写进了存储', !!rec && rec.hinted === true, raw.map((r) => r.id).join(','));
    ck('带提示还没被写成通关', !!rec && !rec.solved, JSON.stringify(rec));
    localStorage.setItem('pancake.hinted.id', id);
    // An empty hint line after restart: the answer it handed out is gone with the tape.
    eq('重来后提示行清空', text('#hint-line'), '');
    return report({ hinted: id, hints: A().state.hints });
  };

  // ---------- hit ----------
  // Geometry the player can actually reach: every tap point the view claims must hit-test to the
  // canvas and resolve to the depth the view says it does.
  const hit = async () => {
    if (!(await ready())) return report();
    const id = 'pk-master-3';
    const baked = rowOf(id);
    const st0 = await goto(id);
    eq('六层焦边关', st0.n, 6);
    eq('par 10', st0.par, 10);
    const g = A().view.geom();
    const box = A().view.canvas.getBoundingClientRect();
    ck('画布有尺寸', box.width > 200 && box.height > 150, `${box.width}x${box.height}`);
    ck('geom.w 就是 CSS 宽度', Math.abs(g.w - box.width) < 1.5, `${g.w} vs ${box.width}`);
    ck('dpr 至少 1', g.dpr >= 1, g.dpr);
    ck('计数列在画布左边距内', g.x0 > 20, g.x0);
    let offCanvas = 0;
    let wrongDepth = 0;
    for (let k = 1; k <= st0.n; k++) {
      const p = A().view.pointFor(k);
      if (document.elementFromPoint(p.x, p.y) !== A().view.canvas) offCanvas++;
      if (A().view.depthAt(p.x, p.y) !== p.depth) wrongDepth++;
      eq(`点第 ${k} 张下面报的就是 k=${k}`, p.k, k);
      ck(`第 ${k} 铲的点在视口里`, p.x > 0 && p.x < innerWidth && p.y > 0 && p.y < innerHeight, `${p.x},${p.y}`);
    }
    eq('每一铲的点都落在画布上（错数）', offCanvas, 0);
    eq('命中深度与点一致（错数）', wrongDepth, 0);
    // The spatula cuts across the whole plate: depth depends on height, not on x. Asserting the rule
    // is the point — a narrower pancake still takes a tap at the far left, by design.
    let xDependent = 0;
    for (let k = 1; k <= st0.n; k++) {
      const p = A().view.pointFor(k);
      if (A().view.depthAt(box.left + 3, p.y) !== k - 1) xDependent++;
      if (A().view.depthAt(box.right - 3, p.y) !== k - 1) xDependent++;
    }
    eq('同一高度两端命中同一深度（错数）', xDependent, 0);
    const bottom = A().view.pointFor(st0.n);
    eq('盘子下面没有深度', A().view.depthAt(bottom.x, box.bottom - 1), -1);
    eq('饼摞上方的空隙不算深度', A().view.depthAt(bottom.x, box.top - 4), -1);
    eq('空档里点一下不记步', A().state.count, 0);
    clearToast();
    pointer('pointerdown', bottom.x, box.bottom - 1);
    pointer('pointerup', bottom.x, box.bottom - 1);
    await settle();
    eq('点到盘子下面不记步', A().state.count, 0);
    ck('点到盘子下面会说话', text('#toast').length > 0, text('#toast'));
    // Real taps across the whole stack, deepest first.
    const seenDepths = [];
    for (let k = st0.n; k >= 2; k--) {
      const before = A().state.count;
      const p = tapNow(k);
      await settle();
      seenDepths.push(p.depth + 1);
      eq(`点 k=${k} 记了一步`, A().state.count, before + 1);
      eq(`点 k=${k} 记的是 ${k}`, A().state.moves[A().state.count - 1], k);
      if (A().state.solved) break;
    }
    eq('逐层点过一遍', seenDepths.join(','), '6,5,4,3,2');
    A().restart();
    await wait(60);
    // Keyboard focus must reach exactly the depths the pointer can.
    $('#board').focus();
    eq('焦点在画布', document.activeElement.id, 'board');
    const d0 = A().state.focusDepth;
    eq('焦边关最小合法深度是 0', d0, 0);
    const c0 = A().state.count;
    key('Enter');
    await settle();
    eq('回车翻了一铲', A().state.count, c0 + 1);
    key('ArrowDown');
    const d1 = A().state.focusDepth;
    ck('下键往下走一层', d1 > d0, `${d0} -> ${d1}`);
    const c1 = A().state.count;
    key('Enter');
    await settle();
    eq('在选中的深度翻了', A().state.count, c1 + 1);
    eq('翻的就是那一层', A().state.moves[A().state.count - 1], d1 + 1);
    key('ArrowUp');
    key('ArrowUp');
    key('ArrowUp');
    ck('上键不会顶出栈顶', A().state.focusDepth >= 0, A().state.focusDepth);
    key('2');
    await settle();
    const afterDigit = A().state.count;
    ck('数字键直接点第 2 张', A().state.moves[A().state.count - 1] === 2, A().state.moves.join('>'));
    key('u');
    await wait(60);
    eq('U 撤销', A().state.count, afterDigit - 1);
    key('r');
    await wait(60);
    eq('R 重来', A().state.count, 0);
    eq('R 之后堆叠复原', A().state.stack.join(','), baked.stack.join(','));
    // A focused button keeps its own Enter: the page must not steal it and flip a pancake too.
    const c2 = A().state.count;
    $('#btn-undo').focus();
    $('#btn-undo').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await wait(60);
    eq('按钮上的回车不额外翻饼', A().state.count, c2);
    return report({ dpr: g.dpr, w: g.w });
  };

  // ---------- save ----------
  const save = async () => {
    if (!(await ready())) return report();
    const id = 'pk-appr-2';
    const baked = rowOf(id);
    await goto(id);
    localStorage.setItem('pancake.boot.origin.leg1', String(A().bootAt));
    A().solveAll();
    const settled = await settle(5000);
    ck('solveAll 走完后动画收尾', settled, 'view.busy never cleared');
    await wait(80);
    const st = A().state;
    ck('一步不差地叠好了', st.solved, st.moves.join('>'));
    eq('步数就是 par', st.count, baked.par);
    eq('提示次数 0', st.hints, 0);
    ck('收局页可见', shown('#win'));
    ck('对局页让位', !shown('#board-screen'));
    const raw = localStorage.getItem('pancake.progress.v1');
    ck('存储写了东西', !!raw && raw.length > 4, raw);
    const parsed = JSON.parse(raw);
    ck('存储是一条条记录', Array.isArray(parsed), typeof parsed);
    const rec = parsed.find((r) => r.id === id);
    ck('通关记录在盘上', !!rec, raw);
    eq('记录的最佳步数', rec.best, baked.par);
    eq('记录三星', rec.stars, 3);
    eq('记录没带提示', rec.hinted, 'false');
    eq('记录标了通关', rec.solved, 'true');
    eq('记录层数', rec.n, baked.n);
    eq('记录模式', rec.mode, baked.mode);
    ck('记录没有字段膨胀', JSON.stringify(rec).length < 220, JSON.stringify(rec));
    ck('本局记录数至少 1', st.records >= 1, st.records);
    ck('存储没有报错', st.problems.length === 0, st.problems.join(','));
    localStorage.setItem('pancake.solved.id', id);
    localStorage.setItem('pancake.solved.best', String(baked.par));
    return report({ bytes: (raw || '').length, id, records: parsed.length });
  };

  // ---------- reloaded ----------
  // This leg only means something if the document really died. verify.sh loads a fresh URL per leg,
  // and the timeOrigin witness below is what proves it rather than assuming it.
  const reloaded = async () => {
    if (!(await ready())) return report();
    const leg1 = Number(localStorage.getItem('pancake.boot.origin.leg1'));
    ck('上一腿留了 timeOrigin 证人', leg1 > 0, leg1);
    ck('这确实是一个新文档', Math.abs(A().bootAt - leg1) > 1, `${leg1} vs ${A().bootAt}`);
    eq('bootAt 就是本页 timeOrigin', A().bootAt, performance.timeOrigin);
    const raw = localStorage.getItem('pancake.progress.v1');
    ck('存档活过了重载', !!raw, raw);
    const parsed = JSON.parse(raw || '[]');
    const solvedId = localStorage.getItem('pancake.solved.id');
    const hintedId = localStorage.getItem('pancake.hinted.id');
    const rec = parsed.find((r) => r.id === solvedId);
    ck('通关记录读回来了', !!rec, raw);
    const best = Number(localStorage.getItem('pancake.solved.best'));
    eq('最佳步数读回来了', rec && rec.best, best);
    const hrec = parsed.find((r) => r.id === hintedId);
    ck('带提示标记读回来了', !!hrec && hrec.hinted === true, JSON.stringify(hrec));
    ck('带提示没被写成通关', !!hrec && !hrec.solved, JSON.stringify(hrec));
    eq('重载后还是从菜单开始', document.body.dataset.screen, 'menu');
    ck('菜单卡片标了通关', !!$(`#tier-list .card[data-id="${solvedId}"].done`), [...document.querySelectorAll('#tier-list .card')].filter((c) => c.classList.contains('done')).map((c) => c.dataset.id).join(','));
    const hintedCard = $(`#tier-list .card[data-id="${hintedId}"]`);
    ck('带提示的卡片还在', !!hintedCard, hintedId);
    ck('带提示的卡片说了带提示', !!hintedCard && (hintedCard.textContent || '').includes('带提示'), hintedCard && hintedCard.textContent);
    await goto(solvedId);
    eq('最佳显示在 HUD', text('#hud-best'), String(best));
    eq('重开这一关步数还是 0', A().state.count, 0);
    ck('存储没报警', A().state.problems.length === 0, A().state.problems.join(','));
    // The record shape on disk is the array the store writes, not a nested blob it hopes for.
    ck('盘上是记录数组', Array.isArray(parsed) && parsed.every((r) => typeof r.id === 'string'), typeof parsed);
    return report({ records: parsed.length, solvedId, hintedId });
  };

  // ---------- theme ----------
  // A palette change has to show up in pixels, not only in a data attribute.
  const theme = async () => {
    if (!(await ready())) return report();
    A().setTheme('dark');
    await wait(60);
    await goto('pk-burnt-2');
    const st = A().state;
    ck('焦边关有焦面朝上的饼', st.sides.includes(1), st.sides.join(','));
    const up = st.sides.findIndex((s) => s);
    const p = A().view.pointFor(up + 1);
    const band = { x: p.rect.x + p.rect.w / 2, y: p.rect.y + 2 };
    const plate = A().view.platePoint();
    A().setTheme('dark');
    await wait(80);
    eq('暗色写进了 html', document.documentElement.dataset.theme, 'dark');
    const darkPlate = token('--plate');
    const darkText = token('--ink');
    const darkDim = token('--ink-dim');
    const bandDark = px(band.x, band.y);
    const plateDark = px(plate.x, plate.y);
    ck('暗色焦边像素贴合 --pancake-burnt', near(bandDark, rgb(token('--pancake-burnt')), 26), `${bandDark} vs ${token('--pancake-burnt')}`);
    ck('暗色盘子像素就是 --plate', near(plateDark, rgb(darkPlate), 12), `${plateDark} vs ${darkPlate}`);
    ck('盘子像素不是空画布', plateDark.some((c) => c > 0), plateDark.join(','));
    A().setTheme('light');
    await wait(80);
    eq('亮色写进了 html', document.documentElement.dataset.theme, 'light');
    const lightPlate = token('--plate');
    ck('亮色 --plate 真的换了', lightPlate !== darkPlate, `${darkPlate} -> ${lightPlate}`);
    ck('亮色 --ink-dim 真的换了', token('--ink-dim') !== darkDim, darkDim);
    const plateLight = px(plate.x, plate.y);
    ck('亮色盘子像素贴合新的 --plate', near(plateLight, rgb(lightPlate), 12), `${plateLight} vs ${lightPlate}`);
    ck('画布跟着换了颜色', plateLight.join(',') !== plateDark.join(','), `${plateDark} -> ${plateLight}`);
    ck('饼的颜色不随灯换（烙饼还是那张烙饼）', near(px(band.x, band.y), bandDark, 6), `${bandDark} -> ${px(band.x, band.y)}`);
    ck('饼身两色下都画了', px(p.rect.x + p.rect.w / 2, p.rect.y + p.rect.h - 3).some((c) => c > 0), px(p.rect.x + p.rect.w / 2, p.rect.y + p.rect.h - 3).join(','));
    // body's background is a gradient of two tokens, so ask the computed style for the stop colours
    // rather than for a backgroundColor that is legitimately transparent.
    const bgImg = getComputedStyle(document.body).backgroundImage;
    ck('背景渐变里就是 --bg 与 --bg-2', bgImg.includes(rgbStr(token('--bg'))) && bgImg.includes(rgbStr(token('--bg-2'))), bgImg);
    eq('正文颜色就是 --ink', getComputedStyle(document.body).color, rgbStr(token('--ink')));
    ck('亮色下 --ink 换了', token('--ink') !== darkText, darkText);
    A().setTheme('auto');
    await wait(60);
    ck('auto 解析成具体一套', ['light', 'dark'].includes(document.documentElement.dataset.theme), document.documentElement.dataset.theme);
    eq('auto 记的是 auto', A().state.theme, 'auto');
    ck('偏好写进了存储', ['auto', 'light', 'dark'].includes(localStorage.getItem('pancake.theme.v1')), localStorage.getItem('pancake.theme.v1'));
    // The buttons still reach the player after a repaint, and the theme cycle wraps.
    const b = $('#btn-hint').getBoundingClientRect();
    ck('提示按钮可达', document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) === $('#btn-hint'));
    const before = A().state.theme;
    $('#btn-theme').click();
    await wait(60);
    ck('主题按钮换了一套', A().state.theme !== before, `${before} -> ${A().state.theme}`);
    eq('按钮记着当前档', $('#btn-theme').dataset.scheme, A().state.theme);
    ck('循环三档都会回来', (() => {
      const seen = [A().state.theme];
      for (let i = 0; i < 4; i++) {
        $('#btn-theme').click();
        seen.push(A().state.theme);
      }
      return new Set(seen).size === 3;
    })(), 'cycling the theme button never covered all three schemes');
    A().setTheme('dark');
    await wait(60);
    return report({ dark: darkPlate, light: lightPlate });
  };

  // ---------- win ----------
  const win = async () => {
    if (!(await ready())) return report();
    const id = 'pk-warm-1';
    const baked = rowOf(id);
    await goto(id);
    const path = A().optimal();
    eq('最优解长度 3', path.length, 3);
    for (const k of path) await tap(k);
    await wait(120);
    ck('收局页显示', shown('#win'), document.body.dataset.screen);
    eq('收局标题', text('#win-h'), '叠好了');
    const s1 = winStats();
    eq('收局统计：步数 / par', s1['步数 / par'], `${baked.par} / ${baked.par}`);
    eq('收局统计：偏离下界', s1['偏离下界'], '0（正好是量出来的下界）');
    eq('收局三星', s1['评级'], '★★★');
    eq('收局记了没用提示', s1['提示'], '没用');
    eq('收局统计关卡名', s1['关卡'], `${baked.tierName} · ${baked.id}`);
    ck('收局说明讲了下界', text('#win-note').includes('下界'), text('#win-note'));
    const c = A().state.count;
    clearToast();
    tapNow(baked.n);
    await settle();
    eq('叠好之后再铲不加步数', A().state.count, c);
    ck('叠好之后再铲会说话', text('#toast').includes('已经叠好了'), text('#toast'));
    ck('叠好之后再铲不算新游戏', A().state.solved, A().state.moves.join('>'));
    const nextId = E().LOTS[E().LOTS.findIndex((r) => r.id === id) + 1].id;
    $('#btn-after-win').click();
    await wait(140);
    eq('下一关走了', A().state.id, nextId);
    ck('回到对局页', shown('#board-screen'));
    // Now finish one badly, on purpose: the grade has to be able to say "you paid for it".
    // starts=1 + detour=1 is what makes the arithmetic exact: the only non-detour opening is the one
    // optimal move, and every other opening leaves par flips still to do, so the run is par+1.
    const sloppy = 'pk-reg-1';
    const sBaked = rowOf(sloppy);
    await goto(sloppy);
    eq('歪一步用的关卡起手唯一', sBaked.starts, 1);
    eq('歪一步用的关卡 detour 就是 1', sBaked.detour, 1);
    const good = A().optimal();
    const legalK = [];
    for (let k = sBaked.mode === 'burnt' ? 1 : 2; k <= sBaked.n; k++) legalK.push(k);
    const badK = legalK.find((k) => k !== good[0]);
    await tap(badK);
    eq('第一铲走歪了', A().state.moves.length, 1);
    ck('歪的那一铲不是最优首铲', badK !== good[0], `${badK} vs ${good[0]}`);
    for (const k of A().optimal()) await tap(k);
    await wait(120);
    const st = A().state;
    eq('歪一步后的总步数', st.count, sBaked.par + 1);
    eq('偏离 +1', st.over, 1);
    const s2 = winStats();
    eq('两星', s2['评级'], '★★☆');
    ck('偏离格标了 bad', $('#hud-over').classList.contains('bad') || s2['偏离下界'].startsWith('+'), s2['偏离下界']);
    ck('说明写了多花几步', text('#win-note').includes('多花了 1 步'), text('#win-note'));
    const rec = A().progress()[sloppy];
    eq('存档记下这次步数', rec.best, sBaked.par + 1);
    eq('存档星数', rec.stars, 2);
    ck('存档没把带提示写成假', rec.hinted !== true, JSON.stringify(rec));
    // Best is a minimum over runs, not the last run: replay it perfectly and it has to come down.
    await goto(sloppy);
    for (const k of A().optimal()) await tap(k);
    await wait(120);
    eq('打满 par 后最佳被改写', A().progress()[sloppy].best, sBaked.par);
    eq('重打一遍星数升回三星', A().progress()[sloppy].stars, 3);
    // The last campaign level hands back the menu instead of running off the table.
    const last = E().LOTS[E().LOTS.length - 1];
    await goto(last.id);
    A().solveAll();
    await settle(6000);
    await wait(120);
    ck('最后一关也能收', shown('#win'), A().state.moves.join('>'));
    eq('最后一关 par', A().state.count, last.par);
    $('#btn-after-win').click();
    await wait(160);
    eq('最后一关的下一关回菜单', document.body.dataset.screen, 'menu');
    return report({ sloppyPar: sBaked.par, last: last.id });
  };

  // ---------- layout ----------
  const layout = async () => {
    if (!(await ready())) return report();
    const id = 'pk-reg-3';
    const baked = rowOf(id);
    await goto(id);
    const box = A().view.canvas.getBoundingClientRect();
    const g = A().view.geom();
    const vw = window.innerWidth;
    ck('画布铺满容器', box.width > vw * 0.4, `${box.width} of ${vw}`);
    ck('画布没超出视口', box.right <= vw + 1 && box.left >= -1, `${box.left}..${box.right} vs ${vw}`);
    ck('没有横向溢出', document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, `${document.documentElement.scrollWidth}/${document.documentElement.clientWidth}`);
    ck('geom 与盒一致', Math.abs(g.w - box.width) < 1.5, `${g.w} vs ${box.width}`);
    ck('高度按 0.72 比例', Math.abs(box.height - g.w * 0.72) < 2, `${box.height} vs ${g.w * 0.72}`);
    ck('画布宽不超过装置上限', g.maxW > 60 && g.x0 + g.maxW <= g.w, `${g.x0}+${g.maxW} of ${g.w}`);
    eq('HUD 五格', document.querySelectorAll('#hud .hud-cell').length, 5);
    let hudBad = 0;
    for (const cell of document.querySelectorAll('#hud .hud-cell')) {
      const r = cell.getBoundingClientRect();
      if (r.width < 24 || r.height < 20) hudBad++;
    }
    eq('HUD 每格都有尺寸（坏格数）', hudBad, 0);
    eq('HUD 关卡名', text('#level-name'), `${baked.tierName} · ${baked.id}`);
    eq('HUD par', text('#hud-par'), String(baked.par));
    eq('HUD 关号写在 data 上', $('#board-screen').dataset.id, id);
    eq('HUD 层数写在 data 上', $('#board-screen').dataset.n, String(baked.n));
    const labels = ['undo', 'restart', 'hint', 'next'];
    let unreachable = 0;
    let clipped = 0;
    const seen = [];
    for (const name of labels) {
      const b = $(`#btn-${name}`);
      const r = b.getBoundingClientRect();
      seen.push([Math.round(r.left), Math.round(r.top), Math.round(r.width)]);
      if (document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) !== b) unreachable++;
      if (r.right > vw + 1 || r.left < -1 || r.width < 30 || r.height < 22) clipped++;
    }
    eq('四个控件都点得到（够不着数）', unreachable, 0);
    eq('四个控件都没被裁（越界数）', clipped, 0);
    ck('说明面板可达', shown('#how'));
    eq('隐藏的关卡表占位为 0', $('#menu').getClientRects().length, 0);
    eq('隐藏的收局页占位为 0', $('#win').getClientRects().length, 0);
    const hl = $('#hint-line').getBoundingClientRect();
    const bw = $('#board-wrap').getBoundingClientRect();
    ck('提示行在对局面板内', hl.top >= bw.top - 1 && hl.left >= bw.left - 1 && hl.right <= bw.right + 1, `${hl.left}..${hl.right} of ${bw.left}..${bw.right}`);
    eq('提示行不吃指针事件', document.elementFromPoint(hl.left + hl.width / 2, hl.top + hl.height / 2), A().view.canvas);
    const narrow = vw <= 520;
    // verify.sh asks for a phone viewport through Emulation, and an override that silently did not
    // apply would leave this leg re-running the desktop checks while reporting green.
    if (new URLSearchParams(location.search).get('want') === 'narrow') {
      ck('窄视口覆写真的生效了', narrow && window.devicePixelRatio >= 2, `${vw} / dpr ${window.devicePixelRatio}`);
    }
    if (narrow) {
      const [a, , c] = seen;
      ck('窄屏下控件换行而不是压扁', c[1] > a[1], JSON.stringify(seen));
      ck('窄屏 dpr 生效', A().view.geom().dpr >= 2, A().view.geom().dpr);
      ck('窄屏藏掉了键盘提示', !shown('#kbd-hint'));
      eq('窄屏 HUD 三列', getComputedStyle($('#hud')).gridTemplateColumns.split(' ').length, 3);
    } else {
      const [a, b] = seen;
      ck('宽屏下四个控件同排', Math.abs(a[1] - b[1]) < 2, JSON.stringify(seen));
      ck('键盘提示可见', shown('#kbd-hint'));
      ck('键盘提示说的是深度与翻', text('#kbd-hint').includes('选深度'), text('#kbd-hint'));
    }
    // A flip at this size must still hit the intended pancake.
    const before = A().state.count;
    await tap(baked.n);
    eq('点最底一张仍然记一步', A().state.count, before + 1);
    eq('记的就是最底那一铲', A().state.moves[A().state.count - 1], baked.n);
    return report({ vw, dpr: g.dpr, narrow });
  };

  w.__ng = { boot, table, menu, play, pause, reject, hint, hit, save, reloaded, theme, win, layout };
})(window);
