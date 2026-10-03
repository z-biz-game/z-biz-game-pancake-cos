# 烙饼 Pancake · 前缀翻转排序

一摞大小各不相同的饼。一次操作只能把铲子插到某张饼**下面**，把那张饼和它上面的一切整段翻回来。
目标是从小到大叠齐（最小的在顶上）；焦边关卡还多一条：每张饼烙焦的那一面最后必须朝下。

这个仓存在的理由只有一句话：**每一关的 `par` 是把那一级的全部局面做完一次广度优先之后量出来的
真下界**，不是"某个解法用了几步"，也不是启发式估计。三层普通 6 个局面、八层普通 40 320 个、六层
焦边 46 080 个——每一个都访问过，出货表里的每个数字都是这张距离场的读数。

本文里的数字只有两类来源：仓里读得到的代码，和闸跑出来的读数（本机 node v26.8.1 / macOS 26.6.2 /
Chrome 154.0.8037.57 / Apple M5 Pro 15 核）。命令是 `node tools/bake.mjs --check`、
`npm test`（六套 61 / 148 / 92 / 49 / 33 / 48 条，2026-10-04 复跑 `_tmp-pancake-node-r1.log` 六个 rc 全 0）、
`bash tools/verify.sh`（**双 URL 形态各 14 腿 · 412 条 · 0 failed**，`_tmp-pancake-verify-r1.log`
… `r5.log`；同一份闸连跑五遍逐腿条数逐位一致 `15,22,28,44,24,32,45,49,18,16,22,45,25,27`，
五遍都 `=== ALL GREEN ===`，r5 跑在提交前的定稿树上；逐腿对账 `_tmp-pancake-rerun-compare-r3.log`，
`IDENTICAL_PER_LEG(5 passes x 2 shapes)= yes`，10 个形态-跑次全部对齐）。

这条闸曾经**瞎过一阵**，形状值得写下来：`136893d`（暂停真冻结）在 `js/main.js` 末尾又赋了一次
`window.pancake = {…}`，把整个台面换成一个只有四个键的对象。旧 preflight 只读 `version`，而换掉的
那一半里恰恰没有 `version` ⇒ 它打印出 `boot: pancake undefined` 却照样放行，13 条腿全在第一条
断言之前抛 TypeError ⇒ `shape=root: 0/13 legs reported · 0 checks · 0 failed`，CI run#4/#5/#6 三连红，
而 Pages 每轮照旧 `success`。**游戏本身没坏**：同一时段打线上站点的那把量尺里，pancake 在 390×844
档 `no-x`、35 枚控件 0 枚低于 44px 指尖下限（`_tmp-live-sweep-r19.log`；那一跑的 320 档确实横向
出屏，那是 `1497286` 修掉的动作条，与这条瞎掉的闸无关），坏的是量具。
现在台面只有一个赋值，preflight 与 `ready()` 审的是腿真正要读的那八个字段，缺谁就点名谁。

台面修复这一笔（commit `7086ee6`，2026-10-03 20:21Z 推送）远端两层都绿过，而且是这条闸活着的时候
第一次绿：Actions 上 CI run#7 与 Deploy to GitHub Pages run#7 均 `completed / success`，CI 的两个
job 里 `syntax + engine guarantees` 8 个 step、`real browser gate (both URL shapes)` 的
`Browser gate (root + prefix)` step 全 success，那一步在 runner 上走了 54 s（20:21:25 → 20:22:19，
本机整跑 42 s，量级一致）。CI 的 unit job 跑在 Node 20、browser job 跑在 Node 22，那两个版本上的
第一手证据就是那一跑，本机没有装 20 或 22。
**部署件那一跑也重做了**（`BASE_URL=https://z-biz-game.github.io/z-biz-game-pancake-cos/ bash tools/verify.sh`
→ `_tmp-pancake-deployed-r1.log`）：`shape=custom: 14/14 legs reported · 412 checks · 0 failed`、
`=== ALL GREEN ===`、`PAN_DEPLOYED_RC=0`，逐腿条数与本机两形态的五遍逐位一致
（`15,22,28,44,24,32,45,49,18,16,22,45,25,27`），`[pause]` 腿在线上读到的也是同一套时间量
（`tPause=0.166 / gapMs=42 / jumpedMs=40`，上限 `gap+60`）。此前 `cf1597a` 那一跑的
`13/13 legs · 388 checks` 是加腿之前的读数，留着不改。runner 自己打印的条数**仍然没取到**：
`/actions/jobs/<id>/logs` 的签名 URL 这一轮回 401（上一轮是 TLS 抖与 403），所以上面只引 step 状态
与耗时，不代 runner 报条数。

**代码 > 本文档**：本文与 `js/`、`tools/` 冲突时，以代码和它跑出来的输出为准。

---

## 规则（玩家视角）

1. **一铲 = 前缀翻转**。插到深度 `d`（从 0 数）的饼下面，翻起的是最上面 `k = d + 1` 张。画布左列
   写的数字就是"这一铲翻几张"。
2. **普通关不许只翻一张**：`k ≥ 2`。翻一张等于什么都没动，所以它不是步数，是一次拒绝
   （`js/engine/perms.js` 的 `minFlip`）。
3. **焦边关 `k ≥ 1` 合法**：那一铲虽然不改顺序，但会把顶上的饼翻面。三层焦边图少了它就断（禁掉
   `k=1` 只剩 48 个里的 12 个可达），四层往上剩下的翻法本来就走得到每一摞——两个读数都在
   `test/graph.test.mjs` 里量过。
4. **判胜**：普通关只看顺序 `1..n`；焦边关要顺序齐 **且** 每张饼焦面朝下
   （`js/engine/rules.js` 的 `solved` / `isGoal`）。所以"顺序已经对了但有一面焦面朝上"这一盘
   **没赢**，画布上也确实把那条焦边画在顶边。
5. 界面不许说引擎没算过的数：`par` / `starts` / `detour` / 状态数全部来自 `js/data/lots.js` 或
   距离场本身，说明面板里那句"起手只有 N 种翻法不绕路，最坏的第一铲要多花 M 步"也是读数不是形容词。

## 怎么玩

- **鼠标**：点某张饼的下沿。手抬起的位置就是深度，按下时画一条铲位虚线。
- **键盘**：`↑` / `↓` 选深度，`Enter` / `空格` 翻这一铲，`U` 撤销、`R` 重来、`H` 提示、`1`–`9`
  直接翻第 N 张。焦点必须在画布上 `Enter` 才算翻——按钮上的回车归按钮自己
  （`js/main.js` 的键盘分支只认 `ev.target === #board`）。
- **提示是真答案**：它给的是从当前局面出发的一条最短路径的首步，读的就是出货时同一张表。所以用过
  一次提示的这一关会**永远**标着"带提示"，`重来` 洗不掉（计数在 `js/game.js` 里，restart 只清
  步数带），而且**不算通关**——记录里 `solved` 保持 false（`js/main.js` 的 `onWin`）。已经干净
  通关过的关，之后再求助不会被倒扣成"没通"。
- **随机一局**：按同一口径现场出题、现场算 par，种子写进地址栏（`#pk-<档>-r<36 进制种子>`），
  粘贴给别人就能原样复现。"换一局"用的计数器存在本地（`pancake.seed.v1`），**不是日期函数**——
  按钮说"换一局"的时候必须真的换一盘。
- **两套配色 + 音效**：`◐` 循环 `自动 → 亮 → 暗`，`♪` 开关音效。配色改变的是画布上的盘子颜色
  （`--plate`），饼本身的颜色不随灯换：烙饼还是那张烙饼。
- 本地一共四个键：`pancake.progress.v1`（进度）、`pancake.theme.v1`、`pancake.sound.v1`、
  `pancake.seed.v1`。进度那份是记录数组，读的时候会**逐条**解析：一条坏了只丢一条，
  不重置整个存档（`js/store.js`）。

## 关卡阶梯（六档 23 关，全部现场可复核）

| 档 | 名字 | 出货 | 谓词（`js/engine/tiers.js`） |
| --- | --- | --- | --- |
| warm | 灶前热身 | 4 | 三层 par ≥ 2 收 3 张；四层 par 3 且起手唯一收 1 张 |
| appr | 学徒 | 3 | 四层 par 4 —— 全图只有 3 个这种局面 |
| reg | 熟手 | 4 | 五层 par 5 起手 ≤ 2 收 2；六层 par 6 起手唯一收 2 |
| exp | 高手 | 4 | 七层 par 7、八层 par 8，都要起手唯一 |
| burnt | 焦边 | 4 | 三层焦边 par ≥ 5 起手 ≤ 2；四层焦边 par ≥ 7 起手 ≤ 3 |
| master | 烙饼师 | 4 | 五层焦边 par ≥ 9；六层焦边 par 10 且起手唯一 |

"起手唯一"是 15 个合法翻法里只有 1 个不绕路（八层那两关 `detour` 为 1 或 2，界面把最坏第一铲的
代价写在说明里，但不告诉你哪一步是最优）。**难度不靠"看起来难"**：每条谓词都由 `bake.mjs` 现场
判定，填不满配额就直接抛错，绝不静默放宽。

## 这几条承诺，每一条怎么变成一条会红的命令

| 承诺 | 怎么检查 |
| --- | --- |
| par 是全图 BFS 的真下界 | `node tools/bake.mjs --check`：重新建图、重新访问、逐行重算 par/starts/detour/堆叠/焦边，与出货表对不上就红（几十毫秒，读数只在 DESIGN §11 记一处） |
| 出货表在浏览器里也是同一份 | `[table]` 腿在 Chrome 里再调一次 `checkRows`；并且当场改坏一行（抬高 par、颠倒堆叠、code 出状态空间、塞一个 par 0）证明这把闸**有牙** |
| 数学口径没漂 | `test/graph.test.mjs` 对 P₁…P₉ = 0,1,3,4,5,7,8,9,10 与 B₂…B₇ = 4,6,8,10,12,14 逐个数；另在 n=6/8 普通与 n=5 焦边上验 `measure()` 对每个 code 都复现距离场 |
| 拒绝一次必须可见、可听、可记 | `[reject]` 腿：toast 文案、`#board` 的 shake 类、`audio.history` 里记的是 `reject` 不是 `flip`、步数一格没加 |
| 存档活过真实重载 | `[save]` + `[reloaded]` 两腿，后者比对 `performance.timeOrigin` 证人，确认自己读的是一个新文档而不是上一腿 |
| 命中几何只在真浏览器里可证 | `[hit]` 腿：每个 `pointFor(k)` 的客户端坐标必须 `elementFromPoint` 命中画布本身，且 `depthAt` 只认高度不认横坐标 |
| 换皮真的换了像素 | `[theme]` 腿：读 `--plate` 的 computed 值，再读画布上盘子位置的像素，两者对齐；切亮色时盘子像素必须移动而焦边像素不动 |
| 窄屏不是把桌面压扁 | 同一条 `layout` 腿在 `Emulation` 的 380×780@2 视口里再跑一遍，并且先断言覆写真的生效（视口 ≤ 520 且 dpr ≥ 2） |
| 暂停真的把仿真冻住 | `[pause]` 腿按玩家那枚 `#btn-pause`：`view.animProgress()` 必须**逐位停在按下那一刻**、画布上那张饼的像素不变；恢复走键盘 `p`，判据是"恢复后视觉上多走的 ≤ 恢复之后**实测**过去的那段时间 + 一帧余量"——式子挂在 CSS 的 `--dur-flip` 与两个 `performance.now()` 实测值上，不挂 340 / 40 这种抄来的数（共享 runner 上 `setTimeout` 会漂，写死的带会把一台慢机器判成缺陷）。K1 刀（不后移 `anim.start`）红这一条，读数 `视觉上 340ms / 恢复后又过了 42ms`；K2 刀（标志位不落地）红 7 行，含按钮字形与 `aria-pressed` |
| 量具真的对着本仓发力 | preflight 读的不是"`window.pancake` 在不在"，而是腿真正要读的八个字段（`version/engine/state/go/view/optimal/hint/solveAll`）。K3 刀把台面换成半个对象 ⇒ boot 那一行就点名 `missing:version,engine,…` 并停止开腿，不再放行到 13 条腿里各自抛 TypeError 交回 0 条断言。三把刀在 `_tmp-pancake-knife-r3.log`，`K1 GATE_RC=1 · 点名行=1`／`K2 GATE_RC=1 · 点名行=7`／`K3 GATE_RC=1 · 点名行=1` |

浏览器闸跑**两种 URL 形态**：`server.cjs` 把仓库当文档根（`http://127.0.0.1:5266/`），以及
Pages 的形状（一个只含符号链接的目录做根，仓库在路径的一段下面）。只有第二种能看见"绝对
`/js/…` 在部署后 404"这种缺陷。部署件本身另跑一遍：
`BASE_URL=https://z-biz-game.github.io/z-biz-game-pancake-cos/ bash tools/verify.sh`。

## 命令

```bash
npm run check          # node --check 每个源文件（js/ server.cjs tools/ test/）
npm test               # 六套引擎与页面模型测试，431 条断言
npm run check:data     # node tools/bake.mjs --check：重算整张出货表
npm run bake           # 重新出题并写 js/data/lots.js（改 tiers.js 之后才需要）
npm start              # node server.cjs（默认 5266）
npm run verify         # 真 Chrome + 脚本化情景，双形态
SCENARIOS="play hint" ./tools/verify.sh
SHAPES=root ./tools/verify.sh
SHOTS=v1 ./tools/verify.sh          # 顺手写 tools/shots/*.png
```

零依赖：没有 `node_modules`，没有构建步骤，`js/` 就是浏览器里跑的那份。

## 已知边界（做不到的事，写清楚而不是藏起来）

- **直径处几乎买不到"起手唯一"**，而且方向是反的：越远的环，最优首铲越多。普通六层的 2 个对跖点
  各有 5 种、七层 35 个各有 5–6 种、八层 455 个最少也有 3 种；六层焦边全图只有 1 个局面在直径 12 上，
  它有 6 种。所以高手／烙饼师这两档把 `par` 停在直径下一到两步，用 `starts === 1` 换陡峭度。
  这不是定理：五层普通图直径 5 上的 20 个局面里有 5 个起手唯一，`pk-reg-1` 就出货了其中一个
  （`par 5 = 直径 5` 且 `starts 1`）。两侧都在 `test/graph.test.mjs` 里断言，注释不能大得过数据。
- 出货最重的一摞是**八层**（40 320 个局面）。九层 362 880 只在测试里跑，不在关卡表里。
- 六层焦边是出货的最重焦边阵（46 080）；七层焦边 645 120 个局面没进表，也没进 CI 的墙钟。
- 浏览器闸需要本机有 Chrome（或设 `CHROME_BIN`）。它读画布像素、发真指针事件，所以没有 jsdom 替代。
- 提示给的是答案不是方向：一旦用过，这一关在这一台机器上就永久带标记。这是设计，不是 bug。
- **暂停冻的是仿真，不是模型**。本仓没有计时器，唯一持续推进的仿真就是翻牌那一段缓动（`anim.t` 靠
  `performance.now()` 的差推进），所以暂停 = 停掉 rAF 心跳、恢复时把 `anim.start` 后移暂停时长。
  按下暂停后**仍然下得去手**：那一铲走 `view.animateFlip` 的暂停分支直接落定、不排缓动（`[pause]` 腿
  把这两条都写成断言，改天想挡输入得先改这条边界）。

## 上线的到底是哪一批文件

这个仓没有打包器：站点=一次文件拷贝。以前「拷哪些」写在 `pages.yml` 的 `run:` 里（手抄的几行
`cp`）。本地 `index.html` 直读仓库根，永远自洽；线上却按那份清单拷，于是页面后来引用的
`manifest.webmanifest`、`sw.js`、`icons/*` 可能一个都没上去——线上 404，而仓里的引擎测试与
真浏览器闸全绿，因为它们跑的都是仓库根，没有任何一步在「按清单拷」的那个环境下加载过页面。

现在清单只有一份，住在 `tools/assemble-site.sh`：CI 调它拷 `_site`，本地闸调它拷临时目录，
然后**对拷出来的产物**提要求（`tools/deploy-set.mjs`）：

- **W 清单与页面同源**：`pages.yml` 里必须真有 `run: bash tools/assemble-site.sh <dir>` 这一行，
  `ci.yml` 里必须真有 `run: node tools/deploy-set.mjs`。认的是调用那一行，不是文件里出现过这个
  路径——注释里本来就会写它，只 grep 字符串会被一句散文喂绿。
- **R 引用可达**：引用不靠手打名单。从 `index.html` 的 `href/src` 出发，凡解析出来是 `.js`/`.css`
  的就把那一站也扫一遍（CSS 的 `url()`、JS 去掉注释后的 `'./…'` 字面量、`new URL(x, base)` 的两种
  基、`navigator.serviceWorker.register`、`scope`），`manifest` 的 icons/screenshots/shortcuts 各自
  的 `src` 也算引用。取径上读不到的那一站本身就是红（读不到＝这一站根本没扫）。每条引用都必须在
  产物里且非 0 字节；绝对路径单列一条红，因为 Pages 挂在 `/<repo>/` 前缀下会跳出去。
- **P 位图不许说谎**：`manifest` 声明的 `sizes` 必须等于 PNG IHDR 的真实宽高。
- **钉住两个数**：`EXPECT_CHECKS=32`（R 段实际检查的路径条数）与 `EXPECT_ROWS=50`
  （这一次跑的断言条数）。没改页面却掉了，说明解析断了；删掉一张图标会同时少一条 R10 与那张的
  P1/P2，所以两个数一起钉，rows 能漂就是闸在缩水的信号。

`tools/deploy-set-selftest.mjs` 是这两颗钉的阳性证明：它把仓库复制到临时目录，照着每一类断言
各下一刀（X1 清单不收位图目录 / X2 模块边改名 / X3 CSS 写绝对路径 / X4 `start_url` 绝对 /
X5 删光 >=512 图标 / X6 少一个必填字段 / X7 声明尺寸与真图不符 / X8 workflow 不调脚本 /
X9 CI 不跑闸 / X10 是阴性对照——往入口 JS 追加一行只写在注释里的假路径，闸必须仍然绿、条数仍然
`32`、rows 仍然 `50`；X11 og:image 退回相对路径 / X12 og:image 的前缀指向别的 slug），
要求每一刀都让闸**点名**变红。靶子从 `DEPLOY_SET_DUMP=1`
的出处表现挑，所以页面改了、仓与仓不同，台架跟着走。

`node tools/deploy-set.mjs` 与 `node tools/deploy-set-selftest.mjs` 就是 CI 跑的那两条命令本身
（package.json 里的 `deploy-set` / `deploy-set:selftest` 只是同一支脚本的 npm 入口）；把它们接进本仓
那条浏览器 one-shot（`tools/verify.sh`）还欠着——那道脚本的腿名单与条数钉是每个仓自己的形状。
