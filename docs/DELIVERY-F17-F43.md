# F17–F43 全局一致性检查与交付文档

> **角色**：全局一致性检查与整理（文档编辑 / 交付审计）
> **范围**：repo/ 本地未推送的 21 个提交（7a7a51a..45fa1c6，功能编号 F17–F43）及其关联的配置、文档、测试、构建产物
> **目的**：为推送/评审提供一次说清的交付包；从全局检查修复之间的冲突，避免局部最优破坏整体一致性
> **冲突判定维度**：内容矛盾、重复/被取代、优先级冲突、依赖冲突、编号/文档缺口
> **修改授权**：本次仅对 README 表述做对齐修正（代码行为零变更），并补齐 F25–F31 编号空档说明
> **验证快照**：回归 348/348 ｜ 对抗 49/49 ｜ 双入口同步 ✓
---

## 1. 整理结果概述

### 1.1 提交清单（21 个）

| 提交 | 类型 | 主题 | 终态 |
|---|---|---|---|
| 477e1fb | feat | F17 font-cxsecret 字体解密 + 资料题判定 | 生效（被 F34/F42 增强） |
| 95385b3 | fix | F18 空值提交修复（排除编辑器外壳 + 空值守卫） | 生效 |
| a79ddaf | feat | F19 题目合格性预检 + 提交锁 | 生效（F40 放宽阈值） |
| 8f4b2b2 | feat | F20 任务点图标级校验 | 生效 |
| e1f478e | fix | F21 空视频节点识别（暂无内容） | 生效（F38 补充边界） |
| 88e6bdf | fix | F22 僵尸视频元素自愈 | 生效 |
| a98672e | feat | F23 完成条件识别 + 片尾提前交接 | 生效 |
| 0b20540 | feat | F24 同节点并发 + GUI v2 | 并发默认关闭；GUI v2 生效 |
| 8d31bf9 | fix | F32 选项匹配增强 + 失败诊断 | 被 F35 取代匹配算法，诊断保留 |
| fa1dd36 | feat | F33 直播识别/LLM 节流/答案缓存/相似度兜底；CI | 生效（相似度部分被 F35 取代） |
| 399568a | feat | F34 glyf 哈希字体解密 / F35 上游匹配链 / F36 章节次数 | 生效（上游移植） || 51779c8 | fix | F37 多选题作答 + 互动题等待在途请求 | 生效 |
| 50d542a | fix | F38 任务点全完成不再误重试 | 生效 |
| 556cbe8 | fix | F39 作答判定/单选护栏/提交按钮识别 | 生效 |
| e92aa11 | fix | F40 题目预检放宽（短题干） | 生效 |
| 1175b8b | fix | F41 点击校验重试 | 生效 |
| 7150f50 | fix | F42 康熙部首表 + 多字体 + 弹窗诊断 | 生效 |
| c03f54b | fix | F43 作业嵌套帧定位 + 作业帧隔离 | 生效 |
| c0ef543 | fix | 关闭并发默认开关（实测无提速） | 生效 |
| 5be0051 | fix | F36b setlog 改用 iframe 信标（绕 CORS） | 生效 |
| 45fa1c6 | docs | F43 README 补齐 | 文档 |

### 1.2 交付物清单

| 交付物 | 说明 |
|---|---|
| v3_optimized.js | **唯一源码**（约 230KB，控制台直贴版） |
| v3_optimized.user.js | 构建产物 = 元数据 + resource/font-map-data.js（709KB 紧凑表）+ 源码；由 scripts/build-userscript.mjs 生成，verify-v3.mjs 逐字节校验 |
| tests/regression.mjs | 348 断言（F1–F43 全量回归） |
| tests/adversarial.mjs | 49 用例（含负向静态扫描：禁 fetch/XHR/localStorage 等） |
| tests/fixtures/font-cxsecret/ | 真实作业字体 + 紧凑表子集（F34/F42 夹具） |
| resource/font_map_table.json | 上游 Samueli924/chaoxing 原表（1.6MB，MIT） |
| resource/font-map-data.js | 自动生成紧凑表（29,559 条 × 18B，base64 709KB） |
| .github/workflows/ci.yml | CI：verify-v3 + regression + adversarial（首次推送后实跑） |
| README.md | 修复表 F1–F43 + 默认配置 + 关键项说明 |
### 1.3 功能终态（按主题分组）

- **字体解密**：F17 位图匹配（回退）→ F34 glyf 坐标哈希（上游移植，默认路径）→ F42 康熙部首表 + 多 font-cxsecret 字体；
- **作答链**：F10/F11/F19（预检+锁）→ F32（匹配增强）→ **F35 上游降级链**（clean_res → normalize_text → is_subsequence → SequenceMatcher.ratio ≥ 0.8）→ F37（多选/重试）→ F39/F40/F41（判定/护栏/点击校验）→ F43（作业帧隔离）；
- **播放/导航**：F21（空节点）、F22（僵尸元素）、F23（完成条件 90% 提前交接）、F38（任务点全完成边界）；
- **环境/风控**：F15（防挂机）、F16（后台保活）、F33（LLM 节流 800ms+抖动、直播守卫、答案缓存 LRU500）、F36/F36b（章节学习次数）；
- **实验且默认关闭**：F24 并发播放（保留开关）；
- **上游移植对照**：F34/F35/F36 全部对照 Samueli924/chaoxing@556ccc1 源码实现，非自研替代。

### 1.4 验证与真机结论

| 项 | 结果 |
|---|---|
| 回归 / 对抗 / 同步 | 348/348 ｜ 49/49 ｜ ✓ |
| F23 提前交接 | 真机 90.0% 打标即切换，省约 47s/任务点 |
| F39/F40/F41 作业链 | 真机《口腔种植解剖》11 题 11/11 有效作答 → 自动提交完成 |
| F36/F36b 章节次数 | 真机 setlog 20/20 连续成功（无 CORS 报错） |
| F24 并发 | 第二路可被计分，但实测吞吐无提升（平台仲裁→交错播放），已默认关闭 |
| F34/F42 字体解密 | 真机解码「哪种材料是现代口腔种植体最常用的材料」与上游一致 |
---

## 2. 冲突清单

| ID | 位置 | 冲突双方 | 冲突说明 | 影响 | 处理 |
|---|---|---|---|---|---|
| C1 | README F33 行 | F33 描述 vs F35 实现 | F33 写「相似度兜底（Dice ≥ 0.8）」，F35 已改为上游 SequenceMatcher.ratio ≥ 0.8 | 读者误认匹配算法，评审对不上代码 | ✅ 已改：注明「后续 F35 统一为上游 SequenceMatcher 链路」 |
| C2 | README F33 行 | F33 描述 vs 当前默认 | F33 写「concurrentPlayback 改为默认开启」，实际已被 c0ef543 关闭 | 误以为并发默认开启（风控/性能预期错误） | ✅ 已改：「曾默认开启，F37b 实测无提速后关闭」 |
| C3 | README F36 行 | F36 描述 vs F36b 实现 | 写「HTTP 走油猴 GM 或注入传输」，实际 setlog 走隐藏 iframe 信标 | 实现与文档不符，排查 CORS 时误导 | ✅ 已改：注明信标方案 |
| C4 | README F24 行 | F24 卖点 vs 实测结论 | 只写「并发第二路可被计分」，未写「整体无提速」 | 高估收益，可能被误开启 | ✅ 已补：「实测吞吐无明显提升，默认保持关闭」 |
| C5 | README F32 行 | F32 vs F35 | F32 描述「去标点括号包含匹配」为旧算法 | 与 F35 表述重复/矛盾 | ✅ 已标注「后续 F35 统一为上游降级链」 |
| C6 | README 修复表 | 编号连续性 | F25–F31 为审计候选项、从未实施，表格无任何说明 | 读者误以为漏记录/丢失提交 | ✅ 已加「编号说明」注记 |
| C7 | 演练配置 vs 脚本默认 | tmp-verify/conductor.mjs vs v3_optimized.js | 演练开启 chapterStudyCount=20、曾开 4 车道并发；脚本默认 0/关闭 | 非缺陷，但需防止误当默认行为 | 📌 本文档记录为「预期差异」（演练专用） |
| C8 | F42 多字体 vs F17 位图回退 | 两条解密路径 | 多字体收集只作用于 glyf 哈希路径；位图回退仍只用第一个字体 | 无字体表环境（纯控制台）命中率仍偏低 | ⏳ 遗留优化项（位图路径多字体化） |
| C9 | CI | 配置存在 vs 从未运行 | 21 个提交未推送，CI 未实跑 | CI 首次运行可能暴露环境差异 | ⏳ 推送后验证（见 §4.3） |
| C10 | 审计建议 vs 实现 | 审计 F25–F31 建议 | 播放兜底、答题弹窗超时升级、顶号守卫、结果退出码、单实例锁等未实施 | 长流程稳定性仍有已知缺口 | ⏳ 建议排期（见 §4.2） |

> 依赖关系检查：F23 依赖页面「完成条件」文案（缺失时回退比例默认 0.9）；F34 依赖 resource/font-map-data.js（构建内嵌/演练注入，缺失自动回退位图）；F36 依赖 HTTP 传输（油猴 GM 或宿主注入）——均无循环依赖与死锁。
---

## 3. 全局一致性结论

1. **无功能性冲突**。关键互补关系：F12↔F23（片尾保护升级为页面条件驱动）、F19↔F40（预检放宽而非取消）、F21↔F38（空节点与「全部完成」边界互斥判定）、F32↔F35↔F37（匹配→上游链→多选/重试，单向演进无并存实现）、F24 关闭后与 F2 串行模型无冲突。
2. **配置与文档一致**：README 默认配置块与代码逐项一致（回归 F7-2 通过）；新增项 llmMinIntervalMs / liveGuard / concurrentPlayback / docTaskScroll / cxSecretFontMode / chapterStudyCount 均有说明或注记。
3. **版本与构建一致**：源码 VERSION='V3.6'、油猴元数据 @version 3.6.0、提交前缀 v3.6 三者一致；verify-v3 保证双入口逐字节同步（含 709KB 字体表）。
4. **安全约束未被破坏**：对抗套件负向静态扫描（禁 fetch/XHR/localStorage/事件劫持等）49/49 通过；密钥仍只存内存、不入库。
5. **遗留差距（已知且已记录）**：编号空档 F25–F31；位图回退仅单字体；CI 未实跑；审计建议若干未实施；课程 7–34 长流程仍在验证。

---

## 4. 处理建议与修改方案

### 4.1 已执行（本次提交）
- README 冲突表述修正 C1–C5；编号空档说明 C6（**不改代码**）。

### 4.2 建议执行顺序
1. **推送 F17–F43 到 GitHub**（触发 CI 首跑；建议同时开 PR 附本文档）；
2. **补齐 CI 实跑证据**：verify-v3 → regression(348) → adversarial(49)；
3. **排期审计遗留**（按性价比）：单实例锁 + 退出原因落盘 → 结果汇总/非零退出码 → 顶号 page-lost 守卫 → 答题弹窗超时升级；
4. **位图回退多字体化**（对齐 F42 的哈希路径）；
5. **长流程演练收尾**：课程 7–34 跑完后，按课程核对「已选清单 vs 实际完成」并归档演练日志。

### 4.3 验收清单（推送后执行）

```powershell
node scripts/build-userscript.mjs
node tests/verify-v3.mjs        # 期望：payload 与源码+字体表逐字节一致
node tests/regression.mjs       # 期望：348/348
node tests/adversarial.mjs      # 期望：49/49
```

> 文档维护：本文件与 README.md 同级维护；后续新增修复编号请从 F44 连续递增，并在 README 修复表与本表登记。

---

## 5. F44 登记（2026-09-14，本表范围外的新增修复）

| 项 | 内容 |
|---|---|
| 编号 | F44（文档任务点完成判定按本任务点收敛） |
| 现场 | 课程 16 口腔种植学「上课课件」节点含 **12 个 PDF 文档任务点**；16:35 自动翻阅第 1 个（`1789004601649623`）后报「滚动后任务点未标记完成；已停止自动前进，请人工处理」，conductor 8 分钟后记 `stalled` |
| 根因（已确认） | `_processDocTasks` 的等待回调以「**全站**是否还有未完成文档任务点」判定本次是否完成；同页面多任务点时该条件恒为真 → 第一个任务点耗尽 `docTaskAttempts`(2) 轮后必然失败。自然对照：同会话 06:13 / 07:49 两次均为 **1 个**任务点 → `已全部完成` 成功 |
| 关键证据 | CDP 只读探针：第 1 个任务点 `finished=true`（平台已标记 `ans-job-finished`），其余 11 个 `false` → 证明翻阅动作本身有效，缺陷在完成判定 |
| 修复（最小范围） | 新增 `_isDocTaskFinished(docTask)`：按 jobid 复查当前 DOM 的 `finished`，任务点已从 DOM 移除视为完成；入口与本任务点复查；等待回调命中后 `_processDocTasks(docs, idx + 1, done)` 依次继续下一个任务点；全部完成仍经 idx 越界收敛为 `done(true)` → `play()`（「绝不跳过、全部完成才前进」语义不变） |
| 真机验证 | 断点续跑（不导航、就地 destroy→注入→run）：从第 2 个未完成任务点 `1789004873896153` 起，11 个剩余任务点逐个被平台标记完成（未完成数 11 → 0），日志出现 `已全部完成，继续推进`，耗时约 11 分钟 |
| 离线验证 | 旧版回归 **352/354**（F44 两个断言失败）→ 修复版 **354/354**；`verify-v3` 双入口同步 ✓；`adversarial` **49/49** |

> 本次改动仅涉及 `v3_optimized.js` 的 `_processDocTasks` 完成判定（+1 助手，+2 处调用点）、`tests/regression.mjs` 新增 F44-1 用例、README 修复表登记；未触碰滚动、重试、失败保护等既有逻辑。

## 6. F45 登记（2026-09-14，讨论任务点自动参与）

| 项 | 内容 |
|---|---|
| 编号 | F45（讨论任务点 insertbbs/BBS 自动参与） |
| 现场 | 课程 16「2.3 种植修复诊疗方案设计」节点含 1 个**讨论任务点**（`.ans-attach-ct`，无 `ans-job-finished`），脚本此前无任何处理逻辑（仅有一句人工提示），必然卡住 |
| 逆向证据（代码级） | ① 任务点结构：holder → `iframe[/ananas/modules/insertbbs/index.html]`（**无 jobid**，`data` 带 `mid`/`jobid`/`isJob`）→ `#frame_content` → `/mooc-ans/bbscircle/chapter?mtopicid=…`（讨论卡片，含隐藏 `input#isFinished`）。② 完成链路：服务端 `isFinished=true` → 卡片 `window.parent.postMessage({opType:"completeTopic"})` → insertbbs 内 `greenligth()` → 外层加 `ans-job-finished`；**当前 `isFinished` 为空 → 平台判定"未参与"**。③ 提交入口在跨域 `groupweb.chaoxing.com`：`topicDetail.js` 的 `$.post($ctx+"/pc/invitation/"+topic.uuid+"/addReplys", {courseId,classId,replyId,uuid,topic_content,files_url,files_attr,anonymous,urlToken,bbsid})`，`urlToken` 仅由该页 HTML 提供；页面内 `fetch` 打该域被 CORS 拦死（`Failed to fetch`）→ 必须走 `GM_xmlhttpRequest`（已在油猴元数据补 `@connect`） |
| 真机闭环（已验证） | 驱动浏览器内真实回帖 UI（填写 `textarea[placeholder=回复话题]` → 点击 `.replyEdit div.addReply`）：`BEFORE unfinished=1/3` → 提交成功（回复框清空、正文出现）→ 重载讨论卡片 → `AFTER unfinished=0/3`，holder 变 `ans-attach-ct ans-job-finished`，卡片 `isFinished="true"` |
| 实现（最小范围） | 新增 `_findDiscussTaskFrames` / `_hasUnfinishedDiscussTask` / `_discussTopicUrl` / `_httpPost` / `_discussReplyText` / `_reloadDiscussCard` / `_discussParticipate` / `_handleDiscussTasks` + 2 处门禁（`nextUnit` 与学习主循环）；回帖端点 origin **由话题 URL 推导**（不硬编码外部主机，满足 F5-2） |
| 安全约束 | 回复文本优先 LLM 生成；未开 LLM 且未设 `discussReplyText` 时**拒绝提交并停止前进**（回归 F45-2 断言零 POST、零完成标记）；不直接篡改 DOM class，完成状态一律由平台自身链路产生 |
| 验证 | `verify-v3` 双入口同步 ✓ ｜ `regression` **366/366**（新增 F45-1 9 项、F45-2 3 项）｜ `adversarial` **49/49** |
| 演练兼容性（已实测） | 演练侧新增 **CDP 宿主 HTTP 桥**（`tmp-verify/host-http-bridge.mjs`，`conductor.mjs` 已接入）：页面内传输经 `Runtime.addBinding('__xtHostHttp')` 交给 Node，由同源 helper 标签页执行 `fetch`（同源→无 CORS、自动带 cookie）。实测「口腔种植学」两个真实未完成讨论任务点（绪论 1205366375 / 术前临床检查 1205367149）：脚本自身 F45 路径完整跑通，桥轨迹为 `GET …/replysList → 200`、`POST …/addReplys → 200 {"msg":"回复发表成功"}`，任务点变为 `ans-job-finished`，课程进度 **53/55 → 55/55** |
