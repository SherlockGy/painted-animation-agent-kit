// config.js: project settings.
//   duration: the video's length in seconds.
//   bpm:      the rhythm that bounces, dances and pulse() follow. Clawd always moves to some beat; if the video has music,
//             set this to the song's tempo, and set offset to the time in seconds of its first downbeat.

// 按章模式（可选，见指南"按章独立制作（可选）"一节）。CHAPTERS 留空 = 普通模式：一条时间线，时长就是下面的 duration。
// 填了 CHAPTERS 就是按章模式：全片 = 片头（INTRO 秒，0 = 没有片头）+ 每章（标题卡 CARD 秒 + 正片 len 秒），
// 全片时长自动算出来；场景用 chapter(n, …) 按"本章正片时间"写（src/chapters.js），每章可以单独渲染。
// 这张表是章节长度的唯一来源：render.mjs 也从这里读。例：
//   const CHAPTERS = [
//     { n: 1, name: '第一章的名字', sub: '', len: 20 },     // sub：标题卡上的副标题，可以留空
//     { n: 2, name: '第二章的名字', sub: '', len: 32.5 },
//   ];
const INTRO = 0;      // 片头长度（秒）；片头场景用 shots([[0, fn]]) 写在全片最前面
const CARD = 2.5;     // 每章标题卡的长度（秒）；0 = 不要标题卡和角落的小章节名
const CHAPTERS = [];
// 每章在全片里的起点（标题卡开始的时刻）和正片开始的时刻
const CH_START = []; { let s = INTRO; for (const c of CHAPTERS) { CH_START[c.n] = s; s += CARD + c.len; } }
const CH_SCENE = n => CH_START[n] + CARD;

const PROJECT = { duration: CHAPTERS.length ? INTRO + CHAPTERS.reduce((s, c) => s + CARD + c.len, 0) : 11, bpm: 120, offset: 0 };
