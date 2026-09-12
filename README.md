# 学习通自动刷课脚本 V3.5

当前版本以 [v3_optimized.js](v3_optimized.js) 为唯一源码，油猴版 [v3_optimized.user.js](v3_optimized.user.js) 必须由 [scripts/build-userscript.mjs](scripts/build-userscript.mjs) 生成（不要手改油猴文件）。

V3.4 在 V3.3 稳定版的基础上，针对线上 55 条反馈里最高频的六类缺陷做了收敛式修复。每处改动都能回溯到具体 issue 编号，细节见 [变更记录](../docs/CHANGELOG-v3.4.md)。

V3.5 在 V3.4 基础上新增两项能力：**F9 GUI 可视化监控面板**（默认开启，纯本地）与 **F10 可选 LLM 互动题应答**（默认关闭，需显式开启并提供密钥）。默认配置下全脚本仍保持零外部网络请求。

## 本版修复一览

| 编号 | 线上问题 | 对应反馈 | 修复方式 |
| --- | --- | --- | --- |
| F1 | 导航死锁：切换失败后脚本再也不动了 | #9 #24 #27 #37 #50 | `nextUnit()` 的**所有**退出路径（无视频、触顶重试、静音失败、课程完成、解析失败、异常）都释放导航锁，失败的 `play()` 之后仍可继续切换 |
| F2 | 一个章节只播第一个视频 / 跳错章节 | #14 #15 #24 #27 #37（PR #49、PR #48 思路） | 「当前节点下标」与「同章节点集合」统一由 `_resolveCatalogPosition()` 解析，支持 active 落在父/子节点；并按 PR #48 的视频任务点模型（`_getVideoTaskFrames()` / `_getNextPendingVideoTaskIndex()`）在同一小节内先播完未完成的视频任务点再切小节；解析失败时明确报错并停止，不再静默跳章 |
| F3 | 无视频/纯课件小节卡死 | #38 #42 #43 #50（PR #48 思路） | 只有识别出「已完成/无任务点」才自动前进；识别不出来时安全停止并打印处理方法；连续自动前进不超过 `maxConsecutiveNoVideoAdvances`。另按 PR #48 的思路处理平台弹窗「当前章节还有任务点未完成」：点「去学习/去完成」回到未完成任务点（冷却 + 每小节次数上限），而不是点「下一节」硬闯 |
| F4 | 异常暂停反复抢播、弹出验证码 | #19 #26 #32 #54 #55（台阶依据 PR #56 的《ISSUES_REVIEW V3.4》） | 删除 document/window 上的 mouseout/mouseleave 事件劫持；判断「真播放」改为跟踪 `currentTime` 是否增长；保活阶梯＝每秒检查 → 7 秒无进度 → `pause/play` → 2.5 秒复检 → 仍无进度则回拨 0.15s 重播（回拨与恢复共用每小节 5 次预算）；恢复只在「非用户主动暂停且进度确实停滞」时触发；`play()` 有 8 秒超时保护；`destroy()` 清理全部定时器 |
| F5 | 视频中弹互动题后卡死 | #29 #39 #42（参考 PR #53 的检测思路） | 默认：检测到互动答题弹窗时暂停自动跳转并提示人工处理；显式开启 `llmEnabled` 后可选由 LLM 选择答案（F10），失败/未配置密钥一律回退人工 |
| F9 | 运行情况只能看控制台，不直观 | V3.5 | 右上角注入可折叠 GUI 监控面板：状态、进度、LLM 状态、实时日志与快捷按钮；纯本地 DOM，默认开启（`guiEnabled`） |
| F10 | 互动题需要人工作答，挂机中断 | #29 #39 #42 #45 | 可选接入 OpenAI 兼容大模型接口（默认 `deepseek-flash`）：提取题干+选项→严格 JSON 输出→按答案点选；默认半自动（`llmAutoSubmit=false`），零密钥/超时/解析失败自动回退人工 |
| F6 | 少量播放器识别不到 | #18 #52 #55（PR #48 的 frame 守卫思路） | 选择器覆盖 `video#video_html5_api`、`[id*=video_html5]`、`.vjs-tech`、`[src]`；嵌套 frame 搜索深度上限 `videoFrameMaxDepth`；切换小节或 iframe 重载时显式失效视频缓存；跨域 frame 抛 `SecurityError` 时静默跳过，不打印硬错误 |
| F7 | 粘完没反应、文档链接 404 | #4 #5 #12 #16 #17 #23 #33 #47 | 启动超时/目录未就绪/jQuery CDN 被拦截时给出可操作提示；README 内链接全部指向仓库内真实文件，默认配置与代码保持一致 |

## 文件说明

- [v3_optimized.js](v3_optimized.js) —— 唯一源码（控制台直接执行版）
- [v3_optimized.user.js](v3_optimized.user.js) —— Tampermonkey 油猴版（构建产物）
- [scripts/build-userscript.mjs](scripts/build-userscript.mjs) —— 由唯一源码生成油猴版
- [tests/verify-v3.mjs](tests/verify-v3.mjs) —— 校验两个入口逐字节同步且语法合法
- [tests/regression.mjs](tests/regression.mjs) —— jsdom 回归测试（F1-F10，不联网；LLM 用例使用注入传输，零真实网络）
- [ISSUES_REVIEW.md](ISSUES_REVIEW.md) —— V3.3 时期的问题复盘
- [README_v2.md](README_v2.md)、[v2.js](v2.js) —— 历史版本的说明与 V2 脚本
- [xuexitong.js](xuexitong.js) —— **历史版本（V1 控制台版），已不再维护**：本次只做了最小加固（入口点击的空值保护与多选择器兜底，F8），倍速、iframe 取视频等逻辑保持原样。**请不要再直接粘贴 V1 使用**，新用户请用 [v3_optimized.js](v3_optimized.js)
- [学习通自动刷课助手.user.js](学习通自动刷课助手.user.js) —— v3_tampermonkey 分支的**独立 V3.0.0** 油猴脚本（自带可视化控制面板）；本次合并仅归档保留，**未同步到 V3.4**，不在维护范围（详见下文「脚本形态与界面说明」）
- [docs/legacy/README-v3.0.0.md](docs/legacy/README-v3.0.0.md)、[docs/legacy/v3_optimized-v3.0.0.js](docs/legacy/v3_optimized-v3.0.0.js) —— 分支合并时保留的 V3.0.0 快照

## 默认配置

```javascript
playbackRate: 1.0
autoplay: true
retryInterval: 2000
maxRetries: 10
videoCheckInterval: 1000
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
videoFrameMaxDepth: 4
interactionGuard: true
interactionPollMs: 1500
taskDialogClickCooldownMs: 8000
taskDialogMaxClicksPerUnit: 3
videoTaskFrameMaxDepth: 4
videoTaskFrameMaxCount: 12
guiEnabled: true
guiMaxLogLines: 60
llmEnabled: false
llmEndpoint: 'https://opencode.ai/zen/go/v1/chat/completions'
llmModel: 'deepseek-flash'
llmMaxTokens: 4096
llmJsonMode: true
llmTimeoutMs: 30000
llmMaxAnswersPerSession: 50
llmAutoSubmit: false
llmChapterTest: false
```

关键项说明：

- `playbackRate`（默认 **1.0 原速**）：学习通每 60 秒向 `multimedia/log` 上报一次观看时间，部分课程要求观看时长达到 100%，1.5 倍速容易学时不达标（#28 #31）且更容易触发反作弊（验证码，#54）。这是**平台约束，不是脚本缺陷**；需要倍速可手动调高：`app.configs.playbackRate = 2; app.run()`。脚本只设置一次倍速，**不做任何 `ratechange` 强制回写对抗**。
- `autoAdvanceNoVideo`（默认 **false**）：无视频小节在**无法识别完成状态**时是否仍然前进。默认关闭，此时脚本安全停止并提示；把它设为 `true` 后脚本会按上限有界前进。若节点自身带完成标记（例如完成图标），即使保持 false 也会自动前进。
- `maxConsecutiveNoVideoAdvances`（默认 3）：连续自动前进的上限，防止在异常目录结构里死循环。
- `resumeMaxAttemptsPerUnit`（默认 5）：每个小节内最多主动恢复播放的次数；`guardResumeCooldownMs` 是两次恢复之间的冷却。连续抢播 `pause` 会显著提高触发平台风控/验证码的概率（反馈 #54）。
- `videoFrameMaxDepth`（默认 4）：嵌套 iframe 的搜索深度上限，带自我保护，不会无限递归。
- `guardRecoveryProbeMs` / `guardSeekBackSeconds` / `guardSeekBackMaxPerUnit`（默认 2500ms / 0.15s / 2 次）：保活阶梯的第二、三级——恢复动作后 2.5 秒复检，仍无进展才轻微回拨并重播；回拨次数与恢复次数共用「每小节 5 次」预算。
- `playTimeoutMs`（默认 8000ms）：`play()` Promise 超时保护——媒体管线冻结时 `play()` 可能既不成功也不失败，超时后按播放失败走重试/静音兜底。
- `interactionGuard`（默认 true）：检测视频互动答题弹窗并暂停自动跳转；脚本不会自动答题。
- `taskDialogClickCooldownMs` / `taskDialogMaxClicksPerUnit`（默认 8000ms / 3 次）：处理平台「当前章节还有任务点未完成」弹窗时的冷却与每小节次数上限，避免反复点击（#43 #54）。
- `guiEnabled`（默认 **true**）：右上角可视化监控面板，显示播放状态、进度、LLM 状态与实时日志；纯本地 DOM，不产生网络请求。
- `llmEnabled`（默认 **false**）：是否允许调用大模型自动选择互动题答案。开启前先配置密钥（面板「设置 Key」或 `app.setLlmKey(...)`，密钥只存内存、绝不落盘）。
- `llmMaxTokens`（默认 **4096**）：实测推理 token 可达 1600+，1024 会耗尽配额导致空响应（`finish_reason=length`），不建议调小。
- `llmJsonMode`（默认 **true**）：请求体带 `response_format:{"type":"json_object"}`，约束模型只输出 JSON；自定义端点不支持该参数时设为 `false`。
- `llmAutoSubmit`（默认 **false**）：半自动档——脚本只替你选定答案，提交/继续按钮留给你点；设为 `true` 才会自动提交。
- `llmChapterTest`（默认 **false**，实验性）：章节测验页只在面板给出建议答案，**绝不自动点击**；识别失败自动回退「受限跳过」。
- `videoTaskFrameMaxDepth` / `videoTaskFrameMaxCount`（默认 4 / 12）：小节内视频任务点 iframe 的递归深度与数量上限，带自我保护。
## 使用方法

### 方法一：浏览器控制台

1. 打开学习通课程播放页（地址含 `/mycourse/studentstudy`），等左侧目录加载出来
2. 按 `F12` 打开控制台
3. 复制 [v3_optimized.js](v3_optimized.js) 的全部内容，粘贴并回车

常用命令：

```javascript
app.run()                       // 重新初始化并接管播放
app.nextUnit()                  // 手动切换到下一小节
app.resumeAutoPlay()            // 取消「用户主动暂停」状态，恢复自动保活
app.configs.autoAdvanceNoVideo = true   // 确认安全后允许无视频小节有界自动前进
app.destroy()                   // 停止脚本并清理所有定时器与监听
```

### 方法二：Tampermonkey

1. 安装 Tampermonkey
2. 导入 [v3_optimized.user.js](v3_optimized.user.js)
3. 确认脚本已启用
4. 刷新学习通播放页

### 方法三：书签方式（一次性使用）

> 适合不想装扩展、只想临时用一次的场景。注意：书签方式每次进入播放页都要手动点一次。

1. 在浏览器里新建一个书签，名称随意（例如「学习通刷课」）
2. 书签网址填 `javascript:` 加上 [v3_optimized.js](v3_optimized.js) 的**全部内容**（浏览器对书签里的换行较敏感时，可先用任意 bookmarklet 压缩工具把代码压成一行）
3. 打开学习通课程播放页，点击该书签即可运行

说明：

- 本版脚本自己会处理 jQuery 缺失（补一次 CDN）与「课程目录尚未渲染完」的等待，所以书签里**不需要**再套一层 `setInterval` 或 `window.app = {...}` 的包装；
- 书签方式**不会**出现可视化控制面板，控制面板属于下面「脚本形态与界面说明」里的历史产物 `学习通自动刷课助手.user.js`（V3.0.0）；
- 如果你抄的是 [docs/legacy/README-v3.0.0.md](docs/legacy/README-v3.0.0.md)（v3_tampermonkey 分支 README）里的老书签代码，那份书签内嵌的是 **V3.0.0 时代的旧实现**（倍速 2、没有导航锁、没有无视频节点与互动题处理），不建议继续使用。

## 已知限制（服务器端限制，脚本无法绕过）

- **倍速与任务点由服务端判定**：部分课程会忽略本地倍速、把播放器重设为 1x，或要求完整观看才计有效观看时长（#3 #6 #28 #31）。这是平台强约束，不是脚本 bug：因此默认已改为 **1.0 原速**（依据 PR #56 的实测与 PR #48 的自测，两者独立指向同一结论）。本脚本只设置一次 `playbackRate`，**刻意不做 `ratechange` 强制回写**（那类对抗正是 #32 #54 反复暂停/风控的来源之一）。需要更快可手动调高，但可能不产生有效观看时长或触发风控：`app.configs.playbackRate = 2; app.run()`。
- **互动题与章节测验必须人工完成**：#29 #39 #42 #45 相关需求要求作答考核题，脚本只做「检测 + 暂停 + 提示」，不实现自动答题，也不接入任何大模型。
- **频繁抢播可能触发风控**：本版主动限制恢复播放的次数与频率（#19 #26 #32 #54）。
- **无完成标记的无视频节点无法自动判断**：目录里既没有视频、又没有完成/无任务点标记时，脚本会安全停止，需要人工确认后执行 `app.nextUnit()`（#38 #43）。
- **页面结构变化**：如果学习通再次改版，可能出现「找不到视频列表」「无法解析当前课程节点」等日志。这类日志都带有处理方法，按提示刷新或手动点选小节即可。

## 维护与验证

修改 [v3_optimized.js](v3_optimized.js) 后，依次执行（在仓库根目录）：

```bash
node scripts/build-userscript.mjs   # 重新生成油猴版
node tests/verify-v3.mjs            # 校验两入口逐字节同步 + 语法
node tests/regression.mjs           # F1-F10 回归测试（jsdom，不联网）
```

`tests/regression.mjs` 支持用环境变量指向其它源码，用来确认用例能捕获缺陷，例如：

```bash
XT_SOURCE=../br/master/xuexitongScript-master/v3_optimized.js node tests/regression.mjs
```

## 脚本形态与界面说明

V3.5 在原有控制台交互（`app.run()` / `app.nextUnit()` / `app.resumeAutoPlay()` / `app.destroy()`）之外，默认注入右上角 GUI 监控面板（`guiEnabled`，可关闭）；日志按级别带颜色，并同步镜像到面板。新增的 LLM 应答默认关闭，详见下文「GUI 面板与 LLM 应答」。

历史产物说明（本次分支合并后**仅归档保留，不在维护范围**）：

- [学习通自动刷课助手.user.js](学习通自动刷课助手.user.js) —— 来自 `v3_tampermonkey` 分支的**独立** V3.0.0 油猴脚本，自带右上角可视化控制面板（开始 / 停止 / 下一节、倍速显示）。它与 [v3_optimized.user.js](v3_optimized.user.js) 是两套不同实现，**没有**同步到 V3.4，也不参与本仓库的构建与校验；如需使用请自行评估其行为。
- [docs/legacy/README-v3.0.0.md](docs/legacy/README-v3.0.0.md) —— 该分支的 README（含控制面板说明、FAQ、版本历史）。

## GUI 面板与 LLM 应答（V3.5 新增）

### GUI 可视化面板（默认开启）

脚本运行后会在页面右上角注入一个可折叠的监控面板，用于人眼验证脚本运行情况：

- 状态行：播放/空闲、当前学习步骤、互动题是否处于暂停；
- 进度行：章节序号 / 视频任务点序号；
- LLM 行：开关、密钥是否已配置、本次会话已应答数、是否自动提交；
- 日志区：镜像控制台日志（最近 `guiMaxLogLines` 条）；
- 按钮：暂停/继续、下一节、LLM 开/关、自动提交开/关、设置 Key、清空日志。

关闭面板：执行 `app.configs.guiEnabled = false; app.run()`。面板为纯本地 DOM，不产生任何网络请求。

### LLM 互动题应答（默认关闭，需显式开启）

- 默认 `llmEnabled: false`：不开启时行为与旧版一致——检测到互动题只暂停并提示人工处理，全脚本零外部网络请求。
- 开启方式：面板点「LLM 开/关」，再点「设置 Key」粘贴密钥；或控制台执行 `app.configs.llmEnabled = true; app.setLlmKey('sk-...')`。
- 密钥只保存在**内存**（不写入 localStorage、不落盘、不进仓库），刷新页面后需要重新输入。
- 默认 `llmAutoSubmit: false`：只替你选定答案，提交/继续按钮留给你点；设为 `true` 才会自动提交。
- 传输：油猴版使用 `GM_xmlhttpRequest`（元数据已声明 `@grant GM_xmlhttpRequest` + `@connect opencode.ai`）。控制台直贴脚本没有该能力，可用 `app.setLlmTransport(fn)` 注入自己的传输实现，否则会打印明确错误并回退人工处理。
- 网关要求：每次页面会话生成一个稳定的 `x-opencode-session` UUID 并在会话内复用（缺失该头会被网关以 HTTP 400 拒绝）。
- 有界保护：单次会话最多应答 `llmMaxAnswersPerSession` 题；同一道题只请求一次；请求超时、响应解析失败、未配置密钥一律回退「暂停等人工」。
- 章节测验（计入成绩）默认仍只「受限跳过」；显式开启 `llmChapterTest` 后也只把建议答案显示在面板，**不会自动点击**，需人工确认提交。
- 请自行确认使用该功能符合所在课程与平台的规定。

## 常见问题（FAQ）

### 脚本粘完没反应？

1. 确认当前是课程**播放页**（地址含 `/mycourse/studentstudy`），不是课程首页
2. 等左侧目录渲染出小节节点后再执行 `app.run()`；控制台会打印「课程目录已出现，但 20 秒内没有渲染出任何小节节点」之类的提示
3. 如果看到「CDN 加载被浏览器/网络拦截」，改用油猴版，或手动引入 jQuery（广告拦截插件常拦 code.jquery.com）
4. 仍无效就刷新页面重试（#47 #33 #12 #16 #17）

### 视频还是暂停？

1. 如果是你自己点的暂停，脚本会打印「检测到用户主动暂停」，执行 `app.resumeAutoPlay()` 即可恢复自动保活
2. 如果没打印这句，说明是页面异常暂停：脚本会在「进度确实停滞」后按有界策略恢复，**每个小节最多 5 次**；触顶后提示「恢复播放次数已达上限」，此时请手动播放或刷新页面
3. 网络不稳、标签页被浏览器冻结也会导致暂停；保持前台并适当降低倍速会有帮助（#32 #54 #55）

### 控制台常见报错怎么处理？

- 「找不到视频列表」：不在课程播放页，或目录还没加载完
- 「视频组件尚未加载完成」：播放器 iframe 还没就绪，脚本会按 `retryInterval` 重试，最多 `maxRetries` 次
- 「无法解析当前课程节点」：目录里没有 `.posCatalog_active` 高亮（页面未渲染完或结构变化），脚本会停止自动跳转；手动点一下目标小节再 `app.run()` 即可
- 「当前小节未发现视频，且无法识别…已安全停止」：属于纯课件/已完成小节；确认无误后 `app.nextUnit()`，或把 `autoAdvanceNoVideo` 设为 `true` 让脚本有界自动前进（#38 #43）
- 「AbortError: The play() request was interrupted by a call to pause()」：多为播放器初始化时的瞬时中断，脚本会按停滞判定恢复，不是视频坏了（#19）

### 章节测验和互动答题会被自动完成吗？

默认不会。章节测验只做**受限跳转**（最多 3 次，避免页面循环）；视频中弹出的判断题/选择题会被检测到并**暂停自动跳转**，提示你手动完成。V3.5 起可选接入大模型：显式设置 `llmEnabled=true` 并提供密钥后，脚本会请求模型选择互动题答案（`llmAutoSubmit` 控制是否自动提交）；章节测验即使开启 `llmChapterTest` 也只给建议、不自动点击。默认配置下全脚本零外部网络请求（#29 #39 #42 #45 #57）。

### 为什么日志会重复出现？

同一次页面里重复粘贴执行脚本会导致多份定时器与监听叠加。刷新页面后只执行一次即可；使用油猴版时不要再在控制台重复粘贴。

### 日志颜色说明

| 颜色 | 含义 |
| --- | --- |
| 绿色 | 操作成功、视频开始播放 |
| 蓝色 | 状态信息、步骤切换 |
| 橙色 | 警告、重试与需要留意的降级行为 |
| 红色 | 错误、需要人工介入 |
| 紫色 | 视频切换/结束 |

## 版本历史

| 版本 | 来源 | 说明 |
| --- | --- | --- |
| V1.0 | `v1` 分支（`xuexitong.js`） | 初始版本，基础自动播放 |
| V2.0 | `v2_old` 分支（`v2.js`） | 重构结构、自动启动、快捷方法 |
| V3.0.0 | `v3_tampermonkey` 分支（`学习通自动刷课助手.user.js`） | 独立油猴脚本 + 可视化控制面板；本次合并归档到 `docs/legacy/` |
| V3.3 | master | 单一源码约定（`v3_optimized.js` + 构建脚本）、就绪等待、媒体事件生命周期、重复导航防护、章节测验受限跳转 |
| V3.4 | 本次整合（`v3_optimized.js`） | 修复 F1-F7：导航死锁、小节内多视频、无视频节点卡死、异常暂停与风控、互动弹窗、视频元素发现、启动与文档 |
| V3.5 | 本次（`v3_optimized.js`） | 新增 F9 GUI 可视化面板与 F10 可选 LLM 互动题应答（默认关闭）；修复 LLM 响应信封解析；油猴版元数据改为 `@grant GM_xmlhttpRequest` + `@connect opencode.ai` |
## 代码来源与致谢

- F2/F3/F6 中的「小节内视频任务点顺序播放」「任务点未完成弹窗处理」「跨域 frame 守卫」等实现思路移植自 **PR #48（作者 @CsuCook1e）**，相关函数在源码中以「思路移植自 PR #48 @CsuCook1e」注释标注；本版在其基础上收敛为有界动作，并保持单一源码 + 构建脚本约定。
- PR #48 的默认 1x 倍速 + `ratechange` 锁定回写路线本版**不采用**，原因见「已知限制」。

## 免责声明

本项目仅用于脚本调试、前端自动化研究与页面行为分析，请遵守目标平台的使用规定。请勿用于任何绕过课程考核或学术不端的行为。
