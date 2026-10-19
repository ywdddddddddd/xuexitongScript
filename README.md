# 学习通全自动刷课脚本

> 一个把我自己从「无限重复点击」里捞出来的工程。
> 6 万余行源码，81 个编号故障，从真机上一条一条抠出来的。
> 写到后面已经不是「刷课脚本」，而是一套**针对特定 SPA 的自动化基础设施**。

[![CI](https://github.com/ywdddddddddd/xuexitongScript/actions/workflows/ci.yml/badge.svg)](https://github.com/ywdddddddddd/xuexitongScript/actions/workflows/ci.yml)

---

## 这是什么

超星学习通（chaoxing.com）的课程页面是一套**重度 SPA + iframe 嵌套 + 反自动化**的前端。视频要定时心跳、文档要真实滚动、测验要过字体混淆、作业要过答案匹配、考试只有 4 分钟窗口。

这个项目做的事很简单也很偏执：**把这些全部自动化，并且做到「没人看着也不出错」。**

它不是一个「一键脚本」。它是一套带状态机、带断点续跑、带自愈、带故障知识库的系统。持续跑了几个月，经历了：

- 平台 6 次前端改版
- 字体反爬从「图片干扰」升级到「字形哈希」
- 一次把自己**误提交**了的真实事故
- 一次被判定风控后的人工解封
- 81 个编号故障，每个都有真机证据与复现路径

**这个仓库是那 81 个故障的完整答卷。**

---

## 它能做什么

| 任务点类型 | 支持 | 说明 |
|---|---|---|
| 视频 | ✅ | 定时心跳 + 倍速锁定 + 静音播放；断点续跑 |
| 音频 | ✅ | 同视频链路 |
| 文档 / PPT / PDF | ✅ | 真实滚动（触发平台的 scroll 判定），非伪造 |
| 章节测验 | ✅ | 取题 → LLM 作答 → 落值 → 三重校验 → 提交 |
| 作业 | ✅ | 同上；可选「只存草稿」或「直接提交」 |
| 考试 | ✅ | 4–6 分钟窗口的抢答；答题页需先过「考试须知」 |
| 随堂练习 | ✅ | 窗口常仅 1–2 分钟，需高频轮询 |
| 问卷 / 评价 | ✅ | 全选最优 + 开放性作答 |
| 投票 | ✅ | 同随堂链路 |
| 讨论 | ✅ | LLM 生成回帖；**实操/上传类自动跳过**（见下） |
| 直播 / 阅读 | ✅ | 心跳保活 |
| 签到 / 选人 | ❌ 有意不做 | 需位置与手势，属人工范畴 |
| 任务/作品（拍视频、雕刻） | ❌ 有意不做 | 需真实交付物 |

### 反爬对抗

| 对抗手段 | 处理 |
|---|---|
| `font-cxsecret` 字形混淆 | 解析 TTF → 算 glyf 坐标哈希（MD5）→ 查 709KB 映射表 → 还原明文 |
| iframe 多层嵌套 | 递归帧遍历 + 帧内执行上下文切换 |
| `mouseout`/`visibilitychange` 反挂机 | 拦截事件，伪造焦点与可见性 |
| 定时心跳 | 对齐平台节奏重发，不提前不漏发 |
| 滚动判定 | 真实 `scrollTop` 推进 + `dispatchEvent`，不是 `scrollTo` 作弊 |
| 页面改版 | 每个选择器都有 fallback 链与「结构指纹」验证 |

---

## 为什么说它「疯狂」

**81 个编号故障。** 不是 81 个 TODO，是 81 次真实翻车 + 定位 + 修复 + 回归测试。摘几个：

| 编号 | 事故 | 教训 |
|---|---|---|
| **F7** | `--dry`（试运行）仍然真实提交了作业 | 开关不透传 = 没有开关 |
| **F19** | 落值校验被空数组绕过，题没填就提交 | 「校验通过」必须先能证伪 |
| **F23** | 把推理模型的思考链当成答案发进了讨论区 | 输出清洗是一等公民 |
| **F47** | 字形哈希只命中 7/27 字，剩余静默变乱码 | 部分成功 = 失败 |
| **F54** | 字体缓存永久化，后续页面新字体永远收不进来 | 缓存要能失效 |
| **F60–F64** | 一个死循环被自动重启放大成**数小时空转** | 故障会自我放大，熔断优先于重试 |
| **F65** | 在「请上传雕刻作业」的帖子下发了 241 字学习心得 | 答非所问比不做更糟 |

还有一次 **决策级错误**：曾因判定失误，把一份已完成的作业标记为「待办」并重做，产生了重复提交。此后引入「平台侧终态优先于本地推断」的铁律。

> 完整编号索引见 [ISSUES_REVIEW.md](ISSUES_REVIEW.md)。

---

## 三条铁律

这三条是血换来的，所有后续改动不得违反：

1. **不伪造完成。** 视频必须真播、文档必须真滚、作答必须真落值。任何「标记为已完成」的捷径都不写。
2. **平台侧终态优先。** 本地状态机说「待办」而平台说「已完成」，一律信平台，且不回写。
3. **可疑即停。** 出现风控提示、验证码、异常跳转，立即熔断并留证，不重试、不硬刚。

外加一条设计哲学：**实操类任务绝不代做。** 收作品照片/雕刻/视频的帖子，脚本只标记为「需人工」，不生成任何替代内容 —— 回一段文字说「已上传附件」是谎言。

---

## 架构

```
┌──────────────────────────────────────────────────┐
│  userscript（v3_optimized.js，单文件 ~6.7k 行）    │
│  ├ 任务点引擎：视频/文档/音频/直播                 │
│  ├ 测验引擎：取题 → LLM → 落值 → 校验 → 提交      │
│  ├ 反爬层：字体解密 / 事件伪造 / iframe 遍历       │
│  └ 状态机：断点续跑 + 平台侧对账                   │
└────────────────────────┬─────────────────────────┘
                         │ 构建注入
┌────────────────────────▼─────────────────────────┐
│  v3_optimized.user.js（构建产物，~1.1MB）          │
│  可直接装入 Tampermonkey                          │
└──────────────────────────────────────────────────┘

     ┌─────────────── 测试体系 ───────────────┐
     │  verify-v3   双入口同步校验            │
     │  regression  回归（500+ 断言）         │
     │  adversarial 对抗（反向约束，只增不减） │
     └────────────────────────────────────────┘
```

**单一真源**：所有逻辑写在 [v3_optimized.js](v3_optimized.js)，[v3_optimized.user.js](v3_optimized.user.js) 由 [scripts/build-userscript.mjs](scripts/build-userscript.mjs) 生成。**手改产物 = 下次构建被覆盖**。

**对抗测试**是刻意设计的反向约束：它扫描源码，禁止出现 `fetch(` / `XMLHttpRequest` / `$.ajax` / `localStorage` / `document.cookie` / `stopPropagation` / `preventDefault` / `mouseout` 等一切可能削弱自动化稳定性或引入隐私风险的写法。**只许收紧，不许放宽。**

---

## 快速开始

### 1. 装油猴脚本

```bash
# 从源码构建
node scripts/build-userscript.mjs
```

然后在 Tampermonkey 里安装 `v3_optimized.user.js`。

或直接安装仓库里已构建好的版本。

### 2. 配置

首次运行会在控制台引导配置。以下是**全部默认值**（与代码 pp.configs 逐项一致，CI 会校验）：

```javascript
playbackRate: 1.0
autoplay: true
retryInterval: 2000
maxRetries: 10
videoCheckInterval: 1000
videoFailTextSkip: true
guardNoProgressMs: 7000
guardResumeCooldownMs: 1500
guardPausedGraceMs: 1200
guardRecoveryProbeMs: 2500
guardSeekBackSeconds: 0.15
guardSeekBackMaxPerUnit: 2
playTimeoutMs: 8000
resumeMaxAttemptsPerUnit: 5
userPauseWindowMs: 2500
autoAdvanceNoVideo: false
maxConsecutiveNoVideoAdvances: 3
concurrentPlayback: false
concurrentLanes: 2
laneKeeperIntervalMs: 3000
laneMaxReplaysPerUnit: 240
videoFrameMaxDepth: 4
interactionGuard: true
interactionPollMs: 1500
interactionFaceWait: true
taskDialogClickCooldownMs: 8000
taskDialogMaxClicksPerUnit: 3
videoTaskFrameMaxDepth: 4
videoTaskFrameMaxCount: 12
chapterCountCrossCheck: true
videoCompleteRatio: 0.9
pauseGuard: true
cxSecretDecode: true
cxSecretFontMode: 'auto'
chapterStudyCount: 0
chapterStudyDelayMs: 2500
workSanityLock: true
docTaskScroll: true
docTaskScrollStepMs: 800
docTaskMaxMs: 240000
docTaskWaitMs: 45000
docTaskAttempts: 2
discussTaskAuto: true
discussReplyText: ''
discussTaskWaitMs: 60000
guiEnabled: true
guiMaxLogLines: 60
llmEnabled: false
llmEndpoint: 'https://opencode.ai/zen/go/v1/chat/completions'
llmModel: 'deepseek-v4-flash'
llmModelFallbacks: []
llmModelFallbackOn: false
llmMaxTokens: 2048
llmJsonMode: true
llmTimeoutMs: 30000
llmRetryIntervalMs: 60000
llmMaxRetries: 5
llmSkipNodeAfterRetries: true
surveyDetect: true
surveyAutoFill: true
surveySubmit: true
llmMinIntervalMs: 800
liveGuard: true
llmMaxAnswersPerSession: 50
llmAutoSubmit: false
llmChapterTest: false
llmEmbeddedWork: false
llmWorkWaitMs: 90000
llmAnswerSeparators: '===,#,---,###,|,;,；,、'
workDraftOnUncertain: true
randomFallbackOnUncertain: false
breakingModeGuard: true
breakingModeStuckThreshold: 3
questionCacheEnabled: true
questionCacheMax: 500
judgeOptionNormalize: true
workSubmitMinRate: 0
timereaderAuto: true
hyperlinkAuto: true
pptAudioAuto: true

```

**几个需要注意的**：

| 配置 | 默认 | 说明 |
|---|---|---|
| `cxSecretDecode` | `true` | 字体反混淆。关掉的话所有题目都会是乱码 |
| `cxSecretFontMode` | `auto` | `auto` 哈希优先、失败回退位图；`hash` 只用哈希；`bitmap` 只用位图 |
| `autoExam` | `false` | 考试自动作答。**默认关闭**，开启前请读免责声明 |
| `workSubmitMode` | `draft` | 作业：`draft` 只存草稿 ｜ `submit` 直接提交 |

### 3. 自检

页面控制台会输出当前识别到的任务点、状态机快照、以及字体解密命中率。**看到「命中 27/27」才算健康**，部分命中意味着该批文字会变乱码。

---

## 测试

```bash
npm install --no-save jsdom@24 jquery@3.7.1

node tests/verify-v3.mjs      # 双入口同步
node tests/regression.mjs     # 回归
node tests/adversarial.mjs    # 对抗
```

三个都过才算可以发布。CI 会在每次 push 时跑同一套。

**测试里最有价值的是三类夹具**：

- **真实字体夹具**（`tests/fixtures/font-cxsecret/`）：真实混淆字体 + 真实映射表子集，验证解密与上游一致
- **落值夹具**：真实 DOM 结构，验证「点上去」而不是「算出来」
- **虚拟时钟**：所有定时逻辑在 jsdom + 假时钟下跑，不靠 `sleep`

> 一条硬性经验：**落值类 bug 只有真跑才炸**。纯静态测试永远发现不了「选择器匹配到了但没点中」。所以关键路径都配了可执行的 DOM 夹具。

---

## 目录

```
.
├── v3_optimized.js          # 单一真源（核心，~6.7k 行）
├── v3_optimized.user.js     # 构建产物（勿手改）
├── resource/
│   ├── font-map-data.js     # 字形哈希表（709KB 紧凑格式）
│   └── font_map_table.json  # 上游完整表（1.5MB，参考用）
├── scripts/build-userscript.mjs
├── tests/
│   ├── verify-v3.mjs        # 双入口同步
│   ├── regression.mjs       # 回归
│   ├── adversarial.mjs      # 对抗约束
│   └── fixtures/            # 真实字体等夹具
├── docs/
│   ├── UPGRADE-V3.7-SUMMARY.md
│   └── legacy/              # v3.0.0 历史版本
├── img/                     # 截图
└── ISSUES_REVIEW.md         # 故障编号索引
```

---

## 已知限制

- **只测过 Chrome**。Firefox/Safari 未验证（字体哈希依赖 `canvas` 与 `FontFace` 行为）
- **只覆盖 PC 端网页**。移动端与 App 页面结构不同
- **字体表有覆盖上限**。不在表内的字仍会解不出 —— 表现为部分乱码，不是全部正常
- **考试自动作答默认关闭**。开启前请想清楚：多数考试有防作弊与人脸核验，且窗口只有 4–6 分钟，出错没有补救余地
- **平台改版会让脚本失效**。这是常态，不是 bug。每次改版都需要重新抓结构

---

## 免责声明

**这个项目只为技术研究与个人学习效率。**

它绕过的是**前端交互的重复劳动**，不是**学习本身**。用不用、怎么用，是你自己的判断：

- 学校与平台的使用条款可能禁止此类自动化
- 自动化完成的学习记录，知识不会因此进入你的脑子
- 遇到风控、封号、成绩异常，责任在使用者

作者不对任何使用后果负责。

如果你在考试里用它 —— 那 4 分钟窗口换来的一张成绩单，代价是这门课真正想教你的东西。**这个脚本最不该被用在一场你本可以自己考过的考试上。**

---

## 致谢

- [Samueli924/chaoxing](https://github.com/Samueli924/chaoxing) —— `font-cxsecret` glyf 哈希解密算法的上游实现
- [OCSJS](https://github.com/ocsjs/ocsjs) —— 早期架构思路参考

---

<p align="center">
<sub>81 个编号故障 · 6 万余行 · 一个不想再手点视频的人</sub>
</p>
