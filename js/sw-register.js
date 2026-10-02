// 注册离线壳。整段包在协议判断里：file:// 打开（把仓库拷下来双击 index.html）时
// navigator.serviceWorker 是在的，但 origin 为 null，注册一定抛 —— 那不是玩家的错，
// 不该在控制台留一条红。注册失败同样静默：游戏本身能跑就是能玩。
'use strict';

if (
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator &&
  /^https?:$/.test(location.protocol)
) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
