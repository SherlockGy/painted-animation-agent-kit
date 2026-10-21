// chapters.js：按章模式（可选，src/config.js 里 CHAPTERS 非空时生效，见指南"按章独立制作（可选）"一节）。
// 每章 = 一张标题卡（CARD 秒）+ 正片（len 秒）。场景文件用 chapter(n, [[u0, fn], ...]) 登记本章的镜头：
// u0 是本章正片时间（0 = 标题卡结束），fn(u, lu, dur) 收到的 u 也是本章正片时间，所以改一章的长度不会挪动别的章。
// 章与章之间不做跨章的连续镜头，每章自成一段：标题卡用笔刷揭开、擦到正片；每章最后 CH_OUT 秒用笔刷盖住（最后一章除外），
// 下一章的标题卡再揭开。这样每章可以单独改、单独渲染，接缝处也不会戛然而止。
const CH_WIPE = .3;   // 标题卡 → 正片的笔刷转场：一半在卡上，一半在正片开头
const CH_OUT = .5;    // 每章结尾笔刷盖过画面的时长（最后一章不做，它自己安排结尾）
// 标题卡和角落小章节名的字体：粗、清楚，不用花体
const CH_FONT = px => `bold ${px}px "Microsoft YaHei", "PingFang SC", "Noto Sans SC", "Segoe UI", sans-serif`;
let _chCtx = null;
const chTextW = (s, px) => { if (!_chCtx) _chCtx = document.createElement('canvas').getContext('2d'); _chCtx.font = CH_FONT(px); return _chCtx.measureText(s).width; };

function chapter(n, list) {
  const s = CH_SCENE(n), len = CHAPTERS.find(c => c.n === n).len;
  const lst = list.slice().sort((a, b) => a[0] - b[0]);
  lst.forEach(([u0, fn], i) => {
    const u1 = i + 1 < lst.length ? lst[i + 1][0] : len;
    shots([[s + u0, t => {
      const u = t - s;
      fn(u, u - u0, u1 - u0);
      if (u < CH_WIPE) { flushLetters(); brushWipe(.5 + u / (CH_WIPE * 2)); }   // 揭开：接标题卡（或上一章的收尾）
    }]]);
  });
}

// 标题卡：纸面上"第 N 章"小字 + 章节名大字（+ 副标题），下面一笔赤陶色的刷痕
function chapterCard(c, lt) {
  boilSeed('card' + c.n);
  paint(rectPts(-40, -40, W + 80, H + 80), { wash: PAL.paper, ink: null });
  const inK = easeOut(seg(lt, .05, .45)), lineK = ease(seg(lt, .3, .9));
  const cy = c.sub ? H / 2 - 30 : H / 2;
  letter(`第 ${c.n} 章`, W / 2, cy - 110 + 20 * (1 - inK), 46, PAL.clayDk, { screen: true, ink: false, alpha: inK, font: CH_FONT(46) });
  letter(c.name, W / 2, cy + 10 * (1 - inK), 96, PAL.ink, { screen: true, ink: false, alpha: inK, font: CH_FONT(96) });
  if (c.sub) letter(c.sub, W / 2, cy + 120, 44, '#5A4E5F', { screen: true, ink: false, alpha: easeOut(seg(lt, .35, .75)), font: CH_FONT(44) });
  if (lineK > 0) {
    const half = Math.min(560, chTextW(c.name, 96) / 2 + 40), y = cy + 70;
    boilSeed('cardline' + c.n);
    inkLine([[W / 2 - half, y], [lerp(W / 2 - half, W / 2 + half, lineK), y + 4]], 4, PAL.clay, 'ink', 0);
  }
  if (lt > CARD - CH_WIPE) { flushLetters(); brushWipe((lt - (CARD - CH_WIPE)) / (CH_WIPE * 2)); }
  if (lt < CH_WIPE) { flushLetters(); brushWipe(.5 + lt / (CH_WIPE * 2)); }   // 揭开上一章结尾盖上的笔刷（第 1 章也这样开场）
}
if (CARD > 0) for (const c of CHAPTERS) shots([[CH_START[c.n], (t, lt) => chapterCard(c, lt)]]);

function chapterAt(t) { for (let i = CHAPTERS.length - 1; i >= 0; i--) if (t >= CH_START[CHAPTERS[i].n]) return CHAPTERS[i]; return CHAPTERS[0]; }
// 每章结尾的收尾：最后 CH_OUT 秒笔刷盖过画面。timeline.js 在每帧最后调用，盖在所有东西之上
function chapterOutro(t) {
  if (!CHAPTERS.length || t < INTRO) return;
  const c = chapterAt(t); if (c === CHAPTERS[CHAPTERS.length - 1]) return;
  const k = t - CH_SCENE(c.n) - (c.len - CH_OUT);
  if (k > 0) { flushLetters(); brushWipe(k / (CH_OUT * 2)); }
}
// 正片左上角的小章节名：一块半透明的小牌子，让观众知道在看哪一章（CARD 为 0 时不画）
function drawChapterLabel(t) {
  if (!CHAPTERS.length || CARD <= 0 || t < INTRO) return;
  const c = chapterAt(t), u = t - CH_SCENE(c.n);
  if (u < .4) return;
  const a = easeOut(seg(u, .4, .9)), fs = 26, txt = `${c.n} · ${c.name}`, w = chTextW(txt, fs) + 36, h = fs + 20;
  boilSeed('chlabel' + c.n);
  paint(rrPts(28, 24, w, h, h / 2), { wash: '#1B1F33', washOp: 150 * a, ink: null });
  letter(txt, 28 + w / 2, 24 + h / 2 + 1, fs, '#FFF5E2', { screen: true, ink: false, alpha: .92 * a, font: CH_FONT(fs) });
}
