// review.js：交付前统一校验的检查点。写场景时，在"观众会盯着看、做错了一眼就露馅"的时刻登记一个检查点，
// 交付前 node render.mjs --review 会为每个检查点出一张连续帧图，并在报告里写明这一类该看什么（见指南"交付前统一校验"）。
//   review(t, kind, what, o)       t 是全片时间
//   reviewCh(n, u, kind, what, o)  按章模式：n 是章号，u 是本章正片时间
//   kind：见下面 REVIEW_KINDS；what：一句话写这一刻画面上是什么（会写进报告）
//   o：{ until: 结束时刻（拖动、定格这类有持续时间的，用同一时间轴）, ask: 额外要看的问题, window: [前, 后] 秒（覆盖默认窗口） }
// 镜头切换、章节开头会自动登记成 'cut'，不用手写。
const REVIEWS = [];
const REVIEW_KINDS = {
  click: { win: [-.4, .6], ask: '光标先到位、按下、看到结果才离开？有没有停在按钮上迟迟不点？松手之前东西有没有就飞走？' },
  drag:  { win: [-.2, .3], ask: '光标和被拖的东西是不是同一条运动曲线（手跟着东西走）？起点、终点有没有跳？' },
  land:  { win: [-.3, .5], ask: '落地、放下、插入、粘贴的那一下：有没有悬空、穿模、被边框裁掉？落地后有没有一点反应？' },
  cut:   { win: [-.25, .25], ask: '上一个镜头的元素（气泡、字、道具）有没有被带进下一个镜头？转场有没有完全盖住切点？' },
  text:  { win: [0, .8], ask: '带字的东西出现、移动、缩放时，字是不是贴着它的东西走？字有没有被挡住、出画、和别的字重叠？' },
  hold:  { win: [-.5, .5], ask: '停住的这一刻，动作是不是已经完成？待机这类循环动作是不是还在动？画面有没有僵住？' },
  emote: { win: [-.2, .7], ask: '换表情有预备和反应吗？有没有从一个表情直接跳到另一个？' },
  other: { win: [-.3, .5], ask: '' },
};
function review(t, kind, what, o = {}) {
  if (!REVIEW_KINDS[kind]) throw new Error(`review(): 没有 "${kind}" 这一类，可用：${Object.keys(REVIEW_KINDS).join('、')}`);
  REVIEWS.push({ t, kind, what, ...o });
}
function reviewCh(n, u, kind, what, o = {}) {
  const off = CH_SCENE(n);
  review(off + u, kind, what, { ...o, until: o.until != null ? off + o.until : undefined, ch: n, u });
}
// 自动检查点：每个镜头的开头（第一个除外）、每章正片开头。render.mjs --review 调用
function autoReviews() {
  const out = SHOTS.slice(1).map(([t]) => ({ t, kind: 'cut', what: '镜头切换', auto: true }));
  for (const c of CHAPTERS) out.push({ t: CH_SCENE(c.n), kind: 'cut', what: `第 ${c.n} 章正片开头`, auto: true, ch: c.n, u: 0 });
  // 标题卡和 chapter() 登记的第一个镜头会在同一时刻各产生一个切点：同一时刻（相差 1 帧以内）只留一个，优先留带章号的
  out.sort((a, b) => a.t - b.t || (b.ch != null) - (a.ch != null));
  return out.filter((r, i) => i === 0 || r.t - out[i - 1].t > 1 / 24);
}
