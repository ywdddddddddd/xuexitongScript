# v3.7 升级交付总结（上游 ocsjs 移植 + 全面升级）

本文件是本轮升级的索引，记录**做了什么、证据在哪、哪些还没做**。
上游参照物：`ocsjs/ocsjs` 4.0 分支（`packages/scripts/src/projects/cx.ts` 2317 行、`common.ts` 1854 行）
与 `ocsjs/ocs-desktop` 主分支（Electron 桌面端）。

## 1. 回归基线（每次改动都必须全绿）

```
cd repo
node --check v3_optimized.js
node scripts/build-userscript.mjs      # 产物重建（源码是唯一真源）
node tests/verify-v3.mjs               # 源码↔产物逐字节同步 + 语法
node tests/regression.mjs              # 564/564
node tests/adversarial.mjs             # 49/49（且必须 exit 0）
```

> `tests/regression.mjs` **带 BOM，不要对它 node --check**。
> `adversarial.mjs` 有「验证目标稳定性」自检：若源码在运行期间被改动会 exit 1（并行开发时常见），属正常保护而非缺陷。

## 2. 脚本内核（`repo/v3_optimized.js`）

| 编号 | 能力 | 上游依据 | 关键设计 |
|---|---|---|---|
| F66 | 视频坏片显式跳过 | cx.ts:1742-1753 | 四条中文文案探测；**双入口**（`_checkVideoStatus` + 常驻轮询）——只挂前者会永不触发，因为视频监控仅在 play 成功后启动 |
| F67 | 章节未完成数交叉校验 | cx.ts:1138-1145 | `getTeacherAjax` + `input.jobUnfinishCount` 作第二数据源；**不一致时以服务端为准**（用户明确要求），但保留 total=0 安全停止护栏 |
| F68 | 人脸识别等待 | cx.ts:2221-2300 | 复用既有「暂停等人工→自动恢复」状态机；闸门加在 play()/nextUnit() |
| F70 | 闯关/解锁模式 | cx.ts:1087-1114 | 旗帜类识别 + 按节点计数，达阈值安全停止并复位计数；计数表有上限防无界增长 |
| F71 | 题库缓存复用 | common.ts:1391-1453 | sessionStorage + 内存回落；命中即跳过 LLM；**只在平台确认后才写入** |
| F72 | 判断题选项归一 | cx.ts:2051-2076 | True/False/對/錯/正确/错误 → 对/错 语义；含纯图标判定；**只改提取层不改 DOM**（改 DOM 会污染平台读取的选项文本） |
| F73 | 完成率提交闸门 | worker.ts:332-360 | 默认 0 = 完全不改变既有行为；>0 才要求「完成率达标 且 llmAutoSubmit=true」 |
| F74 | 长时阅读 | cx.ts:1802-1813 | 解析 timing 秒数；等待可被 destroy 清理且重入幂等；已完成让位既有流程 |
| F75 | 链接任务点 | cx.ts:2146-2155 | 未照搬上游 onclick 替换（拦不住 addEventListener）；改用捕获阶段 returnValue=false + 临时接管 window.open/alert，finally 还原 |
| F76 | 带音频 PPT | cx.ts:2127-2142 | swiper 类型识别，命中即不走滚动翻阅分支 |
| F79 | 连线题（题型 11） | cx.ts:1954-1985 | 收集 `.thirdUlList .dept_select select`；**分段数必须等于下拉框数**才作答，否则整体拒绝（绝不错位配对） |
| F80 | 填空 iframe 编辑器 | cx.ts:1932-1944 | 三条降级路径：UEditor → iframe（写 body + 派发事件 + 点保存）→ 普通 textarea |
| F81 | 随机兜底作答（可选） | cx.ts:2003-2045 | 默认关闭；开启后随机选一个但**标注不确定、绝不写入题库缓存** |

## 3. 桌面端（`app/`，不在 git 仓库内 → 靠 `_backup/app-desktop-*` 快照保护）

| 能力 | 要点 |
|---|---|
| 全部启动 / 全部停止 / 下发配置 | 启动复用单个 `start()` 的队列语义（不绕过并发上限）；停止**先清队列再停运行中**（反过来会被 `pump()` 立刻重新拉起） |
| 配置批量下发 | 与单个 `config:set` 共用 `pushConfigKey`，一次 IPC 推全量，避免 N 项 × M 账号串行往返 |
| 文件夹树 / 标签 / 备注 / 拖拽 | 元数据原子写（先 .tmp 再 rename）；拖拽归类 + 下拉筛选双路径 |
| 多画面看板 | 「单视图 / 四格 / 九格」用 `capturePage()` 每 5 秒抓帧；**隐藏视图也能抓帧**，故不改动既有单视图布局语义 |
| 批量上号 | 整段粘贴 `账号,密码` 或 `备注,账号,密码`；**串行**建账号（并发建 N 个 WebContentsView 会瞬间吃满内存） |
| 视图崩溃自愈 | `render-process-gone` → 3 秒冷却后重建视图，同账号 60 秒内最多 3 次，超限停在错误态等人 |
| 账号元数据持久化 | `accounts-meta.json` 只存 username/label/folderId/tags/note/order；**密码不落盘**，冒烟自检含 `leaksPassword` 断言 |

`app/` 的自检入口：`npx electron . --smoke --data-dir <隔离目录>` → `smoke-result.json`
（覆盖：UI 结构、批量解析、看板模式切换、文件夹 CRUD、元数据落盘与密码不泄漏）。

## 4. 测试守护（本轮新增 96 条断言，全部覆盖此前零测试的改动）

- F65 问卷（21 条）：安全阀、已作答题不重问、提交按钮精确匹配、开关生效
- F69 服务端计数优先（11 条）：含 total=0 护栏反例
- F77 F70-F76 行为固定（31 条）
- F78 提交闸门（6 条）：默认关闭 + 放行条件锁定
- F79 连线题（14 条）、F80 填空 iframe（7 条）、F81 随机兜底（6 条）

**鉴别力验证方式**：对补丁前源码跑断言应为 RED。本轮用**变异测试**证明——
故意破坏「已作答题跳过」「提交按钮精确匹配」「问卷作答本体」三处，
对应断言分别精确变红（`480/489`、`487/489`、`487/489`）。

## 5. 本轮踩到并修掉的坑

1. **行数基准**：PowerShell `Get-Content` 对纯 LF 文件会少算行数（5310 报成 4890），行号定位全部漂移 → 用 `tools/count-lines.mjs`（Node 口径）。
2. **README 配置块单向校验**：`F7-2` 只校验「README 有而代码无」，**代码有而 README 无不报错** → 新增配置项可以长期不出现在文档里而测试全绿（本轮实测缺 12 项）。用 `tools/compare-configs.mjs` 做双向校验。
3. **分隔符自指**：`llmAnswerSeparators` 用半角逗号分隔配置项，导致半角逗号本身无法作为候选分隔符（而 LLM 最常用它）→ 配置串不含该字符，代码里再补。
4. **编码假象**：`multi-soak-*.log` 看似乱码，实为 PowerShell 用 GBK 解码 UTF-8 的**显示**问题，文件本身完好（Node 读乱码替换符数 = 0）。写文件仍要避开 PowerShell `Add-Content`（会引入 CRLF 与 BOM）。
5. **改源码必须重建产物**：`adversarial` 的 A1 会逐字节比对 payload；源码改了不重建就红。

## 6. 已知增量（本轮未做，供后续决策）

- **宿主侧分类器未同步**：`app/src/injector.js` 的类型普查不认识新增的 `hyperlink` 类型，
  扫码时会把链接任务点计入 `other`（匹配率分母偏保守）。**只影响统计展示，不影响实际执行**。
- **全部改动只在 jsdom + 虚拟时钟下验证**，未上真机。建议真机抽查：F74 的真实等待时长、
  F75 的真实弹窗拦截、F76 的跨域回退、F67 的服务端计数在真实目录结构下的可得性。
- **F71 缓存强度**：作业侧写入依据是「平台接受提交」（任务点完成/待批阅），**不等于逐题判对**；
  已在 README 提供 `questionCacheEnabled=false` 关闭。
- **`app/` 无版本控制**：桌面端改动只能靠快照备份（`_backup/app-desktop-*`）。
  如需纳入 git，需要先决定目录结构（`repo/` 是独立仓库）。
