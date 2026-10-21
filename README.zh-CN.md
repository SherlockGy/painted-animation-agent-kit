# Painted Animation Agent Kit（中文）

[English](README.md) | **中文**

手绘风 2D 角色动画视频的 Agent 制作套件。给编程 Agent（Claude Code 等）一个现成的绘制引擎和一份制作指南，Agent 按指南写分镜、写场景代码、自己渲染检查图找问题，最后输出 MP4。

画风是墨线加平涂：线条像手绘动画一样轻微抖动（沸腾），色块稳定不闪，角色身上不画投影和光影。默认主角是 Clawd，可以换成任何角色。

## 怎么用

在本目录打开 Claude Code，直接说要做什么：

> 做一个 15 秒的视频，Clawd 想抓一只蝴蝶。

Agent 会先读 [ANIMATION_GUIDE.md](ANIMATION_GUIDE.md)（[CLAUDE.md](CLAUDE.md) 已经要求它这样做），再按里面的流程：先写分镜，逐个镜头制作，渲染检查图自查，最后输出 `out/video.mp4`。

长片（一分钟以上或多个段落）可以让 Agent 按指南里"长片：分章节与多 agent 并行"一节，拆成章节交给多个子 Agent 并行做。Agent 还会根据片子的类型，建议要不要按章独立制作：每章单独渲染、单独修改，最后拼成一片。

## 自己运行

需要 Node.js、Google Chrome 和 ffmpeg。

```bash
npm install
node render.mjs --clip --out=out/video.mp4
```

这会渲染 [src/scenes/demo.js](src/scenes/demo.js) 里 11 秒的示例。在 Chrome 里打开 [studio.html](studio.html) 可以拖动预览；加 `?loop=emotions` 或 `?loop=views` 查看角色设定图。Chrome 不在默认位置时，传 `--chrome=<路径>` 或设置环境变量 `CHROME_PATH`。

没有独立显卡时，水彩填充会让渲染变慢，每帧要几秒。Linux 无头环境和无 GPU 的情况见 [render.mjs](render.mjs) 开头的注释和 `gpu_probe.mjs`。

长渲染不用盯着：`--frames` 遇到黑图（WebGL 上下文丢失）会重开页面重渲，每隔几百帧主动重开页面，系统内存不足时暂停、内存回来再继续（`--low-gb`、`--resume-gb`）。渲染被中断后，重跑同一条命令即可，已渲好的帧会跳过。按章模式另有 `--chapter` 和 `--concat`，见 [render.mjs](render.mjs) 开头的注释。

## 目录

| 路径 | 内容 |
|---|---|
| [ANIMATION_GUIDE.md](ANIMATION_GUIDE.md) | 制作指南：规则、动画原理、工作流程、长片协作、完整接口。Agent 动手前通读 |
| [CLAUDE.md](CLAUDE.md) | 给 Agent 的入口说明 |
| [src/core.js](src/core.js) | 绘制、时间、动作工具、镜头、光、纸张 |
| [src/clawd.js](src/clawd.js) | Clawd：视角、情绪、眼睛、嘴、帽子、表情符号、舞蹈 |
| [src/timeline.js](src/timeline.js) | 镜头登记、循环动画、笔刷擦除转场 |
| [src/chapters.js](src/chapters.js) | 可选的按章模式：章节标题卡、角落小章节名、每章结尾的笔刷收尾 |
| [src/config.js](src/config.js) | 时长和节拍；按章模式的章节表 |
| [src/sheets.js](src/sheets.js) | 角色设定图（情绪表、视角表） |
| [src/scenes/](src/scenes/) | 视频场景放这里（demo 只是示例） |
| [render.mjs](render.mjs) | 无头渲染器：检查表、连续帧、裁剪、静帧、MP4；长渲染守护；按章渲染和拼接 |
| [docs/](docs/) | 设定图：[情绪](docs/emotions.jpg)（[动态版](docs/emotions.webp)）、[视角、动作和帽子](docs/views.jpg) |

## 来源

本项目改造自 John Heibel 的两个开源项目：

| 项目 | 使用方式 |
|---|---|
| [ClaudeAnimationBase](https://github.com/JohnHeibel/ClaudeAnimationBase)（MIT 许可，基于提交 `0ac8bf2`） | 引擎、渲染器、角色和示例的代码以它为基础修改；指南由它的英文指南翻译改写 |
| [PDoomVideo](https://github.com/JohnHeibel/PDoomVideo)（基于提交 `fa546a3`） | 只借鉴长片的制作方法：分章节、多 Agent 并行分工、按歌词排镜头、重复布景逐次升级。这些方法已用本项目自己的话写进指南，**没有收录它的任何代码或文档** |

原项目的 MIT 许可证见 [LICENSE](LICENSE)。

## 相对原项目的取舍

| 改了什么 | 原项目 | 本项目 | 原因 |
|---|---|---|---|
| 角色光影 | Clawd 脚下有水彩投影，身上有左上高光、下巴明暗带，手臂带水彩明暗 | 全部去掉，角色只用平涂色加墨线；3/4 侧面改成一块平涂深色 | 不要装饰性光影，画面更干净 |
| 色块闪动 | 水彩填充的晕染和纹理每秒随机重画 12 次，静止的色块也在闪 | 填充改用固定种子，每帧一样；只有墨线照常沸腾 | 闪动的色块干扰观看 |
| 接地 | 脚底比地面点高约 0.2u，靠投影遮住 | 腿加长到脚底正好落在地面点上；设定图的地平线贴着脚底 | 没有投影后缝隙会露出来 |
| 光晕闪动 | `glow()` 的半径每个沸腾帧随机变 3% | 默认不闪；新增 `flicker` 参数，每处光按画面需要决定闪不闪（表情符号里的灯泡默认带闪动） | 光该不该闪取决于是什么光、在什么画面里 |
| 无描边色块 | 示例里天空晕染的顶点每帧随机抖动 10 像素，边缘和纹理都在闪 | 停留在画面上的无描边色块不加顶点抖动，示例和指南都已改（转场这类一闪而过的运动效果保留） | 同上 |
| 高光色 | 角色有一个专门的高光色 `lt` | 删除 | 高光已经不画，留着会误导 Agent 把它加回来 |
| 场景光影 | 背景用水彩画天空、山丘、明暗 | 保留，只是不闪 | 只约束角色，场景需要层次 |
| 长片方法 | Base 指南只覆盖短片 | 指南加入"长片：分章节与多 agent 并行"一节，并扩充分镜模板和音乐部分 | 吸收 PDoomVideo 的经验 |
| 语言 | 英文 | 指南和本项目新增的代码注释用简体中文，README 分为英文（默认）和简体中文两份 | — |

[ANIMATION_GUIDE.md](ANIMATION_GUIDE.md) 的规则 1 把这些取舍写成审美意图和理由，附上具体的反例，而不是硬条款：希望 Agent 去想，而不是套公式。如果某部片确实需要投影或光影，在需求里明确说明，指南规定以需求为准。
