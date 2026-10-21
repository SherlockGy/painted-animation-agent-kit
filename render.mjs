// render.mjs: renders studio.html in headless Chrome. Length and fps come from the page (PROJECT in src/config.js).
//
//   Look at it (open the images with your image viewer / Read tool):
//     node render.mjs --sheet=0.5,1,1.5,2 [--cols=4] [--w=480] --out=out/check/a.jpg        contact sheet of chosen times
//     node render.mjs --strip=2.0:2.5 [--cols=6] [--w=320] --out=out/check/strip.jpg        EVERY frame in a stretch (motion)
//     node render.mjs --sheet=2.1,2.2 --crop=760,300,400,400 --w=600 --out=out/check/face.jpg full-res crops (details)
//     node render.mjs --strip=2.0:2.5 --crop-at=960,780,500,400 --out=out/check/feet.jpg       crops that follow a WORLD point
//         (x,y in world px, may be page expressions like PLK.MX(1.38); w,h in screen px) through each frame's camera
//     node render.mjs --stills=1.2,3.4 --out=out/stills                                     full-res PNGs
//   Make the video:
//     node render.mjs --clip [--range=0:4] --out=out/video.mp4                               straight to MP4 (one worker)
//     node render.mjs --frames [--range=0:8] --workers=4                                     JPEG frames → out/frames (parallel, resumable)
//     node render.mjs --encode --out=out/video.mp4                                           out/frames → MP4
//   长渲染的守护（--frames 自带，见指南"渲染"一节）：
//     每帧渲完检查是不是黑图（WebGL 上下文丢失），是就重开页面重渲这一帧；每个页面渲染 --recycle=300 帧后主动重开；
//     系统剩余内存低于 --low-gb=2.5 时暂停这个 worker、关掉它的页面，回到 --resume-gb=3.5 以上再继续；进度日志里带剩余内存。
//     被打断（内存不足被系统结束、手动停止）后，重跑同一条命令即可：已渲好的帧会跳过，只补缺的帧。
//   按章模式（可选，src/config.js 里 CHAPTERS 非空时可用，见指南"按章独立制作（可选）"一节）：
//     node render.mjs --frames --chapter=1,2 --workers=3     每段的帧 → out/frames/ch01/…（段内从 0 编号）；--chapter=all = 全部
//     node render.mjs --encode --chapter=1,2                 每段 → out/chapters/ch01.mp4；配乐用 out/music/ch01.wav，没有就是静音
//     node render.mjs --concat [--chapter=1,2] [--out=out/video_{v}.mp4]   各段拼成一片；{v} 自动取下一个没用过的 v001、v002…
//     第 0 段 = 片头（长度是 config.js 的 INTRO，INTRO 为 0 就没有第 0 段）
//   交付前统一校验：
//     node render.mjs --review [--chapter=1,2|all] [--out=out/review/{v}] [--step=0.0833] [--static-max=3]
//     优先读取 out/frames 下的逐帧日志，缺的时间按 --step（默认 1/12 秒）采样；报告和连续帧图写入新编号目录。
//     不通过时退出码为 1；提醒和每张连续帧图仍须逐张人工核对（见指南“交付前统一校验”）。
//   Standalone loops (LOOPS in the page): add --loop=<name> to any of the above (times are then loop times), or
//     node render.mjs --loop=emotions --png --out=out/loop_emotions                          one cycle as PNGs (for GIFs)
//   Music: --audio=assets/song.mp3 (or PROJECT.audio) is muxed into --clip and --encode. Other flags: --fps=24,
//   --chrome=<path to Chrome/Chromium>.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, statSync, renameSync, readdirSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname, resolve, basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import os, { homedir } from 'node:os';

// 跳变：帧差超过本段中位数的 4 倍且超过 8 灰度级，仅提醒，不替人下结论。
const REVIEW_JUMP_FACTOR = 4, REVIEW_JUMP_MIN = 8;
// 静止：帧差不超过本段第 15 百分位的 1.8 倍；零阈值也能识别完全不动的帧。
const REVIEW_STATIC_FACTOR = 1.8;
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const CHROMES = [args.chrome, process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ...playwrightChromes()];
// Chromium builds Playwright downloaded (~/.cache/ms-playwright/chromium-NNNN), newest first
function playwrightChromes() {
  const dir = `${homedir()}/.cache/ms-playwright`;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(n => /^chromium-\d+$/.test(n)).sort((a, b) => b.split('-')[1] - a.split('-')[1])
    .map(n => `${dir}/${n}/chrome-linux64/chrome`);
}
const CHROME = CHROMES.find(p => p && existsSync(p));
if (!CHROME) { console.error('Chrome not found: pass --chrome=<path> or set CHROME_PATH'); process.exit(1); }
const fps = +(args.fps || 24), FRAMES_DIR = 'out/frames';
const run = (cmd, a) => new Promise((ok, bad) => { const p = spawn(cmd, a, { stdio: 'inherit' }); p.on('close', c => c ? bad(new Error(cmd + ' exited ' + c)) : ok()); });
const times = s => String(s).split(',').map(Number);
const span = s => String(s).split(':').map(Number);
// comma-separated fields, keeping commas inside parentheses ('PLK.MX(1.38),PLK.WL,500,300'); numbers stay numbers
const fields = s => { const out = []; let d = 0, cur = ''; for (const ch of String(s)) { if (ch === ',' && !d) { out.push(cur); cur = ''; continue; } d += ch === '(' ? 1 : ch === ')' ? -1 : 0; cur += ch; } out.push(cur); return out.map(v => isNaN(+v) ? v : +v); };

// ---------- 按章模式 ----------
// 章节表只有一个来源：src/config.js。这里在 node 里直接执行它，取出 INTRO、CARD、CHAPTERS（页面里用的也是同一份）
const CFG = new Function(readFileSync('src/config.js', 'utf8') + '\nreturn { INTRO, CARD, CHAPTERS };')();
const pad2 = n => String(n).padStart(2, '0');
// 第 n 段在全片里的起点和时长：第 0 段是片头（0 到 INTRO），其余每段 = 标题卡（CARD）+ 正片（len）
const chStart = n => n === 0 ? 0 : CFG.INTRO + CFG.CHAPTERS.filter(c => c.n < n).reduce((s, c) => s + CFG.CARD + c.len, 0);
const chDur = n => n === 0 ? CFG.INTRO : CFG.CARD + CFG.CHAPTERS.find(c => c.n === n).len;
const chAll = () => [...(CFG.INTRO > 0 ? [0] : []), ...CFG.CHAPTERS.map(c => c.n)];
const chList = () => args.chapter === true || args.chapter === 'all' ? chAll() : String(args.chapter).split(',').map(Number);
if ((args.chapter || args.concat) && !CFG.CHAPTERS.length) { console.error('--chapter / --concat 要先在 src/config.js 里填好 CHAPTERS（见指南"按章独立制作（可选）"一节）'); process.exit(1); }
if (args.chapter) for (const n of chList()) if (n === 0 ? !(CFG.INTRO > 0) : !CFG.CHAPTERS.some(c => c.n === n)) { console.error(`没有第 ${n} 段：看 src/config.js 的 CHAPTERS 和 INTRO`); process.exit(1); }
// 一段的配乐：有 out/music/chNN.wav 就用它，没有就用静音。统一成 44.1 kHz 立体声，补齐或截断到这一段的时长，段与段的接缝不出空隙
const chMusic = n => `out/music/ch${pad2(n)}.wav`;
const chAudioIn = n => existsSync(chMusic(n)) ? ['-i', chMusic(n)] : ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo'];
const fitAudio = (i, d) => `[${i}:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo,apad,atrim=0:${d.toFixed(3)}`;
// {v} → 下一个没用过的版本号（v001、v002…）；不带 {v} 时目标已存在就拒绝，不覆盖
function versioned(out) {
  mkdirSync(dirname(out), { recursive: true });
  const at = v => out.replace('{v}', 'v' + String(v).padStart(3, '0'));
  if (out.includes('{v}')) { let v = 1; while (existsSync(at(v))) v++; return at(v); }
  if (existsSync(out)) { console.error(`${out} 已存在，不覆盖：换一个文件名，或在 --out 里用 {v} 自动编号`); process.exit(1); }
  return out;
}

if (args.encode && args.chapter) {
  mkdirSync('out/chapters', { recursive: true });
  for (const n of chList()) {
    const dir = `${FRAMES_DIR}/ch${pad2(n)}`, out = `out/chapters/ch${pad2(n)}.mp4`, d = chDur(n), want = Math.round(d * fps);
    const have = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.jpg')).length : 0;
    if (have < want) { console.error(`第 ${n} 段只有 ${have} 帧，应有 ${want} 帧：先跑 node render.mjs --frames --chapter=${n}`); process.exit(1); }
    console.log(`[encode 按章编码][第 ${n} 段] ${have} 帧 + ${existsSync(chMusic(n)) ? chMusic(n) : '静音'} → ${out}`);
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', `${dir}/f%05d.jpg`, ...chAudioIn(n),
      '-filter_complex', fitAudio(1, d) + '[a]', '-map', '0:v', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out]);
  }
  process.exit(0);
}
if (args.concat) {
  // 画面：各段 mp4 的视频流直接拼接；声音：各段配乐先拼成一条 wav（放在成片旁边），再整体编码
  const ns = args.chapter ? chList() : chAll();
  for (const n of ns) if (!existsSync(`out/chapters/ch${pad2(n)}.mp4`)) { console.error(`缺少 out/chapters/ch${pad2(n)}.mp4：先跑 node render.mjs --encode --chapter=${n}`); process.exit(1); }
  const out = versioned(args.out || 'out/video_{v}.mp4'), tmp = 'out/chapters/_concat', wav = out.replace(/\.mp4$/, '_audio.wav');
  mkdirSync(tmp, { recursive: true });
  writeFileSync(`${tmp}/video.txt`, ns.map(n => `file '${resolve(`out/chapters/ch${pad2(n)}.mp4`).replace(/\\/g, '/')}'`).join('\n'));
  const fc = ns.map((n, i) => fitAudio(i, chDur(n)) + `[a${i}]`).join(';') + ';' + ns.map((_, i) => `[a${i}]`).join('') + `concat=n=${ns.length}:v=0:a=1[a]`;
  await run('ffmpeg', ['-y', '-loglevel', 'error', ...ns.flatMap(chAudioIn), '-filter_complex', fc, '-map', '[a]', '-c:a', 'pcm_s16le', wav]);
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', `${tmp}/video.txt`, '-i', wav, '-map', '0:v', '-map', '1:a',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out]);
  console.log(`[concat 拼成片] 第 ${ns.join('、')} 段 → ${out}（配乐 ${wav}）`);
  process.exit(0);
}

if (args.encode) {
  const out = args.out || 'out/video.mp4', n = readdirSync(FRAMES_DIR).filter(f => f.endsWith('.jpg')).length, audio = args.audio;
  console.log(`encoding ${n} frames → ${out}${audio ? ' with ' + audio : ''}`);
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-stats', '-framerate', String(fps), '-i', `${FRAMES_DIR}/f%05d.jpg`,
    ...(audio ? ['-i', audio, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-shortest'] : []),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]);
  console.log('wrote ' + out);
  process.exit(0);
}

// --soft-gl: no GPU on this machine; render WebGL in software (SwiftShader), which Chrome only allows when asked.
// --gpu-angle=vulkan|gl-egl: headless Linux on an NVIDIA GPU (e.g. a cloud or cluster node); plain --use-gl=angle gets
// no WebGL context there. Check which GPU Chrome actually lands on with gpu_probe.mjs.
const ANGLE = { vulkan: ['--use-angle=vulkan', '--enable-features=Vulkan'], 'gl-egl': ['--use-angle=gl-egl'] };
if (args['gpu-angle'] && !ANGLE[args['gpu-angle']]) { console.error(`--gpu-angle must be one of ${Object.keys(ANGLE)}`); process.exit(1); }
const gpu = args['soft-gl'] ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  : args['gpu-angle'] ? ANGLE[args['gpu-angle']]
  : process.platform === 'win32' ? ['--use-angle=d3d11'] : process.platform === 'darwin' ? ['--use-angle=metal'] : ['--use-gl=angle'];
// Ubuntu 23.10+ blocks Chrome's user-namespace sandbox; headless rendering of local files doesn't need it.
const sandbox = process.platform === 'linux' ? ['--no-sandbox'] : [];
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 0,
  args: [...sandbox, '--allow-file-access-from-files', '--ignore-gpu-blocklist', ...gpu, '--enable-gpu-rasterization', '--window-size=1920,1080', '--disable-renderer-backgrounding', '--disable-background-timer-throttling']
});
async function openPage(tag = '') {
  const page = await browser.newPage();
  page.on('console', m => { if (['error', 'warn'].includes(m.type())) console.log(`[page${tag}]`, m.text()); });
  page.on('pageerror', e => console.log(`[page error${tag}]`, e.message));
  await page.goto(pathToFileURL(resolve('studio.html')).href + '?render', { waitUntil: 'networkidle0' });
  await page.waitForFunction('window.ready === true', { timeout: 60000 });
  if (args.loop) {
    const ok = await page.evaluate(name => { if (!LOOPS[name]) return false; window.LOOP = LOOPS[name]; return true; }, args.loop);
    if (!ok) { console.error(`no loop named "${args.loop}"`); process.exit(1); }
  }
  return page;
}
const frameOf = async (page, t, type, q) => {
  const url = await page.evaluate((t, type, q) => window.renderAt(t, type, q), t, type, q);
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
};
// the length of whatever is being rendered: a loop's .len, or the video's duration
const lengthOf = page => page.evaluate(() => window.LOOP ? window.LOOP.len : DUR);

// ---------- 交付前统一校验 ----------
function reviewDirectory(pattern = 'out/review/{v}') {
  mkdirSync(dirname(pattern), { recursive: true });
  for (let n = 1; ; n++) {
    const out = pattern.replace('{v}', 'r' + String(n).padStart(3, '0'));
    try { mkdirSync(out); return out; }
    catch (e) { if (e.code !== 'EEXIST') throw e; if (!pattern.includes('{v}')) throw new Error(`${out} 已存在，不覆盖：请换目录或使用 {v}`); }
  }
}
function reviewLogs(root) {
  const files = [];
  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (basename(dir) === '_review' && e.name.endsWith('.ndjson')) files.push(p);
    }
  }
  walk(root);
  // 老日志没有 writtenAt 时，按文件修改顺序、行顺序读；新日志用记录时间判断跨 worker 的续渲先后。
  files.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs || a.localeCompare(b));
  const latest = new Map();
  for (const file of files) {
    let bad = 0;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (!Number.isFinite(r.t) || typeof r.f !== 'string' || !Array.isArray(r.letters) || typeof r.thumb !== 'string' || Buffer.from(r.thumb, 'base64').length !== 64 * 36) throw new Error('无效记录');
        const key = join(dirname(dirname(file)), r.f), old = latest.get(key);
        if (!old || !old.writtenAt || !r.writtenAt || r.writtenAt >= old.writtenAt) latest.set(key, r);
      } catch { bad++; }
    }
    if (bad) console.warn(`[review] ${file} 跳过 ${bad} 条损坏或不完整的日志，将补采缺失时间`);
  }
  // 全片和分章渲染可能包含同一视频时刻；只检查该时刻最新的记录，不能混入旧版文字。
  const byTime = new Map();
  for (const r of [...latest.values()].sort((a, b) => (a.writtenAt || 0) - (b.writtenAt || 0))) byTime.set(r.t.toFixed(6), r);
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}
const reviewTime = t => { const tenths = Math.round(t * 10); return `${String(Math.floor(tenths / 600)).padStart(2, '0')}:${((tenths % 600) / 10).toFixed(1).padStart(4, '0')}`; };
const reviewInterval = r => reviewTime(r.t) + (r.until > r.t ? '–' + reviewTime(r.until) : '');
const reviewCell = x => String(x ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
const reviewQuantile = (xs, q) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) * q)] : 0; };
const reviewDiff = (a, b) => { let sum = 0; for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]); return sum / a.length; };
function reviewFindings(rows, checkpoints, width, height, step, staticMax, textRows = rows) {
  const out = [], last = new Map(), allCuts = checkpoints.filter(r => r.kind === 'cut'), cuts = allCuts.filter(r => r.auto);
  const nearCut = (t, win) => cuts.some(c => Math.abs(c.t - t) <= win);
  // 连续帧上的同一问题合并为一条，留时间范围，避免几秒钟的文字问题生成上百张图。
  const add = (key, t, kind, check, detail, fail = false) => {
    const old = last.get(key);
    if (old && t - old.until <= step * 1.5 + 1e-6) { old.until = t; return; }
    const item = { t, until: t, kind, check, detail, fail }; last.set(key, item); out.push(item);
  };
  const intersect = (a, b) => Math.max(0, Math.min(a.x0 + a.w, b.x0 + b.w) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y0 + a.h, b.y0 + b.h) - Math.max(a.y0, b.y0));
  for (const r of textRows) {
    const letters = r.letters.filter(l => l.alpha > .05 && l.w > 0 && l.h > 0);
    for (const l of letters) if (intersect(l, { x0: 0, y0: 0, w: width, h: height }) < l.w * l.h / 2)
      add('outside:' + l.txt, r.t, 'text', '文字出画', `「${l.txt}」超过一半包围盒在画面外（${l.x.toFixed(1)}, ${l.y.toFixed(1)}）`, true);
    for (let i = 0; i < letters.length; i++) for (let j = i + 1; j < letters.length; j++) {
      const a = letters[i], b = letters[j];
      if (a.txt !== b.txt && intersect(a, b) > .3 * Math.min(a.w * a.h, b.w * b.h))
        add('overlap:' + [a.txt, b.txt].sort().join('|'), r.t, 'text', '文字重叠', `「${a.txt}」和「${b.txt}」交叠超过较小包围盒的 30%`);
    }
  }
  for (const r of rows) {
    const g = r.gray, mean = g.reduce((s, x) => s + x, 0) / g.length;
    const sd = Math.sqrt(g.reduce((s, x) => s + (x - mean) ** 2, 0) / g.length);
    // 开场半秒允许黑场，切点前后半秒允许笔刷转场。
    if (sd < 2 && r.t > .5 && !allCuts.some(c => Math.abs(c.t - r.t) <= .5)) add('plain', r.t, 'other', '纯色帧', `灰度标准差 ${sd.toFixed(2)} < 2`);
  }
  // 每个镜头分别计算阈值，避免一个强运动镜头把另一个镜头的变化掩盖。
  const groups = [];
  for (const r of rows) {
    const g = groups.at(-1), prev = g?.at(-1);
    if (!prev || r.t - prev.t > step * 1.5 || cuts.some(c => c.t > prev.t && c.t <= r.t)) groups.push([r]);
    else g.push(r);
  }
  for (const group of groups) {
    const ds = group.slice(1).map((r, i) => reviewDiff(r.gray, group[i].gray));
    const median = reviewQuantile(ds, .5), low = reviewQuantile(ds, .15) * REVIEW_STATIC_FACTOR;
    let start = null;
    const finish = end => {
      if (start != null && end - start > staticMax) add('static:' + start, start, 'hold', '长时间静止', `${reviewTime(start)}–${reviewTime(end)}（${(end - start).toFixed(1)} 秒）帧差持续偏低`);
      start = null;
    };
    for (let i = 1; i < group.length; i++) {
      const r = group[i], prev = group[i - 1], d = ds[i - 1];
      if (d > median * REVIEW_JUMP_FACTOR && d > REVIEW_JUMP_MIN && !nearCut(r.t, 2 / fps))
        add('jump', r.t, 'other', '跳变', `平均帧差 ${d.toFixed(2)}，本段中位数 ${median.toFixed(2)}`);
      const held = checkpoints.some(c => c.kind === 'hold' && c.until != null && prev.t >= c.t - 1e-6 && r.t <= c.until + 1e-6);
      if (d <= low && !held) { if (start == null) start = prev.t; }
      else finish(prev.t);
    }
    finish(group.at(-1)?.t ?? 0);
  }
  return out.sort((a, b) => a.t - b.t);
}
async function runReview(page) {
  if (args.loop) throw new Error('--review 检查全片或章节，不与 --loop 同用');
  const step = +(args.step || 1 / 12), staticMax = +(args['static-max'] || 3);
  if (!Number.isFinite(step) || step <= 0 || !Number.isFinite(staticMax) || staticMax <= 0) throw new Error('--step 和 --static-max 必须是正数');
  const meta = await page.evaluate(() => ({ len: DUR, width: W, height: H, manual: REVIEWS, automatic: autoReviews(), kinds: REVIEW_KINDS }));
  const ranges = args.chapter ? [...new Set(chList())].sort((a, b) => a - b).map(n => [chStart(n), chStart(n) + chDur(n)]) : [[0, meta.len]];
  const inRange = t => ranges.some(([a, b]) => t >= a && t < b);
  const analysisPoints = [...meta.manual, ...meta.automatic];
  const checkpoints = analysisPoints.filter(r => inRange(r.t)).sort((a, b) => a.t - b.t);
  const logs = reviewLogs(FRAMES_DIR).filter(r => inRange(r.t));
  // 用统一采样时间轴比较，避免 24fps 日志和 12fps 补采的帧差阈值不同。时间精度不超过半帧。
  const rows = [], missing = [];
  let cursor = 0;
  for (const [a, b] of ranges) for (let i = 0; a + i * step < b - 1e-7; i++) {
    const t = a + i * step;
    while (cursor + 1 < logs.length && Math.abs(logs[cursor + 1].t - t) <= Math.abs(logs[cursor].t - t)) cursor++;
    const cached = logs[cursor];
    if (cached && Math.abs(cached.t - t) <= Math.min(step / 2, 1 / (2 * fps)) + 1e-7) rows.push({ ...cached, t });
    else { const r = { t }; rows.push(r); missing.push(r); }
  }
  if (missing.length) {
    // 用第一张缺帧的实际耗时估算剩余时间，不把固定机器速度当承诺。
    const sample = async r => Object.assign(r, await page.evaluate(async t => { await window.renderAt(t, 'image/jpeg', .5); return window.frameLog(); }, r.t));
    console.log(`${logs.length ? '逐帧日志不全' : '没有逐帧日志'}，按 ${args.step ? step + ' 秒' : '1/12 秒'}采样，正在估算 ${missing.length} 帧所需时间`);
    const started = Date.now(); await sample(missing[0]);
    console.log(`补采约需 ${((Date.now() - started) * (missing.length - 1) / 60000).toFixed(1)} 分钟`);
    for (const r of missing.slice(1)) await sample(r);
  }
  for (const r of rows) r.gray = Buffer.from(r.thumb, 'base64');
  const textRows = [...logs, ...missing].sort((a, b) => a.t - b.t);
  const findings = reviewFindings(rows, analysisPoints, meta.width, meta.height, step, staticMax, textRows);
  const out = reviewDirectory(args.out), all = [...checkpoints, ...findings];
  for (let i = 0; i < all.length; i++) {
    const r = all[i], finding = i >= checkpoints.length;
    const win = finding ? [-.4, .4] : r.window || meta.kinds[r.kind].win;
    const range = ranges.find(([a, b]) => r.t >= a && r.t < b);
    const a = Math.max(range[0], r.t + win[0]), b = Math.min(range[1] - 1 / fps, (finding ? r.t : r.until ?? r.t) + win[1]);
    const count = Math.max(1, Math.floor(Math.max(0, b - a) * 12 + 1e-6) + 1);
    const n = Math.min(16, count);
    const ts = Array.from({ length: n }, (_, j) => a + (count <= 16 ? j : Math.round(j * (count - 1) / (n - 1))) / 12);
    const labels = ts.map(t => Math.abs(t - r.t) < 1 / 48 ? '此刻' : `${t < r.t ? '前' : '后'} ${Math.abs(t - r.t).toFixed(2)}s`);
    const title = `${r.kind} · ${reviewTime(r.t)} · ${r.what || r.check}`;
    const { url } = await page.evaluate((ts, title, labels) => window.renderSheet(ts, 4, 480, null, null, title, labels), ts, title, labels);
    r.image = `${String(i + 1).padStart(2, '0')}_${r.kind}_${reviewTime(r.t).replace(':', '-')}.jpg`;
    writeFileSync(join(out, r.image), Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
  }
  const failures = findings.filter(r => r.fail), warnings = findings.length - failures.length;
  const scope = args.chapter ? `第 ${[...new Set(chList())].join('、')} 章` : '全片';
  const lines = [`# 交付前校验报告（${basename(out)}，${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC）`, '',
    `范围：${scope}　检查点 ${checkpoints.length} 个（自动 ${checkpoints.filter(r => r.auto).length}、登记 ${checkpoints.filter(r => !r.auto).length}）　自动检查：不通过 ${failures.length}、提醒 ${warnings}`, '',
    '## 结论', failures.length ? `**有 ${failures.length} 处不通过**：` : '**自动检查没有不通过项；仍须逐张看图并完整看片。**',
    ...failures.map(r => `- ${reviewInterval(r)} ${r.check}：${reviewCell(r.detail)}（[图 ${r.image}](${r.image})）`), '',
    '## 自动检查', '| 时刻 | 检查 | 详情 | 图 |', '|---|---|---|---|',
    ...findings.map(r => `| ${reviewInterval(r)} | ${r.check} · ${r.fail ? '不通过' : '提醒'} | ${reviewCell(r.detail)} | [${r.image}](${r.image}) |`), '',
    '## 检查点（逐张看图，在“看过”列填 ✅ 或写下问题）', '| # | 时刻 | 类别 | 画面上是什么 | 要看什么 | 图 | 看过 |', '|---|---|---|---|---|---|---|',
    ...checkpoints.map((r, i) => `| ${i + 1} | ${reviewTime(r.t)} | ${r.kind} | ${reviewCell(r.what)} | ${reviewCell([meta.kinds[r.kind].ask, r.ask].filter(Boolean).join(' '))} | [${r.image}](${r.image}) | |`), '',
    `采样间隔：${step} 秒；文字包围盒为估算值（不含 pop 弹跳），自动提醒不能替代逐图核对。`, ''];
  writeFileSync(join(out, 'report.md'), lines.join('\n'));
  console.log(`${out}/report.md：不通过 ${failures.length}、提醒 ${warnings}，${all.length} 张连续帧图`);
  if (failures.length) process.exitCode = 1;
}

if (args.review) {
  try { await runReview(await openPage()); }
  catch (e) { await browser.close(); throw e; }
} else if (args.sheet || args.strip) {
  const page = await openPage(), out = args.out || 'out/sheet.jpg'; mkdirSync(dirname(out), { recursive: true });
  let ts;
  if (args.strip) { const [a, b] = span(args.strip); ts = []; for (let i = Math.round(a * fps); i <= Math.round(b * fps); i++) ts.push(i / fps); }
  else ts = times(args.sheet);
  const crop = args.crop ? times(args.crop) : null, at = args['crop-at'] ? fields(args['crop-at']) : null;
  const { url, ms } = await page.evaluate((ts, c, w, crop, at) => window.renderSheet(ts, c, w, crop, at), ts, +(args.cols || (args.strip ? 6 : 3)), +(args.w || (args.strip ? 320 : 640)), crop, at);
  writeFileSync(out, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
  console.log(`${out}  (${ts.length} frames)  ms/frame: ${ms.join(' ')}`);
} else if (args.stills) {
  const page = await openPage(), out = args.out || 'out/stills'; mkdirSync(out, { recursive: true });
  console.log('GPU:', await page.evaluate(() => window.gpuInfo()));
  for (const s of times(args.stills)) {
    const t0 = Date.now(), buf = await frameOf(page, s, 'image/png');
    const f = `${out}/t${s.toFixed(2).replace('.', '_')}.png`; writeFileSync(f, buf);
    console.log(`${f}  ${Date.now() - t0} ms`);
  }
} else if (args.png) {
  // PNG sequence (for GIFs): a loop's full cycle (frame n equals frame 0, so it isn't rendered), or --range=a:b.
  const probe = await openPage(), len = await lengthOf(probe); await probe.close();
  const [a, b] = args.range ? span(args.range) : [0, len], n = Math.round((b - a) * fps);
  const out = args.out || `out/${args.loop ? 'loop_' + args.loop : 'png'}`, workers = +(args.workers || 3); mkdirSync(out, { recursive: true });
  let next = 0; const start = Date.now();
  await Promise.all(Array.from({ length: workers }, async (_, w) => {
    const page = await openPage('#' + w);
    while (next < n) { const i = next++; writeFileSync(`${out}/f${String(i).padStart(4, '0')}.png`, await frameOf(page, a + i / fps, 'image/png')); }
  }));
  console.log(`${n} frames → ${out}  (${((Date.now() - start) / n).toFixed(0)} ms/frame)`);
} else if (args.frames) {
  // Parallel and resumable: each worker pulls the next missing frame; files are written atomically.
  const probe = await openPage(), len = await lengthOf(probe); await probe.close();
  const workers = +(args.workers || 4);
  // 要渲的帧：[文件, 视频时间]。按章模式下每段一个目录、段内从 0 编号；否则全片一个目录、按全片编号
  const todo = [];
  const want = (dir, a, b, i0) => {
    mkdirSync(dir, { recursive: true });
    const n = Math.round((b - a) * fps);
    for (let i = 0; i < n; i++) { const f = `${dir}/f${String(i0 + i).padStart(5, '0')}.jpg`; if (!existsSync(f) || statSync(f).size < 1000) todo.push([f, a + i / fps]); }
  };
  if (args.chapter) for (const n of chList()) want(`${FRAMES_DIR}/ch${pad2(n)}`, chStart(n), chStart(n) + chDur(n), 0);
  else {
    const [a, b] = args.range ? span(args.range) : [0, len], first = Math.round(a * fps);
    want(FRAMES_DIR, first / fps, Math.min(len, b), first);
  }
  console.log(`${todo.length} frames to render, ${workers} workers`);
  // 长渲染的守护：内存吃紧会让 WebGL 上下文丢失，之后每帧都是纯黑图。所以每帧渲完检查一次，
  // 上下文丢失或输出是黑图就重开页面重渲这一帧；每个页面渲染 RECYCLE 帧后主动重开，避免内存越积越多
  const RECYCLE = +(args.recycle || 300), LOW_GB = +(args['low-gb'] || 2.5), RESUME_GB = +(args['resume-gb'] || 3.5);
  const broken = async (page, buf) => buf.length < 20000 && await page.evaluate(() => {
    const gl = drawingContext; if (gl.isContextLost && gl.isContextLost()) return true;
    const c = document.createElement('canvas'); c.width = 48; c.height = 27; const x = c.getContext('2d'); x.drawImage(outC, 0, 0, 48, 27);
    const d = x.getImageData(0, 0, 48, 27).data; let mx = 0; for (let k = 0; k < d.length; k += 4) mx = Math.max(mx, d[k], d[k + 1], d[k + 2]); return mx < 12;
  });
  const freeGB = () => (os.freemem() / 2 ** 30).toFixed(1);
  let next = 0, done = 0; const start = Date.now();
  await Promise.all(Array.from({ length: workers }, async (_, w) => {
    let page = await openPage('#' + w), used = 0;
    const reopen = async why => { console.log(`[worker ${w}] 重开页面：${why}`); await page.close().catch(() => {}); page = await openPage('#' + w); used = 0; };
    while (next < todo.length) {
      // 内存守护：系统剩余内存低于 LOW_GB 时，先关掉自己的页面释放内存，等回到 RESUME_GB 以上再继续
      if (os.freemem() < LOW_GB * 2 ** 30) {
        console.log(`[worker ${w}] 剩余内存 ${freeGB()} GB，低于 ${LOW_GB} GB，暂停并释放页面`);
        await page.close().catch(() => {});
        while (os.freemem() < RESUME_GB * 2 ** 30) await new Promise(r => setTimeout(r, 5000));
        page = await openPage('#' + w); used = 0;
        console.log(`[worker ${w}] 剩余内存 ${freeGB()} GB，继续`);
      }
      if (next >= todo.length) break;   // 暂停期间别的 worker 可能已经把剩下的帧领完了
      const [f, ft] = todo[next++];
      if (used >= RECYCLE) await reopen(`已渲染 ${RECYCLE} 帧，主动回收`);
      let buf = await frameOf(page, ft, 'image/jpeg', .94), tries = 0;
      while (await broken(page, buf)) {
        if (++tries >= 3) throw new Error(`帧 ${f} 连续 ${tries} 次输出黑图，停止渲染`);   // 首次 + 重渲 2 次都是黑图
        await reopen(`帧 ${f} 输出黑图（WebGL 上下文丢失）`);
        buf = await frameOf(page, ft, 'image/jpeg', .94);
      }
      used++;
      writeFileSync(f + '.tmp', buf); renameSync(f + '.tmp', f);
      try {
        const log = await page.evaluate(() => window.frameLog()), dir = `${dirname(f)}/_review`;
        mkdirSync(dir, { recursive: true });
        appendFileSync(`${dir}/log-w${w}.ndjson`, JSON.stringify({ f: basename(f), t: ft, ...log, writtenAt: performance.timeOrigin + performance.now() }) + '\n');
      } catch (e) { console.warn(`[review] 帧 ${f} 日志失败（渲染继续）：${e.message}`); }

      if (++done % 24 === 0 || done === todo.length) {
        const el = (Date.now() - start) / 1000;
        console.log(`frame ${done}/${todo.length}  ${(el / done * 1000).toFixed(0)} ms/frame effective  eta ${((todo.length - done) * el / done / 60).toFixed(1)} min  剩余内存 ${freeGB()} GB`);
      }
    }
  }));
} else if (args.clip) {
  const page = await openPage(), len = await lengthOf(page);
  const [a, b] = args.range ? span(args.range) : typeof args.clip === 'string' ? span(args.clip) : [0, len];
  const audio = args.audio || await page.evaluate(() => PROJECT.audio || '');
  const out = args.out || 'out/clip.mp4'; mkdirSync(dirname(out), { recursive: true });
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    ...(audio ? ['-ss', String(a), '-t', String(b - a), '-i', audio, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-shortest'] : []),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out],
    { stdio: ['pipe', 'inherit', 'inherit'] });
  const n = Math.round((b - a) * fps), start = Date.now();
  for (let i = 0; i < n; i++) {
    const buf = await frameOf(page, a + i / fps, 'image/jpeg', .93);
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (i % 24 === 0 || i === n - 1) console.log(`frame ${i + 1}/${n}  ${((Date.now() - start) / (i + 1)).toFixed(0)} ms/frame`);
  }
  ff.stdin.end(); await new Promise(r => ff.on('close', r));
  console.log(`wrote ${out}`);
} else {
  console.log('nothing to do: see the usage notes at the top of render.mjs');
}
await browser.close();
