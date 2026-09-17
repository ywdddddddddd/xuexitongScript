(function () {
    // 学习通自动刷课脚本 V3.6 —— 唯一源码（油猴版 v3_optimized.user.js 由 scripts/build-userscript.mjs 生成）
    //
    // 本版在 V3.3（master）基础上，针对线上 55 条反馈里最高频的六类缺陷做收敛式修复。
    // 每条修复都用「F编号（#issue 编号）」注释标注依据，便于回溯到具体反馈：
    //   F1 导航死锁          #9 #24 #27 #37 #50
    //   F2 小节内多视频      #14 #15 #24 #27 #37 #49(PR)
    //   F3 无视频/课件页卡死 #38 #42 #43 #50
    //   F4 异常暂停与风控    #19 #26 #32 #54 #55
    //   F5 互动答题弹窗      #29 #39 #42 #45 #53(PR，仅吸收「检测」部分)
    //   F6 视频元素发现      #18 #52 #55
    //   F7 启动与文档        #4 #5 #12 #16 #17 #23 #33 #47 #50
    //   F9 GUI 可视化面板    （V3.5 新增：纯本地 DOM + 控制台镜像，默认开启，零网络请求）
    //   F10 LLM 互动题应答   （V3.5 新增：默认关闭，需显式开启并提供密钥）
    //
    // 设计边界（V3.5 起）：
    //   * 默认不启用任何自动答题：互动题自动应答仅当 llmEnabled=true 时生效；
    //     章节测验默认只「受限跳过」；显式开启 llmChapterTest 后也只把建议答案显示在面板，绝不自动点击；
    //   * 密钥只保存在内存（GUI 面板录入 / app.setLlmKey），不写入 localStorage、不落盘、不进仓库；
    //   * 默认配置下全脚本零外部网络请求；仅当显式开启 LLM 后才会访问 llmEndpoint；
    //   * LLM 请求只发送题干与选项文本，不发送 cookie、账号或页面地址等凭据信息。
    const VERSION = 'V3.6';
    const APP_KEY = '__xuexitongPlayerV3';
    const BOOT_TIMER_KEY = '__xuexitongPlayerV3BootTimer';
    const previousApp = window[APP_KEY];
    if (previousApp && typeof previousApp.destroy === 'function') {
        previousApp.destroy();
    }
    if (window[BOOT_TIMER_KEY]) {
        clearInterval(window[BOOT_TIMER_KEY]);
        window[BOOT_TIMER_KEY] = null;
    }
    // F7（#33 #47）：启动阶段必须给出可操作提示，不能「粘完没反应」。
    // 说明：页面本身依赖 jQuery；脚本只在页面没有 jQuery 时补一个 CDN <script>（V3.3 既有行为，未新增依赖）。
    if (typeof window.jQuery === 'undefined') {
        const script = document.createElement('script');
        script.src = 'https://code.jquery.com/jquery-3.6.0.min.js';
        script.type = 'text/javascript';
        script.onload = function () {
            console.log('jQuery loaded.');
            waitForCoursePage();
        };
        script.onerror = function () {
            // F7（#12 #16 #17 #33）：CDN 被拦截是最常见的「没效果」原因，这里必须说清楚怎么办。
            console.error('%c脚本启动失败：页面没有 jQuery，且 CDN 加载被浏览器/网络拦截。', 'color:#F44336;font-weight:bold');
            console.log('处理方法：1) 改用油猴版 v3_optimized.user.js；2) 或在页面控制台手动引入 jQuery 后重新粘贴本脚本；'
                + '3) 检查广告拦截插件是否拦截了 code.jquery.com。');
        };
        document.head.appendChild(script);
    } else {
        waitForCoursePage();
    }
    function waitForCoursePage() {
        let attempts = 0;
        const maxAttempts = 20;
        window[BOOT_TIMER_KEY] = setInterval(() => {
            const tree = $('#coursetree');
            const hasTree = tree.length > 0;
            // F7（#47 #50）：mooc1 域下课程目录数据晚于脚本执行，只看 #coursetree 会在
            // 目录还没渲染出小节节点时就初始化，表现为「脚本没反应」或元素为空。
            const hasNodes = hasTree && tree.find('.posCatalog_select').length > 0;
            if (hasTree && hasNodes) {
                clearInterval(window[BOOT_TIMER_KEY]);
                window[BOOT_TIMER_KEY] = null;
                initializePlayer();
                return;
            }
            attempts++;
            if (attempts >= maxAttempts) {
                clearInterval(window[BOOT_TIMER_KEY]);
                window[BOOT_TIMER_KEY] = null;
                if (hasTree) {
                    console.warn('%c课程目录已出现，但 20 秒内没有渲染出任何小节节点，仍先尝试启动；如果无反应请刷新页面。', 'color:#FF9800');
                    initializePlayer();
                } else {
                    console.error('%c脚本启动超时：未检测到课程目录（#coursetree）。', 'color:#F44336;font-weight:bold');
                    console.log('处理方法：1) 确认当前是学习通课程播放页（地址含 /mycourse/studentstudy）；'
                        + '2) 展开左侧目录后执行 app.run()；3) 仍无效请刷新页面重试（#47）。');
                }
            }
        }, 1000);
    }

    function initializePlayer() {
        const app = {
            version: VERSION,
            configs: {
                // 默认改为 1.0 原速（平台约束，不是脚本缺陷）：学习通 reportTimeInterval 每 60 秒向 multimedia/log
                // 上报一次观看时间，部分课程要求观看时长达到 100%，1.5 倍速既容易学时不达标（#28 #31），
                // 也更容易触发反作弊（验证码，见 #54）。证据来自 PR #56 的《ISSUES_REVIEW V3.4》与 PR #48 的 verify-speed-lock 自测。
                // 有倍速需求可手动调高：app.configs.playbackRate = 2; app.run()。
                // 本脚本只设置一次播放倍速，**不做任何 ratechange 强制回写对抗**（那是 #32 #54 反复暂停/风控的来源）。
                playbackRate: 1.0,
                autoplay: true,
                retryInterval: 2000,
                maxRetries: 10,
                videoCheckInterval: 1000,
                // F66（V3.7）：视频加载失败的显式跳过（移植上游 cx.ts:1742-1753）。
                // 平台播放器在片源损坏/格式不支持/网络中断时，会在 .vjs-modal-dialog-content 里给出四条中文文案之一；
                // 这类失败**重试无法恢复**，原先会白烧 maxRetries 次重试。开启后命中即记日志并按既有推进路径跳走。
                videoFailTextSkip: true,
                guardNoProgressMs: 7000,
                guardResumeCooldownMs: 1500,
                guardPausedGraceMs: 1200,
                // PR #56 的保活阶梯：恢复动作发出后 2.5 秒复检，仍无进度则轻微回拨重播（受次数上限约束）
                guardRecoveryProbeMs: 2500,
                guardSeekBackSeconds: 0.15,
                guardSeekBackMaxPerUnit: 2,
                // 播放 Promise 超时保护：媒体管线冻结时 play() 可能永不 settle
                playTimeoutMs: 8000,
                resumeMaxAttemptsPerUnit: 5,
                userPauseWindowMs: 2500,
                autoAdvanceNoVideo: false,
                maxConsecutiveNoVideoAdvances: 3,
                videoFrameMaxDepth: 4,
                interactionGuard: true,
                interactionPollMs: 1500,
                // F68（V3.7）：人脸识别的检测与等待（移植上游 cx.ts:2221-2246 / 2250-2300 / 1757-1758）。
                // 命中后暂停自动推进并提示人工完成（只提示一次），人脸消失后自动恢复播放；无超时，一直等人工。
                interactionFaceWait: true,
                // 思路移植自 PR #48 @CsuCook1e：任务点弹窗节流与视频任务点上限（本仓库额外加了次数上限，防止异常页面下无限点）
                taskDialogClickCooldownMs: 8000,
                taskDialogMaxClicksPerUnit: 3,
                videoTaskFrameMaxDepth: 4,
                videoTaskFrameMaxCount: 12,
                // F67（V3.7）：章节未完成数的第二数据源交叉校验（移植上游 cx.ts:1138-1145 getChapterInfos）。
                // 服务端在章节 onclick 与同级 input.jobUnfinishCount 里维护未完成数；与本地 DOM 统计对照，
                // 用于提前发现平台改版。只做交叉校验与日志，不替换既有完成判定的主口径。
                chapterCountCrossCheck: true,
                // F24（V3.6 补丁，实验特性）：同节点多视频并发播放（错开启动 + 副车道保活重播）。
                // 真机实测：平台会周期性暂停副车道，重播可拉回；并发的第二路 206/218s 被平台正常标记完成。
                concurrentPlayback: false,
                concurrentLanes: 2,
                laneKeeperIntervalMs: 3000,
                laneMaxReplaysPerUnit: 240,
                // F12（V3.6）：片尾停滞保护——已播放达到该比例且平台已标记任务点完成时，视同片尾完成直接推进。
                videoCompleteRatio: 0.9,
                // F15（V3.6）：拦截平台「鼠标移出页面自动暂停」的防挂机暂停（真机实测：window 上 mouseout 监听调用 pause()）。
                // 只拦截「无用户意图」的暂停；最近 1.5 秒有点击/按键的操作仍正常放行。
                pauseGuard: true,
                // F17（V3.6）：font-cxsecret 反copy字体自动解密（用系统 Noto Sans SC 做字形匹配）。
                cxSecretDecode: true,
                // F34（V3.6 补丁）：font-cxsecret 解密模式。auto=优先 glyf 哈希（移植上游 Samueli924/chaoxing），
                // 数据表缺失/解析失败时自动回退位图匹配；bitmap=只用位图；hash=只用哈希。
                cxSecretFontMode: 'auto',
                // F36（V3.6 补丁）：章节学习次数（移植上游 api/base.py _extract_and_send_setlog）。
                // >0 时周期性请求 studentstudyAjax，从响应中提取 fystat setlog 并触发；需要 HTTP 传输
                // （油猴 GM_xmlhttpRequest，或宿主注入 app.setHttpTransport(fn)）。
                chapterStudyCount: 0,
                chapterStudyDelayMs: 2500,
                // F19（V3.6）：题目合格性预检 + 提交锁。校验不通过（题目疑似界面文案/过短/选项不足/作答异常）
                // 一律不提交并上锁，交人工处理（真机教训：编辑器外壳被当选项 → 提交了 8 次空值）。
                workSanityLock: true,
                // F13（V3.6）：文档任务点（PDF/PPT/教案）自动翻阅。默认关闭；开启后自动滚动文档到底部并等待平台标记完成。
                docTaskScroll: true,
                docTaskScrollStepMs: 800,
                // F13 修正：懒加载文档越滚越长，步数上限会误判「到底」；改为时间上限 + 「到底且高度稳定」双条件。
                docTaskMaxMs: 240000,
                docTaskWaitMs: 45000,
                docTaskAttempts: 2,
                // F45（V3.6）：讨论任务点（insertbbs/BBS）自动参与。默认开启。
                // 平台完成条件 = 该话题下有学生的回复（服务端 isFinished）→ 讨论卡片 postMessage → insertbbs 标记 ans-job-finished。
                // 回复文本优先由 LLM 依据话题内容生成；未开 LLM 时用 discussReplyText 固定文本；两者皆无则不提交并停止自动前进（绝不伪造完成）。
                discussTaskAuto: true,
                discussReplyText: '',
                // 提交回复后等待平台标记完成的窗口（需重载讨论卡片触发服务端 isFinished 链路）。
                discussTaskWaitMs: 60000,
                // F9（V3.5）：GUI 可视化面板。纯本地 DOM，不产生任何额外网络请求。
                guiEnabled: true,
                guiMaxLogLines: 60,
                // F10（V3.5）：LLM 互动题应答。默认关闭；开启后才会访问 llmEndpoint。
                // 密钥只存内存：GUI 面板「设置 Key」或控制台 app.setLlmKey(...)。
                llmEnabled: false,
                llmEndpoint: 'https://opencode.ai/zen/go/v1/chat/completions',
                // F53（V3.7）：默认模型改为当前 key 实测可用者。
                // 真机教训：deepseek 家族（deepseek-flash / deepseek-v4-flash / deepseek-v4.1-flash）在本 key 上
                // 被地区门禁挡住，返回 HTTP 403 RegionError：
                //   "The latest version of this model is only available hosted in China and requires explicit opt in"
                // 结果每次答题第 1 题就失败 → 只暂存不提交 → 停机等人工，整条自动答题链路形同停摆。
                // 用户 2026-09-16 指定：**只用 deepseek 的 flash 模型、不切换模型**。
                // 实测（同题同参数打网关）：`deepseek-flash` → finish=length 且 content 为空（配额全耗在 reasoning），
                // 产不出答案；`deepseek-v4-flash` → 正常返回 {"answer":"B"}。故取后者（如需改回，改这一个字符串即可）。
                // 原先主模型 minimax-m3 + 5 个降级模型（地区门禁/限流时自动切换）。现在降级链为空、开关关掉，
                // 失败就走「60 秒心跳重试（最多 3 次）」→ 仍失败才安全兜底（只暂存不提交、停机等人工）。
                llmModel: 'deepseek-v4-flash',
                // F53：主模型不可用（地区门禁 / 无权限 / 限流 / 5xx / 空响应 / 网络超时）时按序自动降级；
                // 停在第一个可用模型并在本会话内粘性复用，全部失败才回退原有安全策略（上锁 + 只暂存不提交）。
                llmModelFallbacks: [],
                llmModelFallbackOn: false,
                // 实测：推理模型在 max_tokens 过小时会把配额耗在 reasoning 上导致 content 为空，必须 >= 1024。
                // 用户 2026-09-16 指定给足到 2048（推理段常 2000+ 字符，2048 足够留出正文配额）。
                llmMaxTokens: 2048,
                // true=请求体带 response_format:{"type":"json_object"}，约束模型只输出 JSON；自定义端点不支持时设为 false。
                llmJsonMode: true,
                llmTimeoutMs: 30000,
                // 心跳重试（用户 2026-09-16 要求）：模型链全部失败后（典型场景=答题时 AI 接口断联），
                // 等 llmRetryIntervalMs 再重试整条链，最多 llmRetryIntervalMs 次；仍失败才走安全兜底
                // （只存草稿不提交、停止自动前进）。断网/网关抖动恢复后无需人工干预即可继续答题。
                llmRetryIntervalMs: 60000,
                llmMaxRetries: 5,
                // 用户 2026-09-16 追加规则：心跳重试耗尽后**不提交**、直接**跳过该任务点**继续（false 则退回"停下等人"）。
                llmSkipNodeAfterRetries: true,
                // 用户 2026-09-17：识别「不计任务点」的调查问卷（平台不标任务点，原先被静默跳过）。
                // 本开关只控制"识别 + 播报 + 记录"，不自动作答；自动作答需另加开关与策略。
                surveyDetect: true,
                // 用户 2026-09-17：识别到问卷后**用 LLM 自动作答并提交**（问卷无标准答案，选最合理正向项；填空题给固定正向短句）。
                // 安全阀：每题必须都有作答才提交；提交按钮严格限定在 work iframe 内且文本精确匹配（避免误点页面其它按钮）。
                surveyAutoFill: true,
                surveySubmit: true,
                // F33（V3.6 补丁）：LLM 请求最小间隔 + 抖动（防 429 / 防风控，对齐上游 RateLimiter）。
                llmMinIntervalMs: 800,
                // F33：直播任务点识别开关（识别到直播节点时安全停止并给出针对性提示，绝不当作未知节点跳过）。
                liveGuard: true,
                // 有界防循环（思路同 PR #53 的 10 次上限），超出后回退人工。
                llmMaxAnswersPerSession: 50,
                // false=只自动选择答案，提交按钮留给用户；true=自动选择并提交。
                llmAutoSubmit: false,
                // 章节测验（计入成绩）默认关闭；开启后也只把建议答案显示在面板，绝不自动点击。
                llmChapterTest: false,
                // F11（V3.6）：内嵌章节测验/作业（work）自动作答。默认关闭；开启后 LLM 自动填写简答题并走平台原生提交流程。
                llmEmbeddedWork: false,
                // 提交后任务点标记可能延迟（待批阅），窗口放宽到 90s（真机演练实证）。
                llmWorkWaitMs: 90000,
                // F48（V3.6）：不确定时"只暂存不提交"——作答链任何失败/上锁（题目校验未通过、选项匹配失败、
                // 未全部作答）都先调用平台原生「暂时保存」(noSubmit) 存草稿，再停止等人工确认。
                // 目的：既不在信息不足时把错误答案提交入库，也不让已填内容白丢。
                workDraftOnUncertain: true,
            },
            _videoEl: null,
            _treeContainerEl: null,
            _isPlaying: false,
            _currentRetryCount: 0,
            _checkInterval: null,
            _eventVideoEl: null,
            _boundVideoHandlers: null,
            _nextUnitPending: false,
            _chapterAdvanceTimes: 0,
            _consecutiveNoVideoAdvances: 0,
            _resumeAttemptsThisUnit: 0,
            _resumeCapLogged: false,
            _userPaused: false,
            _lastUserInteractionTs: 0,
            _userInteractionDoc: null,
            _userInteractionHandler: null,
            _interactionBlocked: false,
            _interactionWatcher: null,
            _timers: null,
            _stepNavigationBound: false,
            // F9（V3.5）：GUI 面板与日志缓冲状态。
            _guiPanelEl: null,
            _guiStatusEl: null,
            _guiLogEl: null,
            _guiProgressFill: null,
            _guiProgressText: null,
            _guiDotEl: null,
            _guiBtns: null,
            _guiBodyEl: null,
            _guiCollapseHandler: null,
            _guiLogs: [],
            _guiCollapsed: false,
            _guiLastRefreshTs: 0,
            // F10（V3.5）：LLM 应答状态（密钥仅存内存，绝不落盘）。
            _llmApiKey: '',
            _llmSessionId: '',
            _llmTransport: null,
            _llmInFlight: false,
            _llmAbort: null,
            // F53（V3.7）：模型降级链状态 —— _llmModelIndex 指向本会话已确认可用的模型（粘性复用）。
            _llmModelIndex: 0,
            _llmNoJsonMode: false,
            _llmAnswersThisSession: 0,
            _llmLastAnswer: null,
            _llmLastQuestionKey: '',
            _llmWarnedNoKeyOnce: false,
            _llmChapterSuggesting: false,
            _llmChapterSuggestDone: false,
            _llmChapterSuggestedCount: 0,
            _workBusy: false,
            _docTaskBusy: false,
            _discussTaskBusy: false,
            // 思路移植自 PR #48 @CsuCook1e：小节内视频任务点与任务点弹窗状态
            _currentVideoTaskIndex: 0,
            _videoTaskCount: 0,
            _videoTaskAllComplete: false,
            _handlingVideoEnd: false,
            _lastTaskPointDialogClickAt: 0,
            _taskDialogClicksThisUnit: 0,
            _taskDialogCapLogged: false,
            _cellData: {
                cells: 0,
                nCells: 0,
                currentCellIndex: 0,
                currentNCellIndex: 0,
                currentVideoTitle: '',
                resolved: false,
                resolveSource: '',
            },
            get cellData() {
                return this._cellData;
            },
            run() {
                console.log(`%c=== 学习通自动刷课脚本 ${VERSION} 启动 ===`, 'color:#4CAF50;font-size:16px;font-weight:bold');
                // F4（#54 #55）：每次 run() 先把上一轮的定时器彻底清掉，避免残留定时器叠加日志/重复点击。
                this._clearTimers();
                this._clearCheckInterval();
                this._nextUnitPending = false;
                this._chapterAdvanceTimes = 0;
                this._consecutiveNoVideoAdvances = 0;
                this._resumeAttemptsThisUnit = 0;
                this._resumeCapLogged = false;
                this._userPaused = false;
                this._interactionBlocked = false;
                this._tryTimes = 0;
                this._emptyContentStreak = 0;
                this._videoRefreshTried = false;
                // F66/F68（V3.7）：坏片探测记账与人工等待状态随每次启动复位。
                this._videoFailTextHandledKey = null;
                this._videoFailTextScanTs = 0;
                this._faceWaitActive = false;
                this._faceWaitNotified = false;
                this._unitCompletionRatio = null;
                this._currentVideoTaskIndex = 0;
                this._videoTaskCount = 0;
                this._videoTaskAllComplete = false;
                this._handlingVideoEnd = false;
                this._taskDialogClicksThisUnit = 0;
                this._taskDialogCapLogged = false;
                this._seekBackTimesThisUnit = 0;
                this._seekBackCapLogged = false;
                this._llmChapterSuggesting = false;
                this._llmChapterSuggestDone = false;this._llmChapterSuggestDone = false;
                this._llmChapterSuggestDone = false;this._surveyHandledForThisUnit = false;   // 每进一个节点重置：保证每份问卷都会被识别并自动作答
                if (this._guardProbeTimer) {
                    this._cancelTimer(this._guardProbeTimer);
                    this._guardProbeTimer = null;
                }
                this._guardLastTime = 0;
                this._guardLastWallTs = 0;
                this._guardLastResumeTs = 0;
                // F2/F6（#24 #52 #55）：目录与视频元素缓存都随每次启动失效。
                this._treeContainerEl = null;
                this._invalidateVideoCache('run() 重新启动');
                this._getTreeContainer();
                this._initCellData();
                this._getVideoEl();
                this._clearCheckInterval();
                this._bindStepNavigation();
                this._startInteractionWatcher();
                this._bindVisibilityRecovery();
                this._laneReplays = 0;
                this._laneCapLogged = false;
                this._laneLoadTried = null;
                this._laneLastKeeperTs = 0;
                this._startLaneKeeper();
                this._increaseChapterStudyCount();
                this._guiInit();
                this.play();
            },
            nextUnit() {
                // F5（#29 #39）：检测到互动答题弹窗时暂停自动跳转，交给用户手动处理；
                // 脚本不会自动答题（硬性约束），也不需要在弹窗上反复点击。
                if (this._interactionBlocked) {
                    console.warn('%c检测到视频互动答题弹窗，已暂停自动跳转（#29 #39）。请手动完成题目，脚本会在弹窗消失后自动继续。', 'color:#FF9800');
                    return;
                }
                // F68（V3.7）：人脸识别期间同样暂停自动跳转。闸门放在导航锁之前（此处 _nextUnitPending 尚未置位），
                // 因此不需要 _releaseNavLock；即使有其它路径触发 nextUnit()，也不会在人脸未完成时跳走。
                if (this._faceWaitActive || (this.configs.interactionFaceWait !== false && this._hasFaceRecognition())) {
                    this._waitForFaceRecognition();
                    return;
                }
                // F46（V3.6）：本节点有多个任务点（平台任务点标签页 #prev_tab）且当前显示的那个已完成时，
                // 先切到还没核验的任务点标签再跳转，否则后续任务点（如「章节测验」）会被整体漏掉。
                if (this._handleTaskTabs()) return;
                // F11（V3.6）：当前小节还有未完成的内嵌章节测验/作业时，先把作业处理完再跳转（修复「视频+作业」双任务点组合被跳过）。
                if (this._hasUnfinishedEmbeddedWork()) {
                    console.log('%c当前小节还有未完成的内嵌章节测验/作业，先处理作业再跳转', 'color:#FF9800');
                    this._handleEmbeddedWorks();
                    return;
                }
                // F13（V3.6）：当前小节还有未完成的文档任务点（PDF/PPT/教案）时，先翻阅完再跳转。
                if (this._hasUnfinishedDocTask()) {
                    console.log('%c当前小节还有未完成的文档任务点（PDF/PPT），先翻阅再跳转', 'color:#FF9800');
                    this._handleDocTasks();
                    return;
                }
                // F45（V3.6）：当前小节还有未完成的讨论任务点（insertbbs/BBS）时，先自动参与讨论再跳转。
                if (this._hasUnfinishedDiscussTask()) {
                    console.log('%c当前小节还有未完成的讨论任务点（BBS），先参与讨论再跳转', 'color:#FF9800');
                    this._handleDiscussTasks();
                    return;
                }
                // t6：进入 nextUnit 前先取消任何待执行的「视频结束自动跳转」，避免旧定时器把刚打开的小节又跳一次。
                this._cancelDelayedNextUnit('进入 nextUnit');
                if (this._nextUnitPending) {
                    console.warn('%c已有小节切换正在进行，忽略重复请求', 'color:#FF9800');
                    return;
                }
                this._nextUnitPending = true;
                this._clearCheckInterval();
                console.log('%c=== 准备切换到下一小节 ===', 'color:#2196F3;font-size:14px');
                try {
                    const el = this._getTreeContainer();
                    const chapters = el.children('ul').children('li');
                    // F2（#14 #15 #24 #27 #37 #49）：当前节点下标/同章节点集合统一由
                    // _resolveCatalogPosition() 解析，不再在多个地方各算一套导致下标错位。
                    const position = this._resolveCatalogPosition('nextUnit');
                    if (!position.ok) {
                        // F2 要求：解析失败必须给出明确日志，绝不静默跳到下一章。
                        console.error(`%c无法解析当前课程节点，已停止自动跳转以避免误跳章节：${position.reason}`, 'color:#F44336;font-weight:bold');
                        console.log('处理方法：请在左侧目录中手动点击目标小节后执行 app.run()；'
                            + '如果目录里没有高亮的 .posCatalog_active（反馈 #14 #15），说明页面还没渲染完，刷新即可。');
                        return;
                    }
                    const nodes = position.nodes;
                    if (nodes.length > position.nodeIndex + 1) {
                        const nextNIndex = position.nodeIndex + 1;
                        console.log(`%c切换到同章节下一个视频: ${nextNIndex + 1}/${nodes.length}`, 'color:#FF9800');
                        this._cellData.currentCellIndex = position.chapterIndex;
                        this._cellData.currentNCellIndex = nextNIndex;
                        this.playCurrentIndex(nodes[nextNIndex]);
                    } else {
                        const nextIndex = position.chapterIndex + 1;
                        if (nextIndex >= chapters.length) {
                            console.log('%c=====================================', 'color:#4CAF50;font-size:16px');
                            console.log('%c==============本课程学习完成了==============', 'color:#4CAF50;font-size:16px;font-weight:bold');
                            console.log('%c=====================================', 'color:#4CAF50;font-size:16px');
                            return;
                        }
                        console.log(`%c切换到下一个章节: ${nextIndex + 1}/${chapters.length}`, 'color:#FF9800');
                        this._cellData.currentCellIndex = nextIndex;
                        this._cellData.currentNCellIndex = 0;
                        // 点击后目录 active 才会移动到新章节，这里用已跟踪的下标显式定位第 1 个节点。
                        this.playCurrentIndex(null, { chapterIndex: nextIndex, nodeIndex: 0 });
                    }
                } catch (error) {
                    console.error('切换下一小节失败:', error);
                } finally {
                    // F1（#9 #24 #27 #37 #50）：导航锁必须在**所有**退出路径上复位：
                    // 「无视频安全停止」「达到最大重试」「静音播放失败」「课程已完成」「解析失败」
                    // 以及异常分支，否则该标志会永久为 true，之后所有 nextUnit() 都被静默忽略（导航死锁）。
                    this._releaseNavLock('nextUnit 退出');
                }
            },
            _releaseNavLock(reason) {
                // F1（#24 #27）：任何失败退出路径都要显式释放导航锁，保证后续 nextUnit() 仍可触发。
                if (this._nextUnitPending) {
                    console.log(`%c已释放小节切换锁（${reason}）`, 'color:#607D8B');
                }
                this._nextUnitPending = false;
            },
            _clearCheckInterval() {
                if (this._checkInterval) {
                    clearInterval(this._checkInterval);
                    this._checkInterval = null;
                }
            },
            _schedule(fn, ms) {
                // F4（#32 #54 #55）：所有延时器集中登记，destroy()/run() 时可一次性清理，
                // 避免残留定时器在页面切换后继续触发点击与日志。
                if (!this._timers) this._timers = new Set();
                const id = setTimeout(() => {
                    if (this._timers) this._timers.delete(id);
                    fn();
                }, ms);
                this._timers.add(id);
                return id;
            },
            _cancelDelayedNextUnit(reason) {
                // t6 修复（verifier finding V1）：视频结束后用于自动跳转的定时器必须像其它延时器一样
                // 登记到 `_delayedNextUnitTimer` 账本，否则 _handleVideoPlay / playCurrentIndex /
                // _handleVideoLoaded / nextUnit 入口的取消对它完全无效——陈旧定时器会在 1.2 秒后把
                // 用户刚打开的小节瞬间跳过（对应 #9 #24 #27 #37 #50）。
                // 同时复位 _handlingVideoEnd：定时器被取消后没人再执行「先复位再跳转」的回调，
                // 不在这里复位会让去重标志永久为 true，之后所有视频结束都不再触发跳转。
                if (!this._delayedNextUnitTimer) return false;
                this._cancelTimer(this._delayedNextUnitTimer);
                this._delayedNextUnitTimer = null;
                if (this._handlingVideoEnd) {
                    this._handlingVideoEnd = false;
                    console.log(`%c已取消待执行的自动跳转并复位结束去重标志（${reason}）`, 'color:#607D8B');
                } else {
                    console.log(`%c已取消待执行的自动跳转（${reason}）`, 'color:#607D8B');
                }
                return true;
            },
            _cancelTimer(id) {
                if (!id) return;
                clearTimeout(id);
                if (this._timers) this._timers.delete(id);
            },
            _clearTimers() {
                if (!this._timers) return;
                for (const id of this._timers) {
                    clearTimeout(id);
                }
                this._timers.clear();
                this._delayedNextUnitTimer = null;
                this._guardProbeTimer = null;
            },
            // F14（V3.6）：页面可见性恢复自愈 —— 拖动窗口/切到后台会让 Chrome 省电暂停纯视频媒体，
            // 拉锯会耗尽「每小节 5 次」保活预算；恢复可见时自动重置预算并续播（真机演练：拖窗后 ct 冻死）。
            _bindVisibilityRecovery() {
                if (this._visibilityBound) return;
                this._visibilityBound = true;
                this._visibilityHandler = () => {
                    try {
                        if (typeof document === 'undefined') return;
                        if (document.visibilityState !== 'visible') {
                            console.log('%c页面进入后台（visibility=hidden）：已启用后台保活，被暂停会直接续播（无需恢复可见）', 'color:#FF9800');
                            this._startHiddenKeepAlive();
                            return;
                        }
                        this._stopHiddenKeepAlive();
                        if (this._resumeAttemptsThisUnit > 0 || this._resumeCapLogged) {
                            console.log('%c页面恢复可见：重置保活预算（原已达上限），尝试续播', 'color:#4CAF50');
                            this._resumeAttemptsThisUnit = 0;
                            this._resumeCapLogged = false;
                        }
                        const v = this._getVideoEl();
                        if (this._isPlaying && v && v.paused && !this._userPaused) {
                            try { v.play().catch(() => {}); } catch (e) { /* ignore */ }
                        }
                    } catch (e) { /* ignore */ }
                };
                document.addEventListener('visibilitychange', this._visibilityHandler);
                window.addEventListener('focus', this._visibilityHandler);
            },
            // F16（V3.6）：后台保活 —— 页面隐藏时若视频被浏览器省电暂停，直接在后台 play() 拉起，
            // 不需要等页面恢复可见（真机实测：hidden 状态下 play() 可正常生效）。使用 _schedule 链避免新增 setInterval。
            _startHiddenKeepAlive() {
                if (this._hiddenKeepAliveActive) return;
                this._hiddenKeepAliveActive = true;
                const tick = () => {
                    if (!this._hiddenKeepAliveActive) return;
                    try {
                        if (typeof document !== 'undefined' && document.visibilityState === 'visible') { this._hiddenKeepAliveActive = false; return; }
                        if (this._isPlaying && !this._userPaused) {
                            const v = this._getVideoEl();
                            if (v && v.paused) {
                                this._hiddenResumeCount++;
                                if (this._hiddenResumeCount <= 3 || this._hiddenResumeCount % 20 === 0) {
                                    console.log('%c[后台保活] 页面隐藏且视频被暂停：已在后台直接续播（第 ' + this._hiddenResumeCount + ' 次）', 'color:#4CAF50');
                                }
                                try { v.play().catch(() => {}); } catch (e) { /* ignore */ }
                            }
                        }
                    } catch (e) { /* ignore */ }
                    if (this._hiddenKeepAliveActive) this._schedule(tick, 3000);
                };
                this._schedule(tick, 3000);
            },
            _stopHiddenKeepAlive() {
                this._hiddenKeepAliveActive = false;
            },
            _unbindVisibilityRecovery() {
                this._stopHiddenKeepAlive();
                if (!this._visibilityBound) return;
                this._visibilityBound = false;
                try { document.removeEventListener('visibilitychange', this._visibilityHandler); } catch (e) { /* ignore */ }
                try { window.removeEventListener('focus', this._visibilityHandler); } catch (e) { /* ignore */ }
                this._visibilityHandler = null;
            },
            _startVideoMonitoring() {
                this._clearCheckInterval();
                this._guardLastTime = Number((this._getVideoEl() || {}).currentTime || 0);
                this._guardLastWallTs = Date.now();
                this._guardLastResumeTs = 0;
                this._checkInterval = setInterval(() => {
                    this._checkVideoStatus();
                }, this.configs.videoCheckInterval);
            },
            _isProgressStalled(now) {
                // F4（#32 #55）：只有「进度确实停滞」才允许恢复播放：
                //   * 暂停状态：超过 guardPausedGraceMs 宽限期仍未恢复（宽限期用于放过播放器切源/缓冲造成的瞬时 pause）
                //   * 播放状态：超过 guardNoProgressMs 而 currentTime 没有前进
                const video = this._getVideoEl();
                if (!video) return false;
                const baselineTs = this._guardLastWallTs || 0;
                if (!baselineTs) return false;
                const elapsed = now - baselineTs;
                const current = Number(video.currentTime || 0);
                const advanced = Math.abs(current - Number(this._guardLastTime || 0)) >= 0.01;
                if (video.paused) return elapsed >= this.configs.guardPausedGraceMs;
                return !advanced && elapsed >= this.configs.guardNoProgressMs;
            },
            _tryResumePlayback(reason) {
                const now = Date.now();
                if (now - this._guardLastResumeTs < this.configs.guardResumeCooldownMs) return false;
                if (this._userPaused) return false;
                const video = this._getVideoEl();
                if (!video || !this._isPlaying) return false;
                if (!this._isProgressStalled(now)) return false;
                if (this._resumeAttemptsThisUnit >= this.configs.resumeMaxAttemptsPerUnit) {
                    if (!this._resumeCapLogged) {
                        this._resumeCapLogged = true;
                        console.warn(`%c本节恢复播放次数已达上限（${this.configs.resumeMaxAttemptsPerUnit} 次），停止抢播（#32 #54 #55）。`, 'color:#FF9800');
                        console.log('处理方法：如果视频仍然卡住，请手动点击播放或刷新页面；'
                            + '无差别抢播 pause 事件容易触发平台风控/验证码（#54），因此这里刻意限制次数。');
                    }
                    return false;
                }
                this._guardLastResumeTs = now;
                this._resumeAttemptsThisUnit++;
                console.log(`%c触发视频保活恢复(${reason}) ${this._resumeAttemptsThisUnit}/${this.configs.resumeMaxAttemptsPerUnit}`, 'color:#607D8B');
                const attempt = video.play();
                if (attempt && typeof attempt.catch === 'function') {
                    attempt.catch((e) => {
                        console.warn('直接恢复播放失败，尝试静音恢复:', e);
                        this._lastScriptMutedValue = true; // F4：脚本自身的静音兜底不算用户选择
                        video.muted = true;
                        const mutedAttempt = video.play();
                        if (mutedAttempt && typeof mutedAttempt.catch === 'function') {
                            mutedAttempt.catch((err) => console.error('静音恢复播放失败:', err));
                        }
                    });
                }
                this._scheduleGuardProbe(reason);
                return true;
            },
            _withTimeout(promise, ms, label) {
                // PR #56《ISSUES_REVIEW V3.4》修复项：播放 Promise 超时保护。
                // 媒体管线冻结时 play() 可能既不 resolve 也不 reject，await 会一直挂住状态机。
                if (!promise || typeof promise.then !== 'function') return Promise.resolve();
                return new Promise((resolve, reject) => {
                    let settled = false;
                    if (!this._timers) this._timers = new Set();
                    const timer = setTimeout(() => {
                        if (settled) return;
                        settled = true;
                        this._timers.delete(timer);
                        reject(new Error(label));
                    }, ms);
                    this._timers.add(timer);
                    const finish = (error) => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timer);
                        this._timers.delete(timer);
                        if (error) reject(error);
                        else resolve();
                    };
                    promise.then(() => finish(null), (error) => finish(error || new Error('play() rejected')));
                });
            },
            _scheduleGuardProbe(reason) {
                // F4（#19 #32 #55）+ PR #56 的保活阶梯：
                // 每秒检查 → 连续 7 秒无进度 → pause/play → 2.5 秒复检 → 仍无进度则轻微回拨并重播。
                // 复检与回拨都受冷却/次数上限约束，避免与播放器抢状态触发风控（#54）。
                if (this._guardProbeTimer) this._cancelTimer(this._guardProbeTimer);
                this._guardProbeTimer = this._schedule(() => {
                    this._guardProbeTimer = null;
                    const video = this._getVideoEl();
                    if (!video || !this._isPlaying) return;
                    if (!this._isProgressStalled(Date.now())) {
                        console.log('%c保活复检：进度已恢复，无需回拨重播', 'color:#4CAF50');
                        return;
                    }
                    if (this._resumeAttemptsThisUnit >= this.configs.resumeMaxAttemptsPerUnit) {
                        // F4：回拨重播同样计入「每小节恢复次数」预算，避免阶梯把 play() 调用放大到上限之外。
                        if (!this._resumeCapLogged) {
                            this._resumeCapLogged = true;
                            console.warn(`%c本节恢复/回拨次数已达上限（${this.configs.resumeMaxAttemptsPerUnit} 次），停止保活动作（#32 #54 #55）。`, 'color:#FF9800');
                        }
                        return;
                    }
                    if (this._seekBackTimesThisUnit >= this.configs.guardSeekBackMaxPerUnit) {
                        if (!this._seekBackCapLogged) {
                            this._seekBackCapLogged = true;
                            console.warn(`%c保活回拨次数已达上限（${this.configs.guardSeekBackMaxPerUnit} 次/小节），停止回拨重播（#54）。`, 'color:#FF9800');
                            console.log('处理方法：请手动点击播放或刷新页面；连续与播放器抢状态容易触发平台风控。');
                        }
                        return;
                    }
                    this._seekBackTimesThisUnit++;
                    this._resumeAttemptsThisUnit++;
                    const current = Number(video.currentTime || 0);
                    const target = Math.max(0, current - this.configs.guardSeekBackSeconds);
                    console.log(`%c保活复检仍无进度(${reason})，回拨 ${this.configs.guardSeekBackSeconds}s 后重播 ${this._seekBackTimesThisUnit}/${this.configs.guardSeekBackMaxPerUnit}`, 'color:#607D8B');
                    try {
                        video.currentTime = target;
                    } catch (e) {
                        console.warn('回拨 currentTime 失败:', e);
                    }
                    this._guardLastTime = target;
                    this._guardLastWallTs = Date.now();
                    const attempt = video.play();
                    if (attempt && typeof attempt.catch === 'function') {
                        attempt.catch((e) => console.warn('回拨重播失败:', e));
                    }
                }, this.configs.guardRecoveryProbeMs);
                return this._guardProbeTimer;
            },
            _bindUserMuteTracking(video) {
                // F4（#19 #32）：记住「用户手动选择的静音状态」，切换视频后沿用（PR #56 也强调不要强行改回非静音）。
                // 脚本自身的静音兜底（_handlePlayError）通过「最近一次脚本写入的 muted 值」标记排除，不会被误当成用户选择。
                if (!video || typeof video.addEventListener !== 'function') return;
                if (this._muteTrackedEl === video) return;
                this._unbindUserMuteTracking();
                const handler = () => {
                    if (typeof video.muted !== 'boolean') return;
                    const current = video.muted;
                    // 值与脚本最近一次自己写入的一致 → 这是脚本的兜底/沿用动作，不算用户选择。
                    if (this._lastScriptMutedValue !== null && current === this._lastScriptMutedValue) {
                        this._lastScriptMutedValue = null;
                        return;
                    }
                    this._lastScriptMutedValue = null;
                    this._userMutedChoice = current;
                    console.log(`%c记录用户的静音选择：${current ? '静音' : '非静音'}，切换视频后沿用`, 'color:#607D8B');
                };
                video.addEventListener('volumechange', handler);
                this._muteTrackedEl = video;
                this._muteHandler = handler;
            },
            _unbindUserMuteTracking() {
                if (this._muteTrackedEl && this._muteHandler) {
                    this._muteTrackedEl.removeEventListener('volumechange', this._muteHandler);
                }
                this._muteTrackedEl = null;
                this._muteHandler = null;
            },
            _applyUserMuteChoice(video) {
                if (!video || this._userMutedChoice === null || this._userMutedChoice === undefined) return;
                if (video.muted === this._userMutedChoice) return;
                this._lastScriptMutedValue = this._userMutedChoice;
                video.muted = this._userMutedChoice;
                console.log(`%c沿用用户此前选择的${this._userMutedChoice ? '静音' : '非静音'}状态`, 'color:#607D8B');
            },            resumeAutoPlay() {
                // F4（#32）：用户在播放器里主动暂停后，脚本停止抢播；需要恢复保活时调用本方法。
                this._userPaused = false;
                this._guardLastWallTs = Date.now();
                this._guardLastTime = Number((this._getVideoEl() || {}).currentTime || 0);
                console.log('%c已恢复自动保活（resumeAutoPlay）', 'color:#4CAF50');
            },
            // ================= F66（V3.7）：视频加载失败文案的显式跳过 =================
            // 上游依据：_ocsjs_upstream/packages/scripts/src/projects/cx.ts:1742-1753
            //   上游每 3 秒扫 .vjs-modal-dialog-content，命中四条中文文案之一就 resolve() 结束该视频的播放等待。
            // 本地差异：本地是「有界重试」模型，永久性坏片会白烧 maxRetries 次重试；这里把上游的探测接到
            // 既有监控链上，命中后不伪造完成标记，只走既有推进路径。
            _findVideoFailText() {
                const texts = [
                    '视频文件损坏',
                    '网络错误导致视频下载中途失败',
                    '视频因格式不支持',
                    '网络的问题无法加载',
                ];
                const scan = (doc, depth) => {
                    if (!doc || depth > this.configs.videoFrameMaxDepth) return null;
                    let boxes = [];
                    try { boxes = Array.from(doc.querySelectorAll('.vjs-modal-dialog-content')); } catch (e) { boxes = []; }
                    for (const box of boxes) {
                        let text = '';
                        // 上游读 innerText；无排版环境（jsdom 等）下 innerText 可能取不到，这里回退 textContent。
                        try { text = String(box.innerText || box.textContent || ''); } catch (e) { text = ''; }
                        for (const t of texts) {
                            if (text.indexOf(t) >= 0) return t;
                        }
                    }
                    // 上游只扫顶层文档；本仓库的视频多数在内容帧里，因此按既有帧上限递归（口径与 videoFrameMaxDepth 一致）。
                    let frames = [];
                    try { frames = Array.from(doc.querySelectorAll('iframe, frame')); } catch (e) { frames = []; }
                    for (const frame of frames) {
                        let child = null;
                        try { child = frame.contentDocument; } catch (e) { child = null; }
                        if (!child) continue;
                        const hit = scan(child, depth + 1);
                        if (hit) return hit;
                    }
                    return null;
                };
                try {
                    return scan(typeof document === 'undefined' ? null : document, 0);
                } catch (e) {
                    return null;
                }
            },
            _maybeSkipOnVideoFailText() {
                // F66：探测只由既有循环驱动（_checkVideoStatus 的视频监控链 + _startInteractionWatcher 的互动轮询链），
                // 不新增任何常驻定时器；扫屏节流 3 秒，与上游口径一致。
                if (this.configs.videoFailTextSkip === false) return false;
                const now = Date.now();
                if (now - (this._videoFailTextScanTs || 0) < 3000) return false;
                this._videoFailTextScanTs = now;
                const hit = this._findVideoFailText();
                if (!hit) return false;
                // 已在等人工（互动答题弹窗 / 人脸识别）时不抢动作：坏片探测让位给人工流程，避免误跳。
                if (this._interactionBlocked || this._faceWaitActive) return false;
                // 同一节点 + 同一文案只处理一次（监控循环每秒一次而弹窗会持续存在，必须去重）。
                const key = hit + '|' + String(this._currentStepTitle() || '') + '|'
                    + this._cellData.currentCellIndex + '.' + this._cellData.currentNCellIndex;
                if (this._videoFailTextHandledKey === key) return false;
                this._videoFailTextHandledKey = key;
                this._handleUnrecoverableVideo(hit);
                return true;
            },
            _handleUnrecoverableVideo(text) {
                // F66：不可恢复的视频加载失败 —— 不再重试到底，但仍**绝不伪造完成**：
                // 这里不添加任何 ans-job-finished 之类的完成标记，只把控制权交回既有推进路径。
                console.warn('%c[视频跳过] 检测到' + text + '，本任务点标记为不可恢复', 'color:#F44336;font-weight:bold');
                console.log('处理方法：该片源在服务端已损坏或格式不受支持，重试无法恢复。脚本按既有推进路径继续'
                    + '（小节内还有未完成的视频任务点时先切任务点，否则跳到下一小节）；该任务点不会被标记完成，'
                    + '仍需你稍后手动处理或向老师反馈。');
                this._clearCheckInterval();
                this._isPlaying = false;
                this._videoRefreshTried = false;
                // 复用 _handleVideoEnded 的既有推进路径（小节内未完成视频任务点优先 → 有界延时 nextUnit，
                // 内含 _handlingVideoEnd 去重、_delayedNextUnitTimer 定时器账本登记与导航锁语义），
                // 因此不另写一套跳转逻辑，避免与既有语义漂移。
                this._handleVideoEnded();
            },
            _checkVideoStatus() {
                try {
                    // F66（V3.7）：坏片探测放在 video 判空**之前** —— 播放器报错时可能压根没有可用的 video 元素，
                    // 若放在判空之后，这个场景永远探测不到。
                    if (this._maybeSkipOnVideoFailText()) return;
                    const video = this._getVideoEl();
                    if (!video) return;
                    const now = Date.now();
                    const current = Number(video.currentTime || 0);

                    if (this._guardLastWallTs === 0) {
                        this._guardLastWallTs = now;
                        this._guardLastTime = current;
                    } else if (!video.paused && Math.abs(current - this._guardLastTime) >= 0.01) {
                        this._guardLastWallTs = now;
                        this._guardLastTime = current;
                        if (!this._progressStreakStart) this._progressStreakStart = now;
                        // F14b（V3.6）：持续播放 60 秒即返还保活预算 —— 平台/浏览器造成的瞬时暂停
                        // 不再逐次累积消耗「每小节 5 次」上限（真机演练：两次抖动即耗尽预算导致停滞）。
                        if (now - this._progressStreakStart > 60000 && (this._resumeAttemptsThisUnit > 0 || this._resumeCapLogged)) {
                            this._resumeAttemptsThisUnit = 0;
                            this._resumeCapLogged = false;
                            this._progressStreakStart = now;
                            console.log('%c视频持续播放 60 秒：重置保活预算', 'color:#4CAF50');
                        }
                    }

                    // F12（V3.6）：片尾停滞保护 —— 平台会在片尾主动暂停（恢复次数耗尽后假死）。已播放 ≥ 完成条件比例
                    // 且平台已完成标记时，视同片尾完成直接推进（真机演练：4、宋 元 卡在 255/261，平台已 complete=true）。
                    // F23（V3.6 补丁）：比例优先取页面「完成条件」文案（如「观看时长需 ≥ 总时长的 90%」）；
                    // 多任务点小节里「当前任务点已被平台标记完成 + 达到比例」时提前切下一个任务点，不再白播片尾
                    // （真机实测：984s 视频 92.0% 即被标记，等 ended 要白等约 79s）。
                    if (this._isPlaying && !video.ended) {
                        try {
                            const ratio = this._getUnitCompletionRatio ? this._getUnitCompletionRatio() : (Number(this.configs.videoCompleteRatio) || 0.9);
                            const frames = this._getVideoTaskFrames ? this._getVideoTaskFrames() : [];
                            const reachedRatio = video.duration > 0 && current / video.duration >= ratio;
                            const platformDone = frames.length > 0 && this._areAllVideoTasksComplete ? this._areAllVideoTasksComplete(frames) : false;
                            if (reachedRatio && platformDone) {
                                console.log('%c视频已播放 ≥ ' + Math.round(ratio * 100) + '% 且平台已标记任务点完成，按片尾完成处理并推进', 'color:#4CAF50');
                                this._handleVideoEnded();
                                return;
                            }
                            const currentFrame = frames[this._currentVideoTaskIndex];
                            const currentDone = !!(frames.length > 1 && currentFrame && this._isVideoTaskFrameComplete && this._isVideoTaskFrameComplete(currentFrame));
                            if (reachedRatio && currentDone && !platformDone) {
                                console.log('%c当前视频任务点已完成且达到完成条件 ' + Math.round(ratio * 100) + '%，跳过片尾切换下一个任务点', 'color:#4CAF50');
                                this._handleVideoEnded();
                                return;
                            }
                        } catch (e) { /* 保底：不阻塞主流程 */ }
                    }
                    // F24：并发车道保活（复用本循环，不新增定时器；按 laneKeeperIntervalMs 节流）。
                    if (this.configs.concurrentPlayback) {
                        const laneInterval = Math.max(1000, Number(this.configs.laneKeeperIntervalMs) || 3000);
                        if (now - (this._laneLastKeeperTs || 0) >= laneInterval) {
                            this._laneLastKeeperTs = now;
                            this._laneKeeperTick();
                        }
                    }
                    if (video.paused && this._isPlaying) {
                        this._progressStreakStart = 0;
                        if (this._isProgressStalled(now)) {
                            const cap = Math.max(1, Number(this.configs.resumeMaxAttemptsPerUnit) || 5);
                            if (this._resumeAttemptsThisUnit < cap) {
                                console.log('%c检测到视频暂停且进度停滞，按有界策略尝试恢复播放...', 'color:#FF5722');
                                this._tryResumePlayback('paused');
                            }
                            // 达到上限后不再每秒重复打印（上限提示已由 _tryResumePlayback 打印一次）
                        }
                    } else if (this._isPlaying && !video.ended) {
                        if (now - this._guardLastWallTs >= this.configs.guardNoProgressMs && this._isProgressStalled(now)) {
                            if (this._tryResumePlayback('no-progress')) {
                                this._guardLastWallTs = now;
                                this._guardLastTime = Number(video.currentTime || 0);
                            }
                        }
                    }

                    if (video.ended && this._isPlaying) {
                        console.log('%c检测到视频结束，准备切换下一个...', 'color:#9C27B0');
                        // 统一走 _handleVideoEnded：内部会先处理「小节内还有未完成的视频任务点」（PR #48 思路），
                        // 并用 _handlingVideoEnd 防止事件与轮询重复触发。
                        this._handleVideoEnded();
                    }
                } catch (e) {
                    console.error('视频状态检查失败:', e);
                }
            },
            _tryTimes: 0,
            // F21（V3.6 补丁）：空视频节点（平台内容帧「暂无内容」）连续命中计数，连续 2 次才转入无视频流程。
            _emptyContentStreak: 0,
            // F66（V3.7）：坏片文案探测状态 —— 扫屏节流时间戳 + 已处理键（同节点同文案只跳过一次）。
            _videoFailTextScanTs: 0,
            _videoFailTextHandledKey: null,
            // F68（V3.7）：人脸识别等待状态 —— 命中后暂停自动推进并只提示一次，人脸消失后自动恢复（由 F68 使用）。
            _faceWaitActive: false,
            _faceWaitNotified: false,
            // F67（V3.7）：章节未完成数交叉校验的日志去重键与最近一次裁决结果（真机排查入口）。
            _chapterCountCheckKey: '',
            _lastChapterCountCheck: null,
            // F22（V3.6 补丁）：play() 超时后「强制失效缓存并重新定位」是否已用过（播放成功/切换小节/run 后重置）。
            _videoRefreshTried: false,
            // F23（V3.6 补丁）：本小节「完成条件」文案解析出的比例（如 90% → 0.9）；null=未解析到，按配置回退。
            _unitCompletionRatio: null,
            // F24：并发车道保活状态
            _laneReplays: 0,
            _laneCapLogged: false,
            _laneLoadTried: null,
            _laneLastLogTs: 0,
            _stepAdvanceTimes: 0,
            _stepSwitchAt: 0,
            _stepSwitchPending: false,
            _delayedNextUnitTimer: null,
            _guardLastTime: 0,
            _guardLastWallTs: 0,
            _guardLastResumeTs: 0,
            _progressStreakStart: 0,
            _pauseGuardBlocked: 0,
            _hiddenKeepAliveActive: false,
            _hiddenResumeCount: 0,
            _cxFontB64: '',
            _cxFontLoaded: false,
            _cxSecretMap: null,
            _workLocked: false,
            _workLockReason: '',
            _guardProbeTimer: null,
            _seekBackTimesThisUnit: 0,
            _seekBackCapLogged: false,
            _userMutedChoice: null,
            _muteTrackedEl: null,
            _muteHandler: null,
            _lastScriptMutedValue: null,
            async play() {
                try {
                    if (this._interactionBlocked) {
                        console.warn('%c当前有互动答题弹窗，暂停自动播放，等待手动完成（#29 #39）', 'color:#FF9800');
                        return;
                    }
                    // F68（V3.7）：人脸识别闸门 —— 接入点选在 play() 入口，对齐上游 1757-1758 的语义
                    //（上游是在 media() 每次保活播放前先检测并 await 等待人脸）。
                    // 选这里的理由：play() 是 playCurrentIndex / _handleVideoEnded / 保活重试 / GUI 恢复 /
                    // 静音兜底重试的唯一公共入口，闸门放在这里任何推进路径都绕不过去；
                    // 若放在 _checkVideoStatus 里，自动跳转链（nextUnit → playCurrentIndex）就不会经过它。
                    if (this.configs.interactionFaceWait !== false && this._hasFaceRecognition()) {
                        this._waitForFaceRecognition();
                        return;
                    }
                    const el = this._getVideoEl();
                    if (el == null) {
                        // F33：直播节点优先识别（直播不自动处理，也不能被 autoAdvanceNoVideo 当未知节点跳过）。
                        if (this._isLiveNode()) {
                            this._stopForLiveNode();
                            return;
                        }
                        // F38（V3.6 补丁）：本小节视频任务点已全部完成（平台已标记/上次播放遗留）时，
                        // 不能再按「视频组件尚未加载完成」重试到触顶（真机：第7章第3节死循环）——
                        // 跳过该分支，交给下面的无视频推进流程（_handleNoVideoNode 会按「全部完成」前进）。
                        if (this._currentStepTitle() === '视频' && !this._videoTaskAllComplete) {
                            // F21（V3.6 补丁）：空视频节点——老师没上传内容时平台内容帧只有「暂无内容」，
                            // 不再按「视频组件尚未加载完成」重试到触顶，而是转入既有的无视频节点流程：
                            // 有完成标记/图标级证据就有界前进，识别不出来则安全停止（或按 autoAdvanceNoVideo 有界前进）。
                            // 连续 2 次（间隔=retryInterval）确认才动作，避免真实视频刚切换时的瞬时空白被误判。
                            this._emptyContentStreak = this._isEmptyContentVideoNode() ? (this._emptyContentStreak || 0) + 1 : 0;
                            if (this._emptyContentStreak >= 2) {
                                console.warn('%c检测到「视频」节点但平台内容为空（「暂无内容」，疑似老师未上传）→ 转入无视频节点处理流程', 'color:#FF9800');
                                this._emptyContentStreak = 0;
                                this._handleNoVideoNode();
                                return;
                            }
                            throw new Error('视频组件尚未加载完成');
                        }
                        // F46（V3.6）：多任务点节点先切到未核验的任务点标签（见 _handleTaskTabs 注释）
                        if (this._handleTaskTabs()) return;
                        // F11（V3.6）：未完成的内嵌章节测验/作业优先处理，绝不跳过
                        // （修复真机演练发现的「autoAdvanceNoVideo 把章节检验当未知节点跳过」问题）。
                        if (this._hasUnfinishedEmbeddedWork()) {
                            this._handleEmbeddedWorks();
                            return;
                        }
                        // F13（V3.6）：未完成的文档任务点（PDF/PPT/教案）自动翻阅（真机演练：教案节点被判「无法识别」跳过）。
                        if (this._hasUnfinishedDocTask()) {
                            this._handleDocTasks();
                            return;
                        }
                        // F45（V3.6）：未完成的讨论任务点（BBS）自动参与，绝不当作未知节点跳过。
                        if (this._hasUnfinishedDiscussTask()) {
                            this._handleDiscussTasks();
                            return;
                        }
                        if (this._advanceLearningStep()) {
                            console.log('%c当前不在视频页，已尝试切到下一学习步骤，2秒后重试', 'color:#607D8B');
                            this._schedule(() => {
                                this.play();
                            }, 600);
                            return;
                        }
                        if (this._isChapterTest()) {
                            // F10（V3.5）：默认维持既有「受限跳过」；仅当显式开启 llmChapterTest 时改为
                            // 在面板给出建议答案并暂停自动跳过（实验性，绝不自动点击）。
                            if (this._maybeSuggestChapterTest()) return;
                            this._advanceChapterTest();
                            return;
                        }
                        this._handleNoVideoNode();
                        return;
                    }

                    this._isPlaying = true;
                    // F3（#38 #43）：重新看到视频即结束「连续自动前进」计数。
                    this._consecutiveNoVideoAdvances = 0;
                    this._emptyContentStreak = 0; // F21：重新看到视频即清零空节点计数
                    this._videoEventHandle();
                    el.playbackRate = this.configs.playbackRate;
                    // F4（#19 #32）：不默认强制静音；只沿用用户此前手动选择过的静音状态。
                    this._applyUserMuteChoice(el);

                    try {
                        // PR #56：play() 可能永不 settle，这里加超时保护，超时按播放失败处理（重试/静音兜底）。
                        await this._withTimeout(el.play(), this.configs.playTimeoutMs, 'play() 超时，播放器未进入播放状态');
                        this._tryTimes = 0;
                        this._videoRefreshTried = false;
                        console.log(`%c视频开始播放，倍速: ${el.playbackRate}x`, 'color:#4CAF50');
                        this._startVideoMonitoring();
                    } catch (playError) {
                        console.error('视频播放失败:', playError);
                        // F22：超时往往意味着拿到的是僵尸文档里的旧 video（play() 永不 settle）。
                        // 强制失效缓存并重新定位一次，能恢复就继续播；仍失败才走原有静音兜底/重试链。
                        const timeoutLike = /超时/.test(String((playError && playError.message) || playError));
                        if (timeoutLike && !this._videoRefreshTried) {
                            this._videoRefreshTried = true;
                            this._invalidateVideoCache('play() 超时，重新定位视频元素');
                            console.log('%c播放超时：已失效视频缓存并重新定位，重试一次', 'color:#FF9800');
                            this._schedule(() => this.play(), 300);
                            return;
                        }
                        this._handlePlayError(playError);
                    }
                } catch (e) {
                    if (this._tryTimes >= this.configs.maxRetries) {
                        console.error('%c视频播放失败，已达到最大重试次数', 'color:#F44336;font-weight:bold', e);
                        this._clearCheckInterval();
                        // F1（#9 #24 #27 #37 #50）：触顶也是「退出路径」，必须释放导航锁，
                        // 否则后续 nextUnit() 会被静默忽略。
                        this._releaseNavLock('play() 达到最大重试次数');
                        return;
                    }
                    this._tryTimes++;
                    console.log(`%c播放失败，${this.configs.retryInterval / 1000}秒后重试 (${this._tryTimes}/${this.configs.maxRetries})`, 'color:#FF9800');
                    this._schedule(() => {
                        this.play();
                    }, this.configs.retryInterval);
                }
            },
            // ================= F46（V3.6）：节点内多任务点（平台任务点标签页）遍历 =================
            // 逆向依据见 patch-f46 头部注释：changeDisplayContent 只把「当前标签对应的任务点」渲染进 #iframe。
            _taskTabs() {
                const out = [];
                try {
                    const lis = Array.from(document.querySelectorAll('#prev_tab li, .prev_ul li'));
                    for (const li of lis) {
                        const onclick = String(li.getAttribute('onclick') || '');
                        const m = /changeDisplayContent\(\s*(\d+)\s*,\s*(\d+)/.exec(onclick);
                        if (!m) continue;
                        out.push({
                            index: Number(m[1]),
                            total: Number(m[2]),
                            title: String(li.getAttribute('title') || li.textContent || '').replace(/\s+/g, '').slice(0, 16),
                            active: /(^|\s)active(\s|$)/.test(String(li.className || '')),
                            id: li.id || '',
                        });
                    }
                } catch (e) { /* ignore */ }
                return out;
            },
            _nodeUnfinishCount() {
                // 平台在章节树里维护的「本节点未完成任务点数」：比 DOM 推断权威，且能覆盖"未显示的任务点"。
                try {
                    const el = document.querySelector('.posCatalog_active input.jobUnfinishCount')
                        || document.querySelector('#coursetree input.jobUnfinishCount');
                    if (el && el.value !== '' && el.value !== undefined && el.value !== null) return Number(el.value);
                } catch (e) { /* ignore */ }
                return null;
            },
            // ================= F67（V3.7）：章节未完成数的第二数据源与交叉校验 =================
            // 上游依据：_ocsjs_upstream/packages/scripts/src/projects/cx.ts:1138-1145（getChapterInfos）。
            // 上游从 [onclick^="getTeacherAjax"] 的 onclick 里用第 3 组正则取 chapterId，
            // 再读兄弟容器的 .jobUnfinishCount 得到该章未完成数。这里原样移植，作为本地 DOM 统计之外的第二数据源。
            _getChapterInfos() {
                const out = [];
                try {
                    const els = Array.from(document.querySelectorAll('[onclick^="getTeacherAjax"]'));
                    for (const el of els) {
                        let chapterId = null;
                        try {
                            const onclick = String(el.getAttribute('onclick') || '');
                            const m = /\('(.*)','(.*)','(.*)'\)/.exec(onclick);
                            chapterId = m ? m[3] : null;
                        } catch (e) { chapterId = null; }
                        let unFinishCount = null;
                        try {
                            const holder = el.parentElement || el.parentNode;
                            const node = holder && holder.querySelector ? holder.querySelector('.jobUnfinishCount') : null;
                            if (node && node.value !== '' && node.value !== undefined && node.value !== null) {
                                unFinishCount = Number(node.value);
                            }
                        } catch (e) { unFinishCount = null; }
                        // 上游只取 chapterId 与未完成数；这里额外标注「当前激活章节」，用于定位要交叉校验的那一章。
                        let active = false;
                        try {
                            const scope = el.closest ? el.closest('li') : null;
                            active = !!(scope && (scope.classList.contains('posCatalog_active')
                                || (scope.querySelector && scope.querySelector('.posCatalog_active'))));
                        } catch (e) { active = false; }
                        out.push({ element: el, chapterId: chapterId, unFinishCount: unFinishCount, active: active });
                    }
                } catch (e) { /* ignore */ }
                return out;
            },
            _crossCheckChapterCount(localTotal, localUnfinished) {
                // F67：两个层级各比一次，因为「服务端计数」与「本地 DOM 统计」只在同层才可比：
                //   1) 章节级：激活章的 input.jobUnfinishCount（服务端） vs 该章内所有节点未完成数之和（本地 DOM）；
                //   2) 任务点级：当前节点 input.jobUnfinishCount（服务端） vs .ans-job-icon 图标级统计（本地）。
                // 约束（用户明确要求）：两者不一致时**采用服务端计数**并记中文方括号日志；
                // 但既有推进逻辑的主判定保持原样（本函数只输出裁决值与日志，不替换任何完成判定）。
                if (this.configs.chapterCountCrossCheck === false) return null;
                const infos = this._getChapterInfos();
                if (!infos.length) return null;   // 目录里没有该结构（非课程页或平台改版）→ 不参与判定
                const current = infos.find((c) => c.active) || null;
                const serverChapter = current ? current.unFinishCount : null;
                let localChapter = null;
                try {
                    const scope = current && current.element && current.element.closest ? current.element.closest('li') : null;
                    // 章节自身那个计数（就在 onclick 元素的同级容器里）必须排除，否则会被算两次。
                    const selfHolder = current && current.element ? (current.element.parentElement || current.element.parentNode) : null;
                    if (scope) {
                        const nodes = Array.from(scope.querySelectorAll('.jobUnfinishCount'))
                            .filter((n) => !(selfHolder && selfHolder.contains && selfHolder.contains(n)));
                        let sum = 0;
                        let seen = 0;
                        for (const n of nodes) {
                            const v = Number(n.value);
                            if (Number.isNaN(v)) continue;
                            sum += v;
                            seen++;
                        }
                        // 一个都没数到时不参与比对（口径不明比错杀更危险）。
                        if (seen > 0) localChapter = sum;
                    }
                } catch (e) { localChapter = null; }
                const serverNode = this._nodeUnfinishCount();
                const agree = (serverChapter !== null && localChapter !== null) ? (serverChapter === localChapter) : null;
                const result = {
                    chapterId: current ? current.chapterId : null,
                    serverChapter: serverChapter,
                    localChapter: localChapter,
                    serverNode: serverNode,
                    localNode: localUnfinished,
                    total: localTotal,
                    agree: agree,
                    // 裁决口径：服务端可得就以服务端为准，否则退回本地统计。
                    unresolved: serverChapter !== null ? serverChapter : localUnfinished,
                    source: serverChapter !== null ? 'server' : 'local',
                };
                // 日志去重：同一组数值只播报一次（本函数会被每个节点/每次校验调用）。
                const key = [result.chapterId, serverChapter, localChapter, serverNode, localUnfinished, localTotal].join('/');
                if (this._chapterCountCheckKey !== key) {
                    this._chapterCountCheckKey = key;
                    if (agree === false) {
                        console.warn('%c[章节校验] 服务端未完成 ' + serverChapter + ' 与本地统计 ' + localChapter
                            + ' 不一致，采用服务端计数', 'color:#FF9800');
                    } else if (agree === true) {
                        console.log('%c[章节校验] 服务端未完成 ' + serverChapter + ' 与本地统计一致（chapterId=' + (result.chapterId || '未知') + '）', 'color:#607D8B');
                    }
                    if (serverNode !== null && localUnfinished !== null && serverNode !== localUnfinished) {
                        console.warn('%c[章节校验] 本节任务点：服务端 ' + serverNode + ' 与本地图标级统计 ' + localUnfinished
                            + ' 不一致，采用服务端计数', 'color:#FF9800');
                    }
                }
                this._lastChapterCountCheck = result;   // 真机排查入口：控制台 app._lastChapterCountCheck
                return result;
            },
            _activeTabUnfinished() {
                // 当前显示的任务点是否还没做完（图标级证据 / 题面 / 文档 / 讨论）
                try {
                    const icons = Array.from(document.querySelectorAll('.ans-job-icon'));
                    const hasUnfinishedIcon = icons.some((el) => {
                        let h = null;
                        try { h = el.closest ? el.closest('.ans-attach-ct') : null; } catch (e) { h = null; }
                        return !(h && h.classList.contains('ans-job-finished'));
                    });
                    if (hasUnfinishedIcon) return true;
                    if (typeof this._hasUnfinishedEmbeddedWork === 'function' && this._hasUnfinishedEmbeddedWork()) return true;
                    if (typeof this._hasUnfinishedDocTask === 'function' && this._hasUnfinishedDocTask()) return true;
                    if (typeof this._hasUnfinishedDiscussTask === 'function' && this._hasUnfinishedDiscussTask()) return true;
                    if (document.querySelector('.TiMu, #Zy_TItle, .questionLi, .examTitle')) return true;
                } catch (e) { /* ignore */ }
                return false;
            },
            _handleTaskTabs() {
                const tabs = this._taskTabs();
                if (tabs.length <= 1) return false;                       // 单任务点节点：走原逻辑
                const total = tabs[0] ? tabs[0].total : tabs.length;
                const nodeKey = String(this._currentStepTitle() || '') + '#' + total;
                if (this._taskTabNodeKey !== nodeKey) {
                    this._taskTabNodeKey = nodeKey;
                    this._taskTabChecked = {};
                }
                const platformLeft = this._nodeUnfinishCount();
                if (platformLeft === 0) return false;                     // 平台说本节点任务点都完成了
                if (this._activeTabUnfinished()) return false;            // 当前显示的任务点还没做完 → 交给既有处理器
                for (const t of tabs) {
                    if (t.active) continue;
                    if (this._taskTabChecked[t.index]) continue;
                    this._taskTabChecked[t.index] = true;
                    console.log('%c[任务点标签] 切换任务点 ' + t.index + '/' + total + '（' + t.title + '）——多任务点节点必须逐个进入，否则会被漏掉', 'color:#2196F3');
                    try {
                        const li = t.id ? document.getElementById(t.id) : null;
                        if (li) li.click();
                        else {
                            const f = Array.from(document.querySelectorAll('#prev_tab li')).find((x) => String(x.getAttribute('title') || '') === t.title);
                            if (f) f.click();
                        }
                    } catch (e) { console.warn('%c[任务点标签] 切换失败：' + e.message, 'color:#FF9800'); }
                    // F46b（真机修正）：切完标签必须**主动重新调度主循环**。
                    // 既有钩子（作业/文档/讨论）都由各自处理器负责后续调度，这里只是"切了个标签"；
                    // 漏掉这一步会导致"切过去就静止"（真机：stalled 一路涨、无任何作答日志）。
                    this._schedule(() => this.play(), 2500);
                    return true;                                          // 已切换 → 稍后重新评估新内容
                }
                return false;
            },
            // F20（V3.6）：任务点图标级校验 —— 遍历所有同源文档，统计「未完成任务点」数量。
            // 判定依据与平台一致：.ans-job-icon / iframe[jobid] 的父容器带有 ans-job-finished 即已完成。
            // 真机背景：课件/PPT 节点做完后仍报「无法识别完成状态」，需要图标级证据支撑自动推进。
            _countUnfinishedTaskPoints() {
                let total = 0;
                let unfinished = 0;
                const seenEls = new Set();
                const seenDocs = new Set();
                const countEl = (el) => {
                    if (!el || seenEls.has(el)) return;
                    seenEls.add(el);
                    total++;
                    let done = false;
                    try { done = !!(el.parentElement && el.parentElement.classList.contains('ans-job-finished')); } catch (e) { done = false; }
                    if (!done) unfinished++;
                };
                const visit = (doc, depth) => {
                    if (!doc || depth > 6 || seenDocs.has(doc)) return;
                    seenDocs.add(doc);
                    let icons = [];
                    try { icons = Array.from(doc.querySelectorAll('.ans-job-icon')); } catch (e) { icons = []; }
                    for (const el of icons) countEl(el);
                    let frames = [];
                    try { frames = Array.from(doc.querySelectorAll('iframe, frame')); } catch (e) { frames = []; }
                    for (const frame of frames) {
                        let jobid = '';
                        try { jobid = String(frame.getAttribute('jobid') || ''); } catch (e) { jobid = ''; }
                        if (jobid) {
                            let holder = null;
                            try { holder = frame.closest ? frame.closest('.ans-attach-ct') : null; } catch (e) { holder = null; }
                            if (holder) {
                                if (seenEls.has(holder)) continue;
                                seenEls.add(holder);
                                total++;
                                let done = false;
                                try { done = holder.classList.contains('ans-job-finished'); } catch (e) { done = false; }
                                if (!done) unfinished++;
                                continue;
                            }
                        }
                        let childDoc = null;
                        try { childDoc = frame.contentDocument; } catch (e) { childDoc = null; }
                        if (childDoc) visit(childDoc, depth + 1);
                    }
                };
                visit(typeof document === 'undefined' ? null : document, 0);
                // F46：附带平台在章节树里维护的「本节点未完成数」——能覆盖"任务点标签页未显示、图标不在 DOM"的情况
                const platformUnfinished = this._nodeUnfinishCount();
                // F67（V3.7）：第二数据源交叉校验（服务端 jobUnfinishCount vs 本地 DOM 统计），结果挂字段输出。
                // 注意：下面的 total/unfinished 仍按既有主判定口径返回，交叉校验不替换它们（只做校验与日志）。
                const crossCheck = this._crossCheckChapterCount(total, unfinished);
                return { total: total, unfinished: unfinished, platformUnfinished: platformUnfinished, crossCheck: crossCheck };
            },
            _isLiveNode() {
                // F33（V3.6 补丁）：直播任务点识别 —— 直播节点此前会落入无视频流程被当未知节点处理。
                // 判定：标题含「直播」，或内容帧/子帧出现直播文案或 live 模块，且全页没有真实 video（避免误判）。
                if (!this.configs.liveGuard) return false;
                try {
                    if (/直播/.test(String(this._currentStepTitle() || ''))) return true;
                    let liveText = false;
                    let hasVideo = false;
                    const scan = (doc, depth) => {
                        if (depth > 3 || hasVideo) return;
                        try { if (doc.querySelector && doc.querySelector('video')) { hasVideo = true; return; } } catch (e) { /* ignore */ }
                        let text = '';
                        try { text = String((doc.body && (doc.body.innerText || doc.body.textContent)) || ''); } catch (e) { text = ''; }
                        if (/(正在)?直播|直播回放|等待直播|直播中|直播未开始/.test(text)) liveText = true;
                        let frames = [];
                        try { frames = Array.from(doc.querySelectorAll('iframe, frame')); } catch (e) { frames = []; }
                        for (const f of frames) {
                            let src = '';
                            let child = null;
                            try { src = String(f.getAttribute('src') || ''); child = f.contentDocument; } catch (e) { child = null; }
                            if (/live/i.test(src)) { liveText = true; continue; }
                            if (child) scan(child, depth + 1);
                        }
                    };
                    scan(document, 0);
                    return liveText && !hasVideo;
                } catch (e) {
                    return false;
                }
            },
            _stopForLiveNode() {
                this._clearCheckInterval();
                this._isPlaying = false;
                console.warn('%c检测到直播任务点（脚本不自动处理直播）：已停止自动推进，避免把直播当成未知节点跳过。', 'color:#FF9800');
                console.log('处理方法：1) 直播进行中：请等待直播结束并在页面上确认完成；2) 若是直播回放：可手动播放，或平台已自动标记完成后执行 app.nextUnit()。');
                this._releaseNavLock('直播节点安全停止');
            },
            _isEmptyContentVideoNode() {
                // F21（V3.6 补丁，真机演练：第 16 章「16.1.2 视频」空节点）：
                // 老师没有给该节点上传任何内容时，平台内容帧只有空占位文案「暂无内容」——
                // 此时既没有 <video> 也没有任何任务点 iframe，不能按「视频组件尚未加载完成」去重试。
                // 只有同时满足「内容帧已加载且正文为暂无内容」+「全页无任何视频证据」才判定为空节点，
                // 避免把加载中的真实视频误判成空节点而跳过节。
                if (typeof document === 'undefined') return false;
                const state = { emptyPlaceholder: false, videoEvidence: false };
                const textOf = (doc) => {
                    try {
                        const body = doc && doc.body;
                        if (!body) return '';
                        return String(body.innerText || body.textContent || '').replace(/\s+/g, ' ').trim();
                    } catch (e) {
                        return '';
                    }
                };
                const scan = (doc, depth) => {
                    if (!doc || depth > 4 || state.videoEvidence) return;
                    try {
                        if (doc.querySelector && doc.querySelector('video')) {
                            state.videoEvidence = true;
                            return;
                        }
                    } catch (e) { /* ignore */ }
                    let frames = [];
                    try { frames = Array.from(doc.querySelectorAll('iframe, frame')); } catch (e) { frames = []; }
                    for (const frame of frames) {
                        if (state.videoEvidence) return;
                        let src = '';
                        let jobid = '';
                        try {
                            src = String(frame.getAttribute('src') || '');
                            jobid = String(frame.getAttribute('jobid') || '');
                        } catch (e) { /* ignore */ }
                        // 视频任务点 iframe（jobid="video-xxx"）出现即视为视频证据，宁可继续重试也不误跳。
                        if (jobid && /video/i.test(jobid)) {
                            state.videoEvidence = true;
                            return;
                        }
                        let childDoc = null;
                        try { childDoc = frame.contentDocument; } catch (e) { childDoc = null; }
                        // 内容帧识别：src 指向知识卡片页（生产环境实际结构），或 id="iframe" 的旧版内容帧
                        // （新旧壳页共存，id 兜底且仍叠加「暂无内容 + 全页无视频证据」双条件，误判概率极低）。
                        const isContentFrame = /knowledge\/(cards|content)/.test(src) || frame.id === 'iframe';
                        if (childDoc && isContentFrame) {
                            let ready = true;
                            try { ready = !childDoc.readyState || childDoc.readyState !== 'loading'; } catch (e) { ready = true; }
                            if (ready && /^暂无(学习)?内容/.test(textOf(childDoc))) state.emptyPlaceholder = true;
                        }
                        if (childDoc) scan(childDoc, depth + 1);
                    }
                };
                try { scan(document, 0); } catch (e) { return false; }
                return state.emptyPlaceholder && !state.videoEvidence;
            },
            _handleNoVideoNode() {
                // 用户 2026-09-17：问卷识别**不依赖任务点标记** —— 进入节点先看一眼内容区是不是问卷。
                // （平台把问卷放进章节树但不标任务点，只靠"无任务点"分支兜是补漏，节点入口才是主判据。）
                try {
                    if (this.configs.surveyDetect !== false && this.configs.surveyAutoFill !== false && this._llmApiKey && !this._surveyHandledForThisUnit) {
                        const sv = this._detectSurveyInFrames();
                        if (sv) {
                            this._surveyHandledForThisUnit = true;
                            console.log('%c[问卷] 节点入口识别到问卷（' + sv.questions + ' 个控件 / ' + sv.groups + ' 个题组）→ LLM 自动作答', 'color:#2196F3');
                            try { this._handleSurveyNode(sv); return; } catch (e) { console.error('[问卷] 入口处理异常:', e); }
                        }
                    }
                } catch (e) { /* 识别失败不改变既有行为 */ }
                // F3（#38 #42 #43 #50）：无视频/课件页不再默认卡死，但也不能盲目乱跳：
                //   1) 只有「能识别出该节点已完成/无任务点」时才自动前进；
                //   2) 识别不出来时保持安全停止，并打印可操作提示；
                //   3) 两种情况都受 maxConsecutiveNoVideoAdvances 上限约束，避免死循环。
                this._isPlaying = false;
                this._clearCheckInterval();
                const verdict = this._classifyNodeCompletion();
                // 思路移植自 PR #48 @CsuCook1e：小节内视频任务点全部完成时应当前进，而不是判成「无法识别」
                if (this._videoTaskAllComplete) {
                    verdict.completed = true;
                    verdict.signals = (verdict.signals || []).concat(['小节内视频任务点全部完成']);
                }

                // F20（V3.6）：在判定「无法识别」之前，先做任务点图标级校验：
                //   本小节没有任何任务点 / 全部任务点均已完成 → 按「已完成/无任务点」处理并推进（受上限约束）。
                if (!verdict.completed) {
                    const tp = this._countUnfinishedTaskPoints();
                    // 注意：只有「存在任务点且全部完成」才算完成证据。
                    // total === 0（完全找不到任务点）必须保持原有安全策略（默认停止/配置内有界前进），
                    // 否则会破坏 F3 的安全停止设计（无任务点可能意味着结构未识别）。
                    if (tp.total > 0 && tp.unfinished === 0) {
                        verdict.completed = true;
                        verdict.signals = (verdict.signals || []).concat(['全部 ' + tp.total + ' 个任务点均已完成（图标级校验）']);
                    } else {
                        console.warn('%c[任务点校验] 本小节仍有 ' + tp.unfinished + '/' + tp.total + ' 个任务点未完成，按未识别流程处理', 'color:#FF9800');
                    }
                }

                if (verdict.completed) {
                    if (this._consecutiveNoVideoAdvances >= this.configs.maxConsecutiveNoVideoAdvances) {
                        console.error(`%c连续自动前进已达上限（${this.configs.maxConsecutiveNoVideoAdvances} 次），已停止以避免死循环（#38 #43）。`, 'color:#F44336;font-weight:bold');
                        console.log('处理方法：请人工确认课程目录结构；确认无误后可执行 app.nextUnit() 逐节跳过，或执行 app.run() 重新开始。');
                        this._releaseNavLock('无视频自动前进触顶');
                        return;
                    }
                    this._consecutiveNoVideoAdvances++;
                    // 用户 2026-09-17：问卷小节在平台侧**不计任务点**，会被这里当"无任务点"静默跳过。
                    // 本版只做「识别 + 明确播报」+ 记录，不自动作答（自动作答需另开开关，另行实现）。
                    if (this.configs.surveyDetect !== false) {
                        try {
                            const survey = this._detectSurveyInFrames();
                            if (survey) {
                                this._lastSurvey = survey;
                                if (this.configs.surveyAutoFill !== false && this._llmApiKey) {
                                    console.warn('%c[问卷] 识别到「无任务点」调查问卷 → 交给 LLM 自动作答（' + (survey.title || '') + '）', 'color:#2196F3');
                                    try { this._handleSurveyNode(survey); } catch (e) { console.error('[问卷] 自动作答异常:', e); this.nextUnit(); }
                                    return;
                                }
                                console.warn('%c[问卷] 识别到「无任务点」的调查问卷：' + survey.title
                                    + '（workId=' + (survey.workId || '未知') + '，题组 ' + survey.groups + ' 个，题干数 ' + survey.questions + '）'
                                    + ' → 本版只识别不自动作答，按无任务点跳过', 'color:#FF9800');
                            }
                        } catch (e) { /* 识别失败不影响既有行为 */ }
                    }
                    console.warn(`%c当前小节已识别为「已完成/无任务点」（依据：${verdict.signals.join('、')}），自动前进 ${this._consecutiveNoVideoAdvances}/${this.configs.maxConsecutiveNoVideoAdvances}（#38 #43）`, 'color:#FF9800');
                    this.nextUnit();
                    return;
                }

                // 思路移植自 PR #48 @CsuCook1e（_getTaskKind / _handleReadingTask 的分类思路）：
                // 阅读/教材类任务点只给针对性提示，不做自动滚动或代读（那会改动页面内容，不在本版修复范围）。
                if (this._getTaskKind() === 'reading') {
                    console.log('检测到阅读/教材类任务点：脚本不会自动滚动或代读（#42），请手动完成后执行 app.nextUnit()。');
                }
                if (this.configs.autoAdvanceNoVideo) {
                    if (this._consecutiveNoVideoAdvances >= this.configs.maxConsecutiveNoVideoAdvances) {
                        console.error(`%c连续自动前进已达上限（${this.configs.maxConsecutiveNoVideoAdvances} 次），已停止以避免死循环（#38 #43）。`, 'color:#F44336;font-weight:bold');
                        console.log('处理方法：请人工确认课程目录结构；确认无误后可执行 app.nextUnit() 逐节跳过，或执行 app.run() 重新开始。');
                        this._releaseNavLock('无视频自动前进触顶');
                        return;
                    }
                    this._consecutiveNoVideoAdvances++;
                    console.warn(`%c当前小节无法识别完成状态，但 autoAdvanceNoVideo=true，按配置有界前进 ${this._consecutiveNoVideoAdvances}/${this.configs.maxConsecutiveNoVideoAdvances}`, 'color:#FF9800');
                    this.nextUnit();
                    return;
                }

                console.warn('%c当前小节未发现视频，且无法识别「是否已完成/无任务点」，已安全停止（#38 #43）。', 'color:#FF9800');
                console.log('处理方法：1) 确认该小节确实无需完成（纯课件/讨论）后，执行 app.nextUnit() 跳过；'
                    + '2) 也可执行 app.configs.autoAdvanceNoVideo = true 再 app.run()，让脚本有界自动前进；'
                    + '3) 若这本该是视频页，请检查网络与播放器 iframe 是否加载（#52）。');
                this._releaseNavLock('无视频安全停止');
            },
            // ------------------------------------------------------------------
            // 以下视频任务点 / 任务点弹窗 / 任务分类逻辑「思路移植自 PR #48 @CsuCook1e」，
            // 按其函数命名保留可追溯性，并适配本仓库的单一源码、有界动作与跨域安全原则。
            // ------------------------------------------------------------------
            _findVideoTaskFrames(rootWin, depth, result) {
                // 思路移植自 PR #48 @CsuCook1e（_findVideoFramesInWindow）：递归收集小节内的视频任务点 iframe；
                // 跨域 frame 抛 SecurityError 时直接跳过（不当作硬错误打印），并带深度上限保护。
                const found = result || [];
                if (!rootWin || depth > this.configs.videoTaskFrameMaxDepth) return found;
                if (found.length >= this.configs.videoTaskFrameMaxCount) return found;
                let frames = [];
                try {
                    frames = Array.from(rootWin.document.querySelectorAll('iframe'));
                } catch (e) {
                    if (e && e.name === 'SecurityError') return found;
                    console.warn('扫描视频任务点 iframe 失败:', e);
                    return found;
                }
                for (const frame of frames) {
                    if (found.length >= this.configs.videoTaskFrameMaxCount) break;
                    let attrs = '';
                    try {
                        attrs = [frame.className, frame.id, frame.name, frame.title, frame.getAttribute && frame.getAttribute('src')].join(' ').toLowerCase();
                    } catch (e) {
                        attrs = '';
                    }
                    if (attrs.indexOf('ans-insertvideo') >= 0 || attrs.indexOf('insertvideo') >= 0 || attrs.indexOf('video') >= 0) {
                        found.push(frame);
                    }
                    try {
                        if (frame.contentWindow) {
                            this._findVideoTaskFrames(frame.contentWindow, depth + 1, found);
                        }
                    } catch (e) {
                        if (e && e.name === 'SecurityError') continue;
                        console.warn('视频任务点 iframe 递归跳过:', e);
                    }
                }
                return found;
            },
            _getVideoTaskFrames() {
                // 思路移植自 PR #48 @CsuCook1e（_getVideoFrames）
                return this._findVideoTaskFrames(window, 0, []);
            },
            _isCompleteTaskText(text) {
                // 思路移植自 PR #48 @CsuCook1e（_isCompleteTaskText）：显式完成文案，且排除未完成类措辞。
                const normalized = String(text || '').replace(/\s+/g, '');
                const completeTexts = ['任务点已完成', '已完成'];
                const incompleteTexts = ['待完成', '未完成', '未学习', '进行中'];
                return completeTexts.some((value) => normalized.indexOf(value) >= 0)
                    && !incompleteTexts.some((value) => normalized.indexOf(value) >= 0);
            },
            _detectSurveyInFrames() {
                // 逆向结论（2026-09-17 真机 198）：问卷在 iframe[src*="/mooc-ans/api/work"] 内，
                // 题组按 name="answer<题目ID>" 分组（radio 单选 / checkbox 多选 / textarea 填空）；
                // 平台**不把问卷标成任务点**，所以它会被"无任务点"流程静默跳过 —— 本方法负责把它认出来。
                const seen = new Set();
                const out = { title: '', workId: '', groups: 0, questions: 0, docs: [] };
                const walk = (doc, depth) => {
                    if (!doc || depth > 3 || seen.has(doc)) return;
                    seen.add(doc);
                    try {
                        const wm = String((doc.location && doc.location.href) || '').match(/workId=(\d+)/);
                        if (wm && !out.workId) out.workId = wm[1];
                        const t = doc.body ? String(doc.body.textContent || '') : '';
                        const tm = t.match(/[^\n]{0,20}问卷[^\n]{0,30}/);
                        if (tm && !out.title) out.title = tm[0].replace(/\s+/g, ' ').trim().slice(0, 60);
                    } catch (e) { /* 跨域文档读不到正文，跳过 */ }
                    let frames = [];
                    try { frames = Array.prototype.slice.call(doc.querySelectorAll('iframe')); } catch (e) { frames = []; }
                    for (const f of frames) {
                        let d = null;
                        try { d = f.contentDocument || (f.contentWindow && f.contentWindow.document); } catch (e) { d = null; }
                        if (!d) continue;
                        const src = String(f.getAttribute('src') || '');
                        let names = [];
                        try {
                            names = Array.prototype.slice.call(d.querySelectorAll('input[type=radio],input[type=checkbox],textarea'))
                                .map((e) => String(e.name || '')).filter((n) => /^answer/.test(n));
                        } catch (e) { names = []; }
                        if (names.length) {
                            let uniq = 0; const set = new Set();
                            names.forEach((n) => { if (!set.has(n)) { set.add(n); uniq++; } });
                            out.groups += uniq;
                            out.questions += names.length;
                            out.docs.push(d);
                        }
                        walk(d, depth + 1);
                    }
                };
                walk(document, 0);
                return out.groups > 0
                    ? { title: out.title || '（未取到标题）', workId: out.workId, groups: out.groups, questions: out.questions, docs: out.docs }
                    : null;
            },
            async _handleSurveyNode(survey) {
                // 问卷作答闭环：逐题问 LLM（复用 _llmAskChoice）→ 填答 → 全答满才提交 → 收尾推进下一节点
                const cfg = this.configs;
                const doc = (survey && survey.docs && survey.docs[0]) || null;
                const finishAdvance = () => { try { this.nextUnit(); } catch (e) { console.error('[问卷] 推进失败:', e); } };
                if (!doc) { finishAdvance(); return false; }
                const groups = {};
                try {
                    Array.prototype.slice.call(doc.querySelectorAll('input[type=radio],input[type=checkbox],textarea'))
                        .filter((e) => /^answer/.test(String(e.name || '')))
                        .forEach((e) => { const n = e.name; (groups[n] = groups[n] || []).push(e); });
                } catch (e) { finishAdvance(); return false; }
                const names = Object.keys(groups);
                if (!names.length) { finishAdvance(); return false; }
                console.log('%c[问卷] 开始作答 ' + names.length + ' 题（workId=' + (survey.workId || '?') + '）', 'color:#2196F3');
                let answered = 0;
                for (let i = 0; i < names.length; i++) {
                    const els = groups[names[i]];
                    const isText = String(els[0].tagName || '').toLowerCase() === 'textarea';
                    const isMulti = String(els[0].type || '') === 'checkbox';
                    if (els.some((e) => (isText ? String(e.value || '').trim() : e.checked))) { answered++; continue; }
                    if (isText) {
                        try {
                            els[0].value = '课程内容清晰，收获较多';
                            els[0].dispatchEvent(new Event('input', { bubbles: true }));
                            els[0].dispatchEvent(new Event('change', { bubbles: true }));
                            answered++;
                        } catch (e) { }
                        continue;
                    }
                    const opts = els.map((e) => {
                        const label = (e.closest && e.closest('label')) || (e.id && doc.querySelector('label[for="' + e.id + '"]')) || (e.closest && e.closest('li')) || e.parentElement;
                        return { el: e, letter: String(e.value || ''), text: String((label && label.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 60) };
                    });
                    const picked = await new Promise((resolve) => {
                        let done = false;
                        const to = this._schedule(() => { if (!done) { done = true; resolve(null); } }, Math.max(15000, Number(cfg.llmTimeoutMs) || 30000));
                        try {
                            this._llmAskChoice('（课程满意度问卷，没有标准答案，请选最合理、正向的一项；多选选 1-2 项）' + String(survey.title || ''), opts, isMulti, (err, result) => {
                                if (done) return; done = true; try { this._cancelTimer(to); } catch (e) { }
                                resolve(err ? null : result);
                            });
                        } catch (e) { if (!done) { done = true; resolve(null); } }
                    });
                    let chosen = (picked && Array.isArray(picked.picked)) ? picked.picked.slice(0, 2) : [];
                    if (!chosen.length) chosen = [opts[0]];   // 兜底：问卷无标准答案，选第一项，保证"答满可提交"
                    chosen.forEach((o) => {
                        try {
                            o.el.click();
                            if (!o.el.checked) { o.el.checked = true; o.el.dispatchEvent(new Event('change', { bubbles: true })); o.el.dispatchEvent(new Event('input', { bubbles: true })); }
                        } catch (e) { }
                    });
                    if (els.some((e) => e.checked)) answered++;
                    await new Promise((r) => this._schedule(r, 350));
                }
                if (answered < names.length) {
                    console.warn('%c[问卷] 仅作答 ' + answered + '/' + names.length + '，按安全策略**不提交**，跳过该节点', 'color:#FF9800');
                    finishAdvance(); return false;
                }
                if (cfg.surveySubmit === false) { console.log('%c[问卷] 已答满 ' + names.length + ' 题，但 surveySubmit=false → 不提交', 'color:#FF9800'); finishAdvance(); return true; }
                let clicked = false;
                try {
                    const btns = Array.prototype.slice.call(doc.querySelectorAll('a,button,input[type=submit],div[class*=btn],span[class*=btn]'))
                        .filter((e) => /^(提交|交卷|完成)$/.test(String((e.textContent || e.value || '')).replace(/\s+/g, '').trim()));
                    if (btns.length) { btns[0].click(); clicked = true; }
                } catch (e) { }
                console.log('%c[问卷] ' + (clicked ? '已提交（' + names.length + ' 题全部作答）' : '已答满但未找到提交按钮（仅填答）'), clicked ? 'color:#4CAF50' : 'color:#FF9800');
                await new Promise((r) => this._schedule(r, 1200));
                finishAdvance();
                return clicked;
            },
            _isCompleteTaskClass(value) {                // 思路移植自 PR #48 @CsuCook1e（_isCompleteTaskClass）：覆盖 ans-job-finished 这类真实任务点类名。
                const className = String(value || '').toLowerCase();
                return /(ans-)?job-?(finished|finish|done|complete|completed)|finished|complete|completed|done/.test(className)
                    && !/(unfinished|incomplete|uncomplete|doing|todo|wait|waiting)/.test(className);
            },
            _elementHasSingleVideoFrame(el) {
                // 思路移植自 PR #48 @CsuCook1e（_elementHasSingleVideoFrame）：只有「容器里恰好一个视频任务点 iframe」
                // 时，容器上的「已完成」标记才能代表这一个任务点；页面级容器（含多个 iframe）一律不采信。
                if (!el || !el.querySelectorAll) return false;
                try {
                    return el.querySelectorAll('iframe').length <= 1;
                } catch (e) {
                    return false;
                }
            },
            _isVideoTaskFrameComplete(frame) {
                // 思路移植自 PR #48 @CsuCook1e（_isVideoFrameTaskComplete，按本仓库「不确定即视为未完成」的原则收敛）：
                // 只看任务点外观（iframe 自身 / 相邻任务标签 / 单任务点的祖先容器）与 frame 内部明确的任务点完成标记；
                // 文本长度受限，避免把整页文案（例如同页另一个任务点的「任务点已完成」）误当成本任务点已完成。
                if (!frame) return false;
                const checkElement = (el) => {
                    if (!el) return false;
                    if (!this._elementHasSingleVideoFrame(el)) return false;
                    let text = '';
                    try {
                        const ownText = String(el.textContent || '');
                        text = [el.className, el.title, el.getAttribute && el.getAttribute('aria-label')].join(' ')
                            + (ownText.length <= 200 ? ' ' + ownText : '');
                    } catch (e) {
                        text = '';
                    }
                    return this._isCompleteTaskClass(el.className) || this._isCompleteTaskText(text);
                };
                // 兄弟节点只有在「自身不含视频任务点 iframe」时才可能是任务标签（PR #48 的兄弟判定用于标签栏）；
                // 含 iframe 的兄弟属于另一个任务点，不能用来判定当前任务点已完成。
                const checkSibling = (el) => {
                    if (!el || !el.querySelectorAll) return false;
                    try {
                        if (el.querySelectorAll('iframe').length > 0) return false;
                    } catch (e) {
                        return false;
                    }
                    return checkElement(el);
                };
                let current = frame;
                for (let depth = 0; current && depth < 3; depth++) {
                    if (checkElement(current)) return true;
                    if (checkSibling(current.previousElementSibling)) return true;
                    if (checkSibling(current.nextElementSibling)) return true;
                    current = current.parentElement;
                }
                let frameDoc = null;
                try {
                    frameDoc = frame.contentDocument || (frame.contentWindow ? frame.contentWindow.document : null);
                } catch (e) {
                    if (e && e.name === 'SecurityError') return false;
                    return false;
                }
                if (!frameDoc) return false;
                try {
                    const body = frameDoc.body;
                    const bodyText = String((body && (body.innerText || body.textContent)) || '').slice(0, 2000);
                    if (bodyText.length > 0 && bodyText.length <= 200 && this._isCompleteTaskText(bodyText)) return true;
                    const marks = frameDoc.querySelectorAll('[class*="job"], [class*="task"], [class*="complete" i]');
                    for (const mark of marks) {
                        if (this._isCompleteTaskClass(mark.className)) return true;
                        if (mark.textContent && this._isCompleteTaskText(String(mark.textContent).slice(0, 200))) return true;
                    }
                } catch (e) {
                    return false;
                }
                return false;
            },
            _getNextPendingVideoTaskIndex(frames, from) {
                // 思路移植自 PR #48 @CsuCook1e（_getNextPendingVideoTaskIndex）
                const start = Math.max(0, Number(from) || 0);
                for (let i = start; i < frames.length; i++) {
                    if (!this._isVideoTaskFrameComplete(frames[i])) return i;
                }
                return -1;
            },
            _areAllVideoTasksComplete(frames) {
                // 思路移植自 PR #48 @CsuCook1e（_areAllVideoTasksComplete）
                return frames.length > 0 && this._getNextPendingVideoTaskIndex(frames, 0) === -1;
            },
            _getUnitCompletionRatio() {
                // F23（V3.6 补丁）：解析内容帧里的「完成条件」文案，例如
                //   「完成条件 观看时长需 ≥ 总时长的 90% (未完成任务点前, 当前视频不可拖拽)」
                // 返回 0<ratio<=1；解析不到时退回 configs.videoCompleteRatio（默认 0.9）。
                // 只缓存「解析到的」比例（可能比首次监控 tick 晚出现），未解析到时每次回退配置值。
                const fallback = Number(this.configs.videoCompleteRatio) || 0.9;
                if (this._unitCompletionRatio != null) return this._unitCompletionRatio;
                let ratio = null;
                const scan = (doc, depth) => {
                    if (ratio != null || !doc || depth > 4) return;
                    let text = '';
                    try {
                        const body = doc.body;
                        if (body) text = String(body.innerText || body.textContent || '');
                    } catch (e) { text = ''; }
                    if (text && text.indexOf('完成条件') >= 0) {
                        const m = text.match(/完成条件[\s\S]{0,140}?(\d{1,3}(?:\.\d+)?)\s*%/);
                        if (m) {
                            const pct = Number(m[1]);
                            if (pct > 0 && pct <= 100) ratio = pct / 100;
                        }
                    }
                    let frames = [];
                    try { frames = Array.from(doc.querySelectorAll('iframe, frame')); } catch (e) { frames = []; }
                    for (const frame of frames) {
                        if (ratio != null) return;
                        let childDoc = null;
                        try { childDoc = frame.contentDocument; } catch (e) { childDoc = null; }
                        if (childDoc) scan(childDoc, depth + 1);
                    }
                };
                try { scan(typeof document === 'undefined' ? null : document, 0); } catch (e) { /* ignore */ }
                if (ratio != null && ratio > 0 && ratio <= 1) this._unitCompletionRatio = ratio;
                return ratio != null ? ratio : fallback;
            },
            _startLaneKeeper() {
                // F24（V3.6 补丁）：并发车道保活 —— 错开启动同节点多个视频任务点，并周期性拉回被平台暂停的副车道。
                // 说明：keeper 不新增定时器，tick 复用既有视频监控循环（H1 定时器总账约束）；监控停止时保活自动停止。
                if (!this.configs.concurrentPlayback) return;
                this._laneLastKeeperTs = 0;
                console.log('%c[并发] 已启用 ' + (Number(this.configs.concurrentLanes) || 2) + ' 路并发播放（实验特性：副车道被平台暂停时自动重播）', 'color:#8B5CF6');
            },
            _laneKeeperTick() {
                if (!this.configs.concurrentPlayback) return;
                try {
                    const lanes = Math.max(2, Math.min(4, Number(this.configs.concurrentLanes) || 2));
                    const frames = this._getVideoTaskFrames ? this._getVideoTaskFrames() : [];
                    if (!frames || frames.length < 2) return;
                    const targets = [];
                    const start = Math.max(0, Number(this._currentVideoTaskIndex) || 0);
                    for (let i = start; i < frames.length && targets.length < lanes; i++) {
                        if (!this._isVideoTaskFrameComplete(frames[i])) targets.push(i);
                    }
                    if (targets.length < 2) return;
                    const cap = Math.max(1, Number(this.configs.laneMaxReplaysPerUnit) || 240);
                    let played = 0;
                    for (let k = 0; k < targets.length; k++) {
                        const idx = targets[k];
                        const v = this._videoElInFrame ? this._videoElInFrame(frames[idx]) : null;
                        if (!v) continue;
                        try {
                            if (k > 0 && !v.muted) v.muted = true; // 副车道静音，避免多重声音
                            if (v.ended) continue;
                            if (v.readyState === 0) {
                                // 真实页面里任务点视频常是 preload=none：先 load() 一次，同时仍尝试静音 play() 让它尽快起播。
                                const tried = this._laneLoadTried || (this._laneLoadTried = {});
                                if (!tried[idx]) { tried[idx] = true; try { v.load(); } catch (e) { /* ignore */ } }
                            }
                            if (v.paused) {
                                if (this._laneReplays >= cap) {
                                    if (!this._laneCapLogged) {
                                        this._laneCapLogged = true;
                                        console.warn('%c[并发] 副车道重播已达上限（' + cap + ' 次/小节），停止保活（不影响任务点正常流程）', 'color:#FF9800');
                                    }
                                    continue;
                                }
                                this._laneReplays++;
                                const p = v.play();
                                if (p && typeof p.catch === 'function') p.catch(() => {});
                                played++;
                            }
                        } catch (e) { /* 单车道失败不影响其他 */ }
                    }
                    if (played > 0) {
                        const now = Date.now();
                        if (now - (this._laneLastLogTs || 0) > 60000) {
                            this._laneLastLogTs = now;
                            console.log('%c[并发] ' + targets.length + ' 路目标保活中（累计重播 ' + this._laneReplays + ' 次）', 'color:#8B5CF6');
                        }
                    }
                } catch (e) { /* 并发为实验特性：异常绝不外溢 */ }
            },
            _videoSelectors() {
                // F6（#18 #52 #55）：播放器 video 选择器的唯一来源，_getVideoEl 与视频任务点查找共用。
                return [
                    'video#video_html5_api',
                    'video[id*="video_html5"]',
                    'video[id*="videoHtml5"]',
                    'video.vjs-tech',
                    'video[src]',
                    'video',
                ];
            },
            _videoElInFrame(frame) {
                // 思路移植自 PR #48 @CsuCook1e（其 _getVideoEl 内的 findVideo）：在指定任务点 frame 内找 video，
                // 跨域 frame 返回 null 且不打印硬错误。
                if (!frame) return null;
                let frameDoc = null;
                try {
                    frameDoc = frame.contentDocument || (frame.contentWindow ? frame.contentWindow.document : null);
                } catch (e) {
                    if (!(e && e.name === 'SecurityError')) console.warn('视频任务点 frame 访问失败:', e);
                    return null;
                }
                if (!frameDoc) return null;
                for (const selector of this._videoSelectors()) {
                    let candidates = [];
                    try {
                        candidates = Array.from(frameDoc.querySelectorAll(selector));
                    } catch (e) {
                        continue;
                    }
                    for (const candidate of candidates) {
                        if (selector === 'video' && !this._videoHasSource(candidate)) continue;
                        return candidate;
                    }
                }
                return null;
            },
            _getDialogButtonCandidates(dialog) {
                // 思路移植自 PR #48 @CsuCook1e（_getDialogButtonCandidates）
                if (!dialog) return [];
                const elements = [dialog];
                try {
                    for (const el of dialog.querySelectorAll('button, a, span, div')) elements.push(el);
                } catch (e) {
                    return elements;
                }
                return elements;
            },
            _isLikelyVisibleDialog(el) {
                // 思路移植自 PR #48 @CsuCook1e（_isLikelyVisibleDialog，简化为不依赖 z-index 栈的版本）：
                // 限制文本长度避免误判整页容器；有排版信息时要求最小尺寸；无排版环境退化为显式隐藏检查。
                if (!el) return false;
                const text = String(el.textContent || '');
                if (text.length > 800) return false;
                let rect = null;
                try {
                    rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
                } catch (e) {
                    rect = null;
                }
                if (rect && (rect.width || rect.height)) {
                    return rect.width >= 160 && rect.height >= 80;
                }
                return this._isVisible(el);
            },
            _handleTaskPointDialog(reason) {
                // 思路移植自 PR #48 @CsuCook1e（_handleTaskPointDialog）：
                // 平台弹「当前章节还有任务点未完成」时，正确做法是点「去学习 / 去完成」回到未完成任务点，
                // 而不是点「下一节」硬闯（#43 的反复横跳、#54 的风控都是这么来的）。
                // 本仓库额外加了「每小节点击次数上限」，避免在异常页面上无限点。
                const now = Date.now();
                if (now - this._lastTaskPointDialogClickAt < this.configs.taskDialogClickCooldownMs) return false;
                if (this._taskDialogClicksThisUnit >= this.configs.taskDialogMaxClicksPerUnit) {
                    if (!this._taskDialogCapLogged) {
                        this._taskDialogCapLogged = true;
                        console.warn(`%c「任务点未完成」弹窗处理已达上限（${this.configs.taskDialogMaxClicksPerUnit} 次/小节），停止点击以免循环（#43 #54）。`, 'color:#FF9800');
                        console.log('处理方法：请手动完成该小节剩余任务点，然后执行 app.nextUnit() 继续。');
                    }
                    return false;
                }
                const normalize = (value) => String(value || '').replace(/\s+/g, '');
                const dialogSelector = '[role="dialog"], .layui-layer, .wayer, .wayer-dialog, .modal, .dialog, [class*="dialog"], [class*="modal"], [class*="layer"]';
                let dialogs = [];
                try {
                    dialogs = $(dialogSelector).filter((_, el) => {
                        const text = normalize($(el).text());
                        return this._isLikelyVisibleDialog(el) && text.indexOf('当前章节还有任务点未完成') >= 0;
                    }).toArray();
                } catch (e) {
                    dialogs = [];
                    if (!(e && e.name === 'SecurityError')) console.warn('任务点弹窗检测失败:', e);
                }
                if (dialogs.length === 0) return false;
                const dialog = dialogs[dialogs.length - 1];
                const targets = ['去学习', '去完成'];
                const buttons = this._getDialogButtonCandidates(dialog).filter((el) => {
                    const text = normalize(el.textContent);
                    if (!targets.some((target) => text === target || (text.indexOf(target) >= 0 && (!el.children || el.children.length === 0)))) return false;
                    return this._isVisible(el);
                });
                const button = buttons[buttons.length - 1];
                if (!button) return false;
                this._lastTaskPointDialogClickAt = now;
                this._taskDialogClicksThisUnit++;
                console.warn(`%c检测到「当前章节还有任务点未完成」弹窗，点击「${normalize(button.textContent)}」回到未完成任务点（${reason}），第 ${this._taskDialogClicksThisUnit}/${this.configs.taskDialogMaxClicksPerUnit} 次`, 'color:#FF9800');
                button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                return true;
            },
            _currentTaskText() {
                // 思路移植自 PR #48 @CsuCook1e（_getCurrentTaskText）
                if (typeof document === 'undefined') return ''; // t6：页面已关闭时保持可用，不抛异常
                const parts = [document.title, this._currentStepTitle()];
                try {
                    const selectors = '.posCatalog_active .posCatalog_name, .prev_white.active, .prev_white.selected, .prev_white[aria-selected="true"]';
                    for (const el of document.querySelectorAll(selectors)) {
                        parts.push(el.getAttribute('title') || el.textContent || '');
                    }
                } catch (e) {
                    // 忽略：任务文本只用于分类与日志
                }
                return String(parts.join(' ')).replace(/\s+/g, '');
            },
            _hasVideoTaskSignal() {
                // 思路移植自 PR #48 @CsuCook1e（_hasVideoTaskSignal）：视频任务信号强于阅读标签。
                if (this._videoEl) return true;
                if (this._getVideoTaskFrames().length > 0) return true;
                try {
                    if ($('video').length > 0) return true;
                } catch (e) {
                    // 忽略
                }
                return this._currentTaskText().indexOf('视频') >= 0;
            },
            _getTaskKind() {
                // 思路移植自 PR #48 @CsuCook1e（_getTaskKind）：先判定任务类型再决定行为
                // （video / quiz / reading / unknown），顺序上「视频信号」优先于「阅读标签」。
                if (this._hasVideoTaskSignal()) return 'video';
                if (this._isChapterTest()) return 'quiz';
                if (/阅读|教材|文档|图书/.test(this._currentTaskText())) return 'reading';
                return 'unknown';
            },
            _classifyNodeCompletion() {
                // F3（#38 #43）：判定当前节点是否「已完成 / 无任务点」。
                // 证据限制：仓库里没有学习通课程树的 DOM 快照，因此这里只使用「节点自带的完成标记」
                // 这类用户可肉眼核对、缺一个信号就返回 false 的判据；宁可安全停止，也不猜测并乱跳。
                const node = this._currentCatalogNode();
                if (!node) return { completed: false, signals: [], reason: '当前节点未定位' };
                const signals = [];
                const doneTokens = ['completed', 'finished', 'done', 'icon_completed', 'poscatalog_completed', 'poscatalog_finished', 'jobfinished'];
                const badTokens = ['uncompleted', 'incomplete', 'notcompleted', 'undone'];
                const tokens = String(node.className || '').toLowerCase().split(/\s+/).filter(Boolean);
                if (tokens.some((t) => doneTokens.includes(t)) && !tokens.some((t) => badTokens.includes(t))) {
                    signals.push(`节点样式类 ${node.className}`);
                }
                let iconCandidates = [];
                try {
                    iconCandidates = Array.from(node.querySelectorAll('[class*="completed" i], [class*="Complet"], [class*="Finish"], .icon_Completed'));
                } catch (e) {
                    iconCandidates = [];
                }
                for (const icon of iconCandidates) {
                    const cls = String(icon.className || '');
                    if (/uncomplet|incomplet/i.test(cls)) continue;
                    signals.push(`完成图标 ${cls}`);
                    break;
                }
                const nameEl = node.querySelector('.posCatalog_name');
                const title = nameEl ? String(nameEl.getAttribute('title') || nameEl.textContent || '').trim() : '';
                if (/已完成|已学完|已通关/.test(title)) signals.push(`标题标记「${title}」`);
                return { completed: signals.length > 0, signals, reason: signals.length ? '' : '未发现完成/无任务点标记' };
            },
            _currentCatalogNode() {
                // F2：当前可播放节点统一走解析器；解析失败时回退到已跟踪下标。
                const position = this._resolveCatalogPosition('_currentCatalogNode');
                if (position.ok) return position.node;
                return this._catalogNodesOfTrackedChapter();
            },
            _catalogNodesOf(chapterEl) {
                // F2（#14 #15 #24 #27 #37 #49）：同章可播放节点集合的唯一来源。
                // 排除 .firstLayer（收起态父节点），也排除任何仍然包含 .posCatalog_select 的容器节点。
                return $(chapterEl)
                    .find('.posCatalog_select:not(.firstLayer)')
                    .toArray()
                    .filter((node) => !node.querySelector('.posCatalog_select'));
            },
            _catalogNodesOfTrackedChapter() {
                try {
                    const el = this._getTreeContainer();
                    const chapters = el.children('ul').children('li');
                    const chapter = chapters.get(this._cellData.currentCellIndex);
                    if (!chapter) return null;
                    const nodes = this._catalogNodesOf(chapter);
                    return nodes[this._cellData.currentNCellIndex] || null;
                } catch (e) {
                    return null;
                }
            },
            _resolveCatalogPosition(reason, override) {
                // F2（#14 #15 #24 #27 #37 #49）：「当前节点下标」与「同章节点集合」的唯一解析入口。
                // 特性：
                //   * 只把 .posCatalog_select:not(.firstLayer) 当作可播放节点；
                //   * active 落在「节点自身」「父级 li / 收起态 firstLayer / 祖先 ul」时都能定位；
                //   * 解析失败返回 ok=false + reason，调用方必须显式报错，禁止静默跳到下一章。
                const el = this._getTreeContainer();
                const chapters = el.children('ul').children('li').toArray();
                const empty = (why) => ({ ok: false, reason: why, source: '', chapters, chapterIndex: -1, nodes: [], nodeIndex: -1, node: null });
                if (chapters.length === 0) return empty('课程目录里没有任何章节节点');

                // F2（#14 #15 #24 #27 #37）：同章可播放节点只认叶子节点，容器节点（firstLayer /
                // lastLayer 等还包含子节点的高亮父级）不算视频节点，否则下标会整体错位。
                const nodesOf = (chapterEl) => this._catalogNodesOf(chapterEl);

                if (override && Number.isInteger(override.chapterIndex) && chapters[override.chapterIndex]) {
                    const nodes = nodesOf(chapters[override.chapterIndex]);
                    if (nodes.length === 0) return empty(`第 ${override.chapterIndex + 1} 章没有可识别的视频节点`);
                    const idx = Math.min(Math.max(Number(override.nodeIndex) || 0, 0), nodes.length - 1);
                    return { ok: true, reason: '', source: 'tracked', chapters, chapterIndex: override.chapterIndex, nodes, nodeIndex: idx, node: nodes[idx] };
                }

                const topUl = el.children('ul').get(0);
                const chapterIndexOf = (node) => {
                    let cur = node;
                    while (cur && cur.parentElement && cur.parentElement !== topUl) {
                        cur = cur.parentElement;
                    }
                    if (!cur || cur.parentElement !== topUl) return -1;
                    return chapters.indexOf(cur);
                };
                const isLeafNode = (node) => !!(node && node.matches && node.matches('.posCatalog_select:not(.firstLayer)'));

                let activeEls = el.find('.posCatalog_active').toArray();
                if (activeEls.length === 0) {
                    return empty(`目录中不存在 .posCatalog_active 高亮节点（调用点=${reason}）`);
                }
                activeEls = activeEls.slice().sort((a, b) => (isLeafNode(b) ? 1 : 0) - (isLeafNode(a) ? 1 : 0));

                let inferred = null;
                for (const activeEl of activeEls) {
                    const chapterIndex = chapterIndexOf(activeEl);
                    if (chapterIndex < 0) continue;
                    const nodes = nodesOf(chapters[chapterIndex]);
                    if (nodes.length === 0) {
                        if (!inferred) inferred = empty(`active 所在章（第 ${chapterIndex + 1} 章）没有可识别的视频节点`);
                        continue;
                    }
                    if (isLeafNode(activeEl)) {
                        const selfIndex = nodes.indexOf(activeEl);
                        if (selfIndex >= 0) {
                            return { ok: true, reason: '', source: 'active-node', chapters, chapterIndex, nodes, nodeIndex: selfIndex, node: nodes[selfIndex] };
                        }
                    }
                    // active 落在父节点（章节 li / firstLayer / 祖先 ul）上：
                    // 优先取该章内同样带 active 的子节点，否则退到第 1 个可播放节点。
                    const activeChildIndex = nodes.findIndex((n) => n.classList && n.classList.contains('posCatalog_active'));
                    const nodeIndex = activeChildIndex >= 0 ? activeChildIndex : 0;
                    if (!inferred) {
                        inferred = { ok: true, reason: '', source: 'active-parent', chapters, chapterIndex, nodes, nodeIndex, node: nodes[nodeIndex] };
                    }
                    continue;
                }

                if (inferred && inferred.ok) return inferred;
                return inferred || empty(`无法从 ${activeEls.length} 个 active 元素定位到可播放节点（调用点=${reason}）`);
            },
            _advanceLearningStep() {
                if (this._stepSwitchPending && Date.now() - this._stepSwitchAt < 4000) {
                    return true;
                }

                const prevTitle = document.getElementsByClassName('prev_title')[0];
                const currentStepTitle = prevTitle ? (prevTitle.title || prevTitle.textContent || '').trim() : '';

                if (currentStepTitle === '章节测验' || currentStepTitle === '视频') {
                    return false;
                }

                const clickElement = (el, label) => {
                    if (!el) return false;
                    this._stepSwitchPending = true;
                    this._stepSwitchAt = Date.now();
                    console.log(`%c尝试点击${label}`, 'color:#2196F3');
                    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                    return true;
                };
                const videoTab = $('.prev_white:visible').filter((_, el) => {
                    const text = ($(el).text() || '').replace(/\s+/g, '');
                    return text === '2视频' || text === '视频';
                }).get(0);
                if (clickElement(videoTab, '「视频」页签')) {
                    return true;
                }

                return false;
            },
            _currentStepTitle() {
                if (typeof document === 'undefined') return ''; // t6：页面已关闭时保持可用，不抛异常
                const prevTitle = document.getElementsByClassName('prev_title')[0];
                return prevTitle ? (prevTitle.title || prevTitle.textContent || '').trim() : '';
            },
            _isChapterTest() {
                return this._currentStepTitle() === '章节测验';
            },
            _advanceChapterTest() {
                if (this._chapterAdvanceTimes >= 3) {
                    console.error('%c章节测验页面连续跳转失败，已停止以避免页面循环。请手动处理后执行 app.run()。', 'color:#F44336;font-weight:bold');
                    return;
                }

                const nextButton = $('#prevNextFocusNext:visible, #right1:visible, .nextChapter:visible').first().get(0);
                if (!nextButton) {
                    console.warn('%c未找到章节测验的下一步按钮，已停止。', 'color:#FF9800');
                    return;
                }

                this._chapterAdvanceTimes++;
                console.log('%c检测到章节测验，尝试进入下一学习步骤', 'color:#607D8B');
                nextButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                this._schedule(() => this.play(), 2000);
            },
            _bindStepNavigation() {
                if (this._stepNavigationBound) {
                    return;
                }
                this._stepNavigationBound = true;

                const reenterVideoMode = () => {
                    // F6（#52 #55）：从其它学习步骤回到视频页时，播放器会被重建，缓存必须显式失效。
                    this._invalidateVideoCache('步骤切回视频页');
                    this._isPlaying = false;
                    this._stepSwitchPending = true;
                    this._stepSwitchAt = Date.now();
                    this._schedule(() => {
                        try {
                            this._initCellData();
                        } catch (e) {
                            console.warn('重新初始化课程目录失败:', e);
                        }
                        this.play();
                    }, 1800);
                };

                $(document).off('click.xuexitongPlayerV3', '.prev_white').on('click.xuexitongPlayerV3', '.prev_white', (e) => {
                    const text = ($(e.currentTarget).text() || '').replace(/\s+/g, '');
                    if (text.includes('视频')) {
                        console.log(`%c检测到步骤切换点击：${text}，准备重新接管视频页`, 'color:#607D8B');
                        reenterVideoMode();
                    }
                });
            },
            _handlePlayError(error) {
                console.error('播放错误详情:', error);
                const video = this._getVideoEl();
                if (!video) {
                    // F1（#24 #27）：没有视频可回退时也要释放导航锁。
                    this._releaseNavLock('play 错误且无视频元素');
                    return;
                }
                this._lastScriptMutedValue = true; // F4：脚本自身的静音兜底不算用户选择
                video.muted = true;
                const mutedAttempt = video.play();
                if (!mutedAttempt || typeof mutedAttempt.then !== 'function') {
                    this._releaseNavLock('静音播放未被接受');
                    return;
                }
                // PR #56「播放 Promise 超时保护」同样作用于静音兜底：
                // 否则媒体管线冻结时这里既不会成功也不会失败，监控定时器也不会被重启。
                this._withTimeout(mutedAttempt, this.configs.playTimeoutMs, '静音 play() 超时，播放器未进入播放状态').then(() => {
                    console.log('%c静音播放成功', 'color:#4CAF50');
                    this._tryTimes = 0;
                    this._videoRefreshTried = false;
                    this._startVideoMonitoring();
                    this._cancelDelayedNextUnit('静音恢复成功');
                }).catch((e) => {
                    console.error('静音播放也失败:', e);
                    this._cancelDelayedNextUnit('静音恢复失败');
                    this._isPlaying = false;
                    if (this._tryTimes >= this.configs.maxRetries) {
                        console.error('%c静音播放失败，已达到最大重试次数', 'color:#F44336;font-weight:bold', e);
                        // F1（#9 #24 #27 #37）：静音恢复失败同样是退出路径，必须释放导航锁。
                        this._releaseNavLock('静音播放失败触顶');
                        return;
                    }
                    this._tryTimes++;
                    this._delayedNextUnitTimer = this._schedule(() => {
                        this._delayedNextUnitTimer = null;
                        this.play();
                    }, this.configs.retryInterval);
                });
            },
            _resumeAfterManualPause() {
                // F22：GUI「暂停/继续」的恢复路径 —— 暂停期间页面可能已被用户手动改动。
                try {
                    this._invalidateVideoCache('GUI 恢复播放前重新同步');
                } catch (e) { /* ignore */ }
                try {
                    this._initCellData();
                } catch (e) {
                    console.warn('恢复播放前重新解析课程目录失败:', e);
                }
                this._videoRefreshTried = false;
                this.play();
            },
            _invalidateVideoCache(reason) {
                // F6（#52 #55）：显式失效视频元素缓存 —— 切换小节、iframe 重载、播放器换源后
                // 旧节点会脱离文档，继续复用会出现「UI 显示在播放、实际已暂停」以及事件绑定错位。
                if (this._videoEl) {
                    console.log(`%c视频元素缓存已失效（${reason}）`, 'color:#607D8B');
                }
                this._videoEl = null;
                this._detachVideoEvents();
            },
            playCurrentIndex(nCell, override) {
                if (!nCell) {
                    const position = this._resolveCatalogPosition('playCurrentIndex', override || {
                        chapterIndex: this._cellData.currentCellIndex,
                        nodeIndex: this._cellData.currentNCellIndex,
                    });
                    if (!position.ok) {
                        console.error(`%c无法定位要播放的课程节点：${position.reason}`, 'color:#F44336;font-weight:bold');
                        console.log('处理方法：请在左侧目录中手动点击目标小节，或刷新页面后执行 app.run()。');
                        this._releaseNavLock('playCurrentIndex 解析失败');
                        return;
                    }
                    nCell = position.node;
                    this._cellData.currentCellIndex = position.chapterIndex;
                    this._cellData.currentNCellIndex = position.nodeIndex;
                }

                const $nCell = $(nCell);
                const clickableSpan = $nCell.find('.posCatalog_name')[0];
                if (!clickableSpan) {
                    console.error('%c===========找不到可点击的课程节点，播放下一个视频失败==============', 'color:#F44336');
                    // F1（#24 #27）：找不到节点也要释放导航锁，避免死锁。
                    this._releaseNavLock('找不到可点击节点');
                    return;
                }

                console.log(`%c点击切换到: ${$(clickableSpan).attr('title') || '未知标题'}`, 'color:#2196F3');
                // F6（#52 #55）：切换小节时显式失效视频缓存并解绑旧事件。
                this._invalidateVideoCache('切换小节');
                // t6：切小节时取消可能残留的上一段视频的自动跳转定时器（并复位结束去重标志）。
                this._cancelDelayedNextUnit('切换小节');
                this._isPlaying = false;
                this._emptyContentStreak = 0;
                this._videoRefreshTried = false;
                // F66/F68（V3.7）：切到新节点即重置坏片探测记账与人工等待状态
                // （否则「上一节点已跳过该文案」会把新节点的同类失败也一并去重掉）。
                this._videoFailTextHandledKey = null;
                this._videoFailTextScanTs = 0;
                this._faceWaitActive = false;
                this._faceWaitNotified = false;
                this._unitCompletionRatio = null;
                this._laneReplays = 0;
                this._laneCapLogged = false;
                this._laneLoadTried = null;
                this._laneLastKeeperTs = 0;
                this._currentVideoTaskIndex = 0;
                this._llmChapterSuggesting = false;
                this._llmChapterSuggestDone = false;this._llmChapterSuggestDone = false;
                this._llmChapterSuggestDone = false;this._surveyHandledForThisUnit = false;   // 每进一个节点重置：保证每份问卷都会被识别并自动作答
                this._videoTaskCount = 0;
                this._videoTaskAllComplete = false;
                this._handlingVideoEnd = false;
                this._taskDialogClicksThisUnit = 0;
                this._taskDialogCapLogged = false;
                this._seekBackTimesThisUnit = 0;
                this._seekBackCapLogged = false;
                if (this._guardProbeTimer) {
                    this._cancelTimer(this._guardProbeTimer);
                    this._guardProbeTimer = null;
                }
                this._resumeAttemptsThisUnit = 0;
                this._resumeCapLogged = false;
                this._userPaused = false;
                this._guardLastTime = 0;
                this._guardLastWallTs = 0;
                this._guardLastResumeTs = 0;
                $(clickableSpan).click();

                console.log('%c等待视频加载...', 'color:#FF9800');
                this._schedule(() => {
                    this._initCellData();
                    if (this.configs.autoplay) {
                        this.play();
                    }
                }, 3000);
            },
            _initCellData() {
                const el = this._getTreeContainer();
                const cells = el.children('ul').children('li');
                this._cellData.cells = cells.length;
                let nCellCounts = 0;
                cells.each((i, v) => {
                    nCellCounts += this._catalogNodesOf(v).length;
                });
                this._cellData.nCells = nCellCounts;
                // F2（#14 #15 #24 #27 #37 #49）：当前下标解析失败时明确报错并保留上次已知位置，
                // 而不是把 currentCellIndex 当成 0（那正是「一章只播第一个视频」的来源）。
                const position = this._resolveCatalogPosition('_initCellData');
                if (!position.ok) {
                    this._cellData.resolved = false;
                    this._cellData.resolveSource = '';
                    console.error(`%c无法解析当前激活的视频节点：${position.reason}`, 'color:#F44336;font-weight:bold');
                    console.log('处理方法：请在左侧目录中点击目标小节后再执行 app.run()；脚本不会在此情况下自动跳到下一章（#14 #15）。');
                } else {
                    this._cellData.resolved = true;
                    this._cellData.resolveSource = position.source;
                    this._cellData.currentCellIndex = position.chapterIndex;
                    this._cellData.currentNCellIndex = position.nodeIndex;
                    const titleSpan = $(position.node).find('.posCatalog_name')[0];
                    if (titleSpan) {
                        this._cellData.currentVideoTitle = $(titleSpan).attr('title') || $(titleSpan).text() || '';
                    }
                }

                console.log(`%c课程信息: ${this._cellData.cells}章, ${this._cellData.nCells}节, 当前: 第${this._cellData.currentCellIndex + 1}章第${this._cellData.currentNCellIndex + 1}节（解析来源: ${this._cellData.resolveSource || '未解析'}）`, 'color:#607D8B');
                return position;
            },
            _getTreeContainer() {
                if (!this._treeContainerEl || (this._treeContainerEl.length && !this._treeContainerEl.get(0).isConnected)) {
                    // F2/F6：目录被页面重绘后，旧容器会脱离文档，必须重新查询，否则下标解析全部错位。
                    const el = $('#coursetree');
                    if (el.length <= 0) {
                        throw new Error('找不到视频列表');
                    }
                    this._treeContainerEl = el;
                }
                return this._treeContainerEl;
            },
            _videoHasSource(video) {
                if (!video) return false;
                if (video.getAttribute && video.getAttribute('src')) return true;
                if (video.currentSrc) return true;
                return !!(video.querySelector && video.querySelector('source[src]'));
            },
            _isLiveVideoElement(el) {
                // F22（真机：GUI 暂停后手动切节点再点「继续」→ play() 反复超时）：
                // iframe 被重建/移除后，旧文档里的 video 会处于「isConnected 仍为 true，
                // 但 ownerDocument.defaultView === null（文档已脱离浏览上下文）」的僵尸状态；
                // 对这种元素调用 play() 既不 resolve 也不 reject，只会白白耗尽重试次数。
                if (!el) return false;
                try {
                    if (el.isConnected === false) return false;
                    const doc = el.ownerDocument;
                    if (!doc) return false;
                    const win = doc.defaultView;
                    if (win === null) return false;   // 僵尸文档：iframe 已移除/替换
                    if (!win) return true;            // 测试桩环境（无 window）：不做过度判定
                    let cursor = win;
                    let guard = 0;
                    // 若环境支持 frameElement，则沿 iframe 链向上确认容器仍挂在活动树上。
                    while (cursor && cursor !== window && guard++ < 8) {
                        const frameEl = cursor.frameElement;
                        if (frameEl === undefined) return true; // 环境不支持：放弃二级判定
                        if (!frameEl || frameEl.isConnected === false) return false;
                        cursor = frameEl.ownerDocument && frameEl.ownerDocument.defaultView;
                    }
                    return true;
                } catch (e) {
                    return false;
                }
            },
            _getVideoEl() {
                // F6（#18 #52 #55）：扩大选择器覆盖 + 提高嵌套 frame 搜索深度（带上限）+ 缓存失效。
                // F22：改用「活动浏览上下文」判定，覆盖 isConnected 仍为 true 的僵尸文档（真机复现：手动切节点后）。
                if (this._videoEl && !this._isLiveVideoElement(this._videoEl)) {
                    this._invalidateVideoCache('缓存的视频节点已脱离文档（iframe 重载/手动切节点，僵尸文档）');
                }
                if (!this._videoEl) {
                    try {
                        const directSelectors = this._videoSelectors();
                        // 思路移植自 PR #48 @CsuCook1e：同一小节里可能有多个「视频任务点」iframe，
                        // 先按任务顺序挑第一个「未完成且已加载出 video」的任务点；全部完成才交给无视频分支前进。
                        const taskFrames = this._getVideoTaskFrames();
                        this._videoTaskCount = taskFrames.length;
                        if (taskFrames.length > 0) {
                            const pendingIndex = this._getNextPendingVideoTaskIndex(taskFrames, this._currentVideoTaskIndex);
                            if (pendingIndex < 0) {
                                this._currentVideoTaskIndex = taskFrames.length;
                                this._videoTaskAllComplete = true;
                                console.log(`%c小节内 ${taskFrames.length} 个视频任务点均已完成，准备切换下一小节`, 'color:#4CAF50');
                                return null;
                            }
                            if (pendingIndex !== this._currentVideoTaskIndex) {
                                console.log(`%c跳过已完成的视频任务点，切换到第 ${pendingIndex + 1}/${taskFrames.length} 个`, 'color:#FF9800');
                                this._currentVideoTaskIndex = pendingIndex;
                            }
                            for (let i = pendingIndex; i < taskFrames.length; i++) {
                                const taskVideo = this._videoElInFrame(taskFrames[i]);
                                if (taskVideo) {
                                    this._currentVideoTaskIndex = i;
                                    this._videoEl = taskVideo;
                                    return taskVideo;
                                }
                            }
                        }
                        const findVideo = (rootDoc, depth) => {
                            if (!rootDoc) return null;
                            // 深度上限保护：避免在异常/自引用 frame 结构里无限递归。
                            if (depth > this.configs.videoFrameMaxDepth) return null;
                            for (const selector of directSelectors) {
                                let candidates = [];
                                try {
                                    candidates = Array.from(rootDoc.querySelectorAll(selector));
                                } catch (e) {
                                    continue;
                                }
                                for (const candidate of candidates) {
                                    // 兜底选择器只接受真正挂了媒体源的 video，避免抓到装饰性空标签。
                                    if (selector === 'video' && !this._videoHasSource(candidate)) continue;
                                    return candidate;
                                }
                            }
                            let frames = [];
                            try {
                                frames = Array.from(rootDoc.querySelectorAll('iframe.ans-insertvideo-online, iframe[src*="video"], iframe, frame'));
                            } catch (e) {
                                frames = [];
                            }
                            for (const nestedFrame of frames) {
                                let nestedDoc = null;
                                try {
                                    nestedDoc = nestedFrame.contentDocument || (nestedFrame.contentWindow ? nestedFrame.contentWindow.document : null);
                                } catch (e) {
                                    nestedDoc = null;
                                }
                                if (!nestedDoc) continue;
                                const nested = findVideo(nestedDoc, depth + 1);
                                if (nested) return nested;
                            }
                            return null;
                        };
                        // V3.3 只扫描 iframe（深度 2）；这里先扫主文档，再逐层进入 frame（默认深度 4）。
                        const video = findVideo(document, 0);
                        if (video) {
                            this._videoEl = video;
                        }
                    } catch (e) {
                        console.error('获取视频元素失败:', e);
                        return null;
                    }
                }
                if (!this._videoEl) return null;
                return this._videoEl;
            },
            // F15（V3.6）：给 video.pause 加「用户意图」白名单，拦截平台防挂机暂停。
            // 实测：平台在 window 上监听鼠标移出（mouseout）并调用播放器 pause()，鼠标进出页面即暂停视频。
            // 原则：不劫持任何鼠标事件（F4 教训），只拦截「最近无点击/按键」的暂停调用，保留用户主动暂停。
            _installPauseGuard(el) {
                if (!this.configs.pauseGuard) return;
                if (!el || el.__xtPauseGuard) return;
                el.__xtPauseGuard = true;
                const self = this;
                const origPause = el.pause.bind(el);
                el.pause = function () {
                    try {
                        const recentUser = Date.now() - (self._lastUserInteractionTs || 0) < 1500;
                        if (self._isPlaying && !self._userPaused && !recentUser) {
                            self._pauseGuardBlocked++;
                            if (self._pauseGuardBlocked <= 3) {
                                console.log('%c[防挂机] 已拦截平台防挂机暂停（鼠标移出页面触发，第 ' + self._pauseGuardBlocked + ' 次）', 'color:#4CAF50');
                            }
                            return;
                        }
                    } catch (e) { /* 异常时放行 */ }
                    return origPause();
                };
            },
            _videoEventHandle() {
                const el = this._videoEl;
                if (!el) {
                    console.log('videoEl未加载');
                    return;
                }

                if (this._eventVideoEl === el) return;
                this._detachVideoEvents();
                this._eventVideoEl = el;
                this._boundVideoHandlers = {
                    ended: this._handleVideoEnded.bind(this),
                    loadedmetadata: this._handleVideoLoaded.bind(this),
                    play: this._handleVideoPlay.bind(this),
                    pause: this._handleVideoPause.bind(this),
                };

                this._installPauseGuard(el);
                el.addEventListener('ended', this._boundVideoHandlers.ended);
                el.addEventListener('loadedmetadata', this._boundVideoHandlers.loadedmetadata);
                el.addEventListener('play', this._boundVideoHandlers.play);
                el.addEventListener('pause', this._boundVideoHandlers.pause);
                // F4（#26 #32 #55）：只在播放器文档内被动观察用户交互（不 preventDefault/stopPropagation），
                // 用来区分「用户主动暂停」与「页面异常暂停」。
                this._bindUserInteractionWatch(el.ownerDocument);
                this._bindUserMuteTracking(el);
            },
            _bindUserInteractionWatch(frameDoc) {
                if (!frameDoc || this._userInteractionDoc === frameDoc) return;
                this._unbindUserInteractionWatch();
                const handler = () => {
                    this._lastUserInteractionTs = Date.now();
                };
                frameDoc.addEventListener('pointerdown', handler, true);
                frameDoc.addEventListener('click', handler, true);
                frameDoc.addEventListener('keydown', handler, true);
                this._userInteractionDoc = frameDoc;
                this._userInteractionHandler = handler;
            },
            _unbindUserInteractionWatch() {
                if (!this._userInteractionDoc || !this._userInteractionHandler) return;
                this._userInteractionDoc.removeEventListener('pointerdown', this._userInteractionHandler, true);
                this._userInteractionDoc.removeEventListener('click', this._userInteractionHandler, true);
                this._userInteractionDoc.removeEventListener('keydown', this._userInteractionHandler, true);
                this._userInteractionDoc = null;
                this._userInteractionHandler = null;
            },
            _detachVideoEvents() {
                if (this._eventVideoEl && this._boundVideoHandlers) {
                    this._eventVideoEl.removeEventListener('ended', this._boundVideoHandlers.ended);
                    this._eventVideoEl.removeEventListener('loadedmetadata', this._boundVideoHandlers.loadedmetadata);
                    this._eventVideoEl.removeEventListener('play', this._boundVideoHandlers.play);
                    this._eventVideoEl.removeEventListener('pause', this._boundVideoHandlers.pause);
                }
                this._eventVideoEl = null;
                this._boundVideoHandlers = null;
                this._unbindUserInteractionWatch();
                this._unbindUserMuteTracking();
            },
            _handleVideoEnded(e) {
                const title = this._cellData.currentVideoTitle;
                console.warn(`%c============'${title}' 播放完成=============`, 'color:#4CAF50;font-weight:bold');
                if (this._handlingVideoEnd) return;
                this._handlingVideoEnd = true;
                this._isPlaying = false;
                this._clearCheckInterval();

                // 思路移植自 PR #48 @CsuCook1e（_handleVideoTaskEnded）：
                // 小节内还有未完成的视频任务点时，先切到该任务点继续播，而不是直接切下一小节（#24 #37）。
                try {
                    const frames = this._getVideoTaskFrames();
                    this._videoTaskCount = frames.length;
                    const pendingIndex = this._getNextPendingVideoTaskIndex(frames, this._currentVideoTaskIndex + 1);
                    if (pendingIndex >= 0) {
                        this._currentVideoTaskIndex = pendingIndex;
                        this._invalidateVideoCache(`切换到第 ${pendingIndex + 1}/${frames.length} 个视频任务点`);
                        console.log(`%c同一小节还有未完成的视频任务点，切换到第 ${pendingIndex + 1}/${frames.length} 个`, 'color:#FF9800');
                        this._schedule(() => {
                            this._handlingVideoEnd = false;
                            this.play();
                        }, 800);
                        return;
                    }
                } catch (error) {
                    console.warn('检查小节内视频任务点失败:', error);
                }

                // t6：登记到统一定时器账本，使四处入口的取消对它生效（原先这里未登记，取消形同虚设）。
                this._delayedNextUnitTimer = this._schedule(() => {
                    this._delayedNextUnitTimer = null;
                    this._handlingVideoEnd = false;
                    this.nextUnit();
                }, 1000);
            },
            _handleVideoLoaded(e) {
                console.log('%c============视频加载完成=============', 'color:#2196F3');
                // t6：新视频已加载完成，取消可能残留的「上一段视频结束」自动跳转，避免跳过当前小节。
                this._cancelDelayedNextUnit('视频加载完成');
                if (this.configs.autoplay && !this._isPlaying) {
                    this.play();
                }
            },
            _handleVideoPlay(e) {
                const title = this._cellData.currentVideoTitle;
                console.info(`%c============'${title}' 开始播放=============`, 'color:#4CAF50');
                this._isPlaying = true;
                this._stepSwitchPending = false;
                // F4（#32 #55）：重新开始播放即视为暂停问题已解决，清掉用户暂停标记。
                this._userPaused = false;
                this._guardLastTime = Number((this._getVideoEl() || {}).currentTime || 0);
                this._guardLastWallTs = Date.now();
                this._cancelDelayedNextUnit('视频重新开始播放');
            },
            _handleVideoPause(e) {
                const now = Date.now();
                const sinceInteraction = this._lastUserInteractionTs ? now - this._lastUserInteractionTs : Infinity;
                // F4（#26 #32 #54 #55）：只有「用户刚在播放器里操作过」才认定为用户主动暂停。
                // 判定后脚本停止抢播，避免无差别 play() 造成的风控/验证码（#54）与假播放状态（#55）。
                if (sinceInteraction <= this.configs.userPauseWindowMs) {
                    this._userPaused = true;
                    console.warn('%c检测到用户主动暂停：脚本不再自动恢复播放（#26 #32 #55）。', 'color:#FF9800');
                    console.log('处理方法：需要恢复自动保活时，请点击播放按钮或执行 app.resumeAutoPlay()。');
                    return;
                }
                console.log('%c视频暂停（非用户操作），等待进度停滞判定后再按有界策略恢复...', 'color:#FF9800');
            },
            _isVisible(el) {
                // F5（#29 #39 #42）：仅用于「暂停自动跳转」这类安全动作，不用于点击，因此宁可宽松。
                if (!el) return false;
                if (el.hidden) return false;
                let node = el;
                for (let i = 0; node && i < 6; i++, node = node.parentElement) {
                    const style = node.style;
                    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
                    if (node.hasAttribute && node.hasAttribute('hidden')) return false;
                }
                const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
                if (rect && (rect.width > 0 || rect.height > 0)) return true;
                // 无布局环境（隐藏标签页、jsdom）rect 恒为 0：只要没有被显式隐藏就按可见处理，避免漏检。
                return true;
            },
            _findInteractionDialog(rootDoc, depth) {
                // F5（#29 #39 #42）：选择器与「弹窗识别」思路借用自 PR #53 @wangzheng-1；
                // 按队长裁决**只做检测**——不复制其选项点选/提交逻辑，也不实现任何自动作答。
                // #42 反馈指出题目容器 class 为 Zy_TItle、题目文本为 newStyle，这里一并覆盖。
                if (!rootDoc || depth > this.configs.videoFrameMaxDepth) return null;
                const selector = [
                    '.answerQuestion',
                    '.videoInteraction',
                    '.interaction',
                    '.ans-video-question',
                    '.Zy_TItle',
                    '[class*="answerQuestion"]',
                    '[class*="videoInteraction"]',
                    // F51（真机抓取）：学习通"视频内嵌题目"的真实结构 —— 此前一个都没覆盖，
                    // 导致题目挡住的暂停被当成"非用户操作暂停"，脚本停在原地干等。
                    '.ans-videoquiz',
                    '.ans-timelineobjects',
                    '[class*="ans-videoquiz"]',
                    '.ans-videoquiz-opt',
                    '#videoquiz-submit',
                ].join(', ');
                let candidates = [];
                try {
                    candidates = Array.from(rootDoc.querySelectorAll(selector));
                } catch (e) {
                    candidates = [];
                }
                // F51：promptRe 增加"共 N 题，已答对 M 题"这一内嵌题目专有文案（真机原文）
                const promptRe = /(请选择|请回答|请作答|选择你认为|判断题|单选题|多选题|请你判断|已答对|共\s*\d+\s*题)/;
                for (const candidate of candidates) {
                    if (!this._isVisible(candidate)) continue;
                    let scope = candidate;
                    for (let level = 0; level < 3 && scope; level++) {
                        const text = String(scope.textContent || '').replace(/\s+/g, ' ').trim();
                        if (text.length >= 6 && text.length <= 3000 && promptRe.test(text)) {
                            const options = scope.querySelectorAll('li, label, input[type=radio], input[type=checkbox]');
                            if (options.length > 0) {
                                return {
                                    el: scope,
                                    text: text.slice(0, 120),
                                    questionText: text.slice(0, 500),
                                    optionCount: options.length,
                                    // F10（V3.5）：额外返回可识别的选项元素/文本供 LLM 选择；识别不出时为空数组并回退人工。
                                    options: this._extractInteractionOptions(options),
                                };
                            }
                        }
                        scope = scope.parentElement;
                    }
                }
                let frames = [];
                try {
                    frames = Array.from(rootDoc.querySelectorAll('iframe, frame'));
                } catch (e) {
                    frames = [];
                }
                for (const frame of frames) {
                    let frameDoc = null;
                    let frameSrc = '';
                    let frameJobid = '';
                    try {
                        frameDoc = frame.contentDocument || (frame.contentWindow ? frame.contentWindow.document : null);
                        frameSrc = String(frame.getAttribute('src') || '');
                        frameJobid = String(frame.getAttribute('jobid') || '');
                    } catch (e) {
                        frameDoc = null;
                    }
                    if (!frameDoc) continue;
                    // F43：作业页的题目绝不能被当成「视频互动弹窗」——真机：作业题被弹窗流程抢答后卡死。
                    if (/\/modules\/work\/|doHomeWorkNew/.test(frameSrc) || frameJobid.indexOf('work-') === 0) continue;
                    const nested = this._findInteractionDialog(frameDoc, depth + 1);
                    if (nested) return nested;
                }
                return null;
            },
            _checkInteractionDialog() {
                if (!this.configs.interactionGuard) return null;
                // F43：内嵌作业作答进行中，作业流程自己会处理题目；避免互动监视器抢答。
                if (this._workBusy) return null;
                // 章节测验页自身就有题目容器：那里沿用原有的「受限跳转」逻辑，不做互动弹窗判定，
                // 避免把正常章节测验误判成视频互动弹窗。
                if (this._isChapterTest()) return null;
                const found = this._findInteractionDialog(document, 0);
                if (found) {
                    // F10（V3.5）：仅当显式开启 LLM 且配置齐全时尝试自动选择；失败一律回退「暂停等人工」。
                    if (!this._interactionBlocked && this._canLlmAnswer(found)) {
                        this._answerInteractionWithLlm(found);
                    } else if (!this._interactionBlocked && this._llmInFlight) {
                        // F37：当前有 LLM 请求在途（例如内嵌作业正在逐题作答）→ 等待其完成后自动作答，绝不降级人工。
                        if (!this._interactionWaitLogged) {
                            this._interactionWaitLogged = true;
                            console.log('%c[LLM] 检测到互动题，等待当前请求完成后自动作答…', 'color:#607D8B');
                        }
                    } else if (!this._interactionBlocked) {
                        this._blockInteractionForManual(found);
                    }
                } else if (this._interactionBlocked) {
                    this._interactionBlocked = false;
                    this._interactionWaitLogged = false;
                    console.log('%c互动答题弹窗已消失，恢复自动播放与跳转。', 'color:#4CAF50');
                    this.play();
                }
                return found;
            },
            _blockInteractionForManual(found) {
                this._interactionBlocked = true;
                // 暂停自动跳转：清掉待执行的跳转定时器并停止视频监控，避免在弹窗上反复点击导致卡死。
                this._clearTimers();
                this._clearCheckInterval();
                console.warn(`%c检测到视频互动答题弹窗（判断题/选择题），已暂停自动跳转（#29 #39）：${found.text}`, 'color:#FF9800');
                console.log('处理方法：请手动完成该互动题。按设计脚本不会自动答题（#45 相关需求不实现），'
                    + '也不会绕过任何考核；答题并关闭弹窗后，脚本会自动恢复自动播放与跳转。');
                console.log('提示：如需调用大模型自动选择答案，可在控制台执行 app.configs.llmEnabled = true，'
                    + '并用 app.setLlmKey(...) 配置密钥（详见 README「GUI 面板与 LLM 应答」）。');
            },
            // ================= F68（V3.7）：人脸识别的检测与等待 =================
            // 上游依据：_ocsjs_upstream/packages/scripts/src/projects/cx.ts:2221-2246（两个判定函数）、
            // 2250-2300（每 3 秒轮询、notified 标志只提示一次、无超时地等待人工）、
            // 1757-1758（在每次保活播放前先检测并等待人脸识别）。
            // 本地不另起一套状态机，而是复用既有「暂停等人工 → 自动恢复」家族：
            //   * 暂停自动推进 = 清掉待执行跳转 + 停止视频监控（与 _blockInteractionForManual 同一手法）；
            //   * 自动恢复 = 既有互动轮询链检测到人脸消失后调既有 play()。
            // 为什么另设 _faceWaitActive 而不复用 _interactionBlocked：_interactionBlocked 的清除分支与
            // 「互动弹窗是否还在」强绑定，人脸流程若复用它，会在人脸仍在时被那条分支判成「弹窗消失」而调
            // play() 抢播。因此用同族独立标志，清除条件只有「人脸元素消失」这一个。
            _hasFaceRecognition() {
                // 上游语义原样照搬： #fcqrimg 的 src 非空才算激活（src 为空串表示人脸不会出现）；
                // .chapterVideoFaceMaskDiv 的 style.display 不为 none 才算激活（未显式隐藏即视为激活）。
                // 差异：上游只扫顶层文档，本地按 videoFrameMaxDepth 递归到内容帧（本地视频多在内嵌帧里）。
                const scan = (doc, depth) => {
                    if (!doc || depth > this.configs.videoFrameMaxDepth) return false;
                    try {
                        const imgs = Array.from(doc.querySelectorAll('#fcqrimg'));
                        for (const img of imgs) {
                            const src = img && img.getAttribute ? img.getAttribute('src') : null;
                            if (src && String(src).length > 0) return true;
                        }
                    } catch (e) { /* ignore */ }
                    try {
                        const masks = Array.from(doc.querySelectorAll('.chapterVideoFaceMaskDiv'));
                        for (const mask of masks) {
                            const display = mask && mask.style ? String(mask.style.display || '') : '';
                            if (display !== 'none') return true;
                        }
                    } catch (e) { /* ignore */ }
                    let frames = [];
                    try { frames = Array.from(doc.querySelectorAll('iframe, frame')); } catch (e) { frames = []; }
                    for (const frame of frames) {
                        let child = null;
                        try { child = frame.contentDocument; } catch (e) { child = null; }
                        if (child && scan(child, depth + 1)) return true;
                    }
                    return false;
                };
                try {
                    return scan(typeof document === 'undefined' ? null : document, 0);
                } catch (e) {
                    return false;
                }
            },
            _waitForFaceRecognition() {
                // 命中后暂停自动推进：清待执行跳转 + 停视频监控，避免人脸期间反复抢播耗尽保活预算。
                this._faceWaitActive = true;
                this._clearTimers();
                this._clearCheckInterval();
                if (!this._faceWaitNotified) {
                    this._faceWaitNotified = true;   // 上游 notified：只提示一次，避免轮询刷屏
                    console.warn('%c[人脸识别] 检测到人脸识别，请手动完成识别后脚本会自动继续', 'color:#FF9800');
                    console.log('说明：识别期间脚本不会抢播、也不会跳过该任务点；识别完成后视频会自动恢复播放。');
                }
            },
            _maybeResumeAfterFaceRecognition() {
                // 人脸消失 → 自动恢复（调用既有 play()，由它重建视频监控与保活）。
                if (!this._faceWaitActive) return false;
                if (this.configs.interactionFaceWait === false) {
                    this._faceWaitActive = false;
                    this._faceWaitNotified = false;
                    return false;
                }
                if (this._hasFaceRecognition()) return false;    // 仍在识别中：继续等（上游同样无超时）
                this._faceWaitActive = false;
                this._faceWaitNotified = false;                  // 下次人脸再出现时重新提示一次
                console.log('%c[人脸识别] 人脸识别已完成，恢复自动播放', 'color:#4CAF50');
                this.play();
                return true;
            },
            _startInteractionWatcher() {
                // F5（#29 #39）：只检测、只暂停；全脚本没有任何自动答题/外部模型调用。
                if (!this.configs.interactionGuard) return;
                if (this._interactionWatcher) return;
                this._interactionWatcher = setInterval(() => {
                    try {
                        // F66（V3.7）：坏片探测的兜底入口 —— 视频监控链只在 play()（或静音兜底）成功后才启动，
                        // 「一直播放失败」的永久坏片场景它压根不会跑；互动轮询是 run() 时建立、destroy() 时清理的
                        // 常驻既有循环，用它兜底既能覆盖该场景，又不新增任何定时器。
                        if (this._maybeSkipOnVideoFailText()) return;
                        // F68（V3.7）：人脸识别消失检测 —— 复用这条 run() 时建立、destroy() 时清理的既有轮询，
                        // 不新建任何定时器（上游是每 3 秒轮询；本地互动轮询默认 1.5 秒，粒度更细）。
                        if (this._maybeResumeAfterFaceRecognition()) return;
                        this._checkInteractionDialog();
                        this._guiRefreshStatus(false);
                        if (!this._interactionBlocked) {
                            // 思路移植自 PR #48 @CsuCook1e：平台弹「当前章节还有任务点未完成」时，
                            // 点「去学习/去完成」回到未完成任务点（受冷却与次数上限约束），不点「下一节」硬闯。
                            this._handleTaskPointDialog('monitor');
                        }
                        // F67（V3.7）：章节未完成数的第二数据源交叉校验 —— 挂在常驻轮询上才能覆盖所有节点
                        //（正常播放的视频节点不走 _countUnfinishedTaskPoints，只挂那里会有覆盖盲区）。
                        // 本地统计传 null：本节只做章节级校验，避免拿不到图标级统计时产生无意义的节点级告警；
                        // 日志在 _crossCheckChapterCount 内部按数值去重，因此不会每 1.5 秒刷屏。
                        this._crossCheckChapterCount(null, null);
                    } catch (e) {
                        console.error('互动弹窗检测失败:', e);
                    }
                }, this.configs.interactionPollMs);
            },
            _stopInteractionWatcher() {
                if (this._interactionWatcher) {
                    clearInterval(this._interactionWatcher);
                    this._interactionWatcher = null;
                }
            },
            // ================= F9（V3.5）：GUI 可视化面板（纯本地 DOM，默认开启，零网络） =================
            _guiInit() {
                if (!this.configs.guiEnabled) return;
                if (typeof document === 'undefined' || !document.body) return;
                this._guiDestroy();
                const panel = document.createElement('div');
                panel.id = 'xt-gui-panel';
                panel.style.cssText = 'position:fixed;top:12px;right:12px;width:340px;z-index:2147483000;'
                    + 'background:linear-gradient(180deg,rgba(15,23,42,.97),rgba(15,23,42,.93));color:#e2e8f0;'
                    + 'font:12px/1.6 "Microsoft YaHei",system-ui,-apple-system,sans-serif;'
                    + 'border:1px solid rgba(148,163,184,.28);border-radius:14px;overflow:hidden;'
                    + 'box-shadow:0 12px 32px rgba(2,6,23,.5);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);'
                    + 'opacity:0;transform:translateY(-8px);transition:opacity .25s ease,transform .25s ease;';
                const styleEl = document.createElement('style');
                styleEl.textContent = '@keyframes xtPulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.45)}70%{box-shadow:0 0 0 6px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}'
                    + '#xt-gui-panel button{transition:background .15s ease,transform .08s ease,border-color .15s ease;}'
                    + '#xt-gui-panel button:hover{background:#334155 !important;border-color:rgba(148,163,184,.45) !important;}'
                    + '#xt-gui-panel button:active{transform:scale(.97);}'
                    + '#xt-gui-panel pre::-webkit-scrollbar{width:6px;}'
                    + '#xt-gui-panel pre::-webkit-scrollbar-thumb{background:rgba(148,163,184,.35);border-radius:3px;}';
                panel.appendChild(styleEl);
                const header = document.createElement('div');
                header.style.cssText = 'display:flex;align-items:center;gap:8px;padding:9px 12px;'
                    + 'background:rgba(30,41,59,.85);border-bottom:1px solid rgba(148,163,184,.18);';
                const dot = document.createElement('span');
                dot.title = '运行状态指示灯';
                dot.style.cssText = 'width:9px;height:9px;border-radius:50%;background:#64748b;flex:0 0 auto;'
                    + 'transition:background .3s ease;animation:xtPulse 2s infinite;';
                const title = document.createElement('span');
                title.textContent = '学习通脚本监控 ' + this.version;
                title.style.cssText = 'font-weight:600;color:#93c5fd;flex:1 1 auto;white-space:nowrap;';
                const collapseBtn = document.createElement('button');
                collapseBtn.type = 'button';
                collapseBtn.textContent = '收起';
                collapseBtn.title = '折叠 / 展开面板';
                collapseBtn.style.cssText = 'background:#1f2937;color:#cbd5e1;border:1px solid rgba(148,163,184,.2);'
                    + 'border-radius:8px;padding:3px 10px;font-size:11px;cursor:pointer;';
                header.appendChild(dot);
                header.appendChild(title);
                header.appendChild(collapseBtn);
                const bodyWrap = document.createElement('div');
                bodyWrap.style.cssText = 'padding:10px 12px 12px;';
                const progRow = document.createElement('div');
                progRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;color:#94a3b8;font-size:11px;';
                const progLabel = document.createElement('span');
                progLabel.textContent = '视频进度';
                const progText = document.createElement('span');
                progText.textContent = '等待视频…';
                progText.style.cssText = 'color:#cbd5e1;font-variant-numeric:tabular-nums;';
                progRow.appendChild(progLabel);
                progRow.appendChild(progText);
                const progTrack = document.createElement('div');
                progTrack.style.cssText = 'height:8px;border-radius:5px;background:#1e293b;overflow:hidden;margin-bottom:10px;';
                const progFill = document.createElement('div');
                progFill.style.cssText = 'height:100%;width:0%;border-radius:5px;background:linear-gradient(90deg,#22c55e,#4ade80);transition:width .35s ease;';
                progTrack.appendChild(progFill);
                const statusEl = document.createElement('div');
                statusEl.style.cssText = 'white-space:pre-wrap;color:#cbd5e1;font-size:11.5px;line-height:1.7;margin-bottom:8px;';
                const logEl = document.createElement('pre');
                logEl.style.cssText = 'margin:0 0 10px;padding:8px 9px;max-height:150px;overflow:auto;background:#0b1220;'
                    + 'border:1px solid rgba(148,163,184,.12);border-radius:9px;color:#94a3b8;font:10.5px/1.5 Consolas,Menlo,monospace;'
                    + 'white-space:pre-wrap;word-break:break-all;';
                const btnRow = document.createElement('div');
                btnRow.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px;';
                const addBtn = (label, help, handler, key) => {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.textContent = label;
                    b.title = help;
                    b.style.cssText = 'background:#1f2937;color:#e2e8f0;border:1px solid rgba(148,163,184,.2);border-radius:9px;'
                        + 'padding:7px 8px;font-size:12px;cursor:pointer;user-select:none;white-space:nowrap;';
                    b.addEventListener('click', () => {
                        try { handler(); } catch (err) { console.error('GUI 按钮处理失败:', err); }
                    });
                    btnRow.appendChild(b);
                    if (key) {
                        if (!this._guiBtns) this._guiBtns = {};
                        this._guiBtns[key] = b;
                    }
                    return b;
                };
                addBtn('暂停播放', '暂停或恢复自动播放（恢复前会自动重新同步）', () => {
                    if (this._isPlaying) {
                        this._clearCheckInterval();
                        this._isPlaying = false;
                        console.log('%c[GUI] 已暂停自动播放（点「暂停/继续」恢复）', 'color:#FF9800');
                    } else {
                        console.log('%c[GUI] 恢复自动播放', 'color:#4CAF50');
                        // F22：暂停期间用户可能手动切过节点、平台重建过 iframe → 先重新同步再恢复。
                        this._resumeAfterManualPause();
                    }
                    this._guiRefreshStatus(true);
                }, 'pause');
                addBtn('下一节', '立即切换到下一小节', () => this.nextUnit(), 'next');
                addBtn('LLM 已关', '切换 llmEnabled（默认关闭）', () => {
                    this.configs.llmEnabled = !this.configs.llmEnabled;
                    console.log('%c[GUI] LLM 应答已' + (this.configs.llmEnabled ? '开启' : '关闭'), 'color:#2196F3');
                    this._guiRefreshStatus(true);
                }, 'llm');
                addBtn('自动提交关', '切换 llmAutoSubmit（默认关闭：先选答案再人工提交）', () => {
                    this.configs.llmAutoSubmit = !this.configs.llmAutoSubmit;
                    console.log('%c[GUI] LLM 自动提交已' + (this.configs.llmAutoSubmit ? '开启' : '关闭'), 'color:#2196F3');
                    this._guiRefreshStatus(true);
                }, 'submit');
                addBtn('设置 Key', '设置 LLM API Key（只保存在当前页面内存）', () => this._guiAskKey(), 'key');
                addBtn('清空日志', '清空面板日志', () => { this._guiLogs = []; if (logEl) logEl.textContent = ''; }, 'clear');
                bodyWrap.appendChild(progRow);
                bodyWrap.appendChild(progTrack);
                bodyWrap.appendChild(statusEl);
                bodyWrap.appendChild(logEl);
                bodyWrap.appendChild(btnRow);
                panel.appendChild(header);
                panel.appendChild(bodyWrap);
                const onCollapse = () => {
                    this._guiCollapsed = !this._guiCollapsed;
                    bodyWrap.style.display = this._guiCollapsed ? 'none' : 'block';
                    collapseBtn.textContent = this._guiCollapsed ? '展开' : '收起';
                };
                collapseBtn.addEventListener('click', () => onCollapse());
                this._guiPanelEl = panel;
                this._guiStatusEl = statusEl;
                this._guiLogEl = logEl;
                this._guiBodyEl = bodyWrap;
                this._guiProgressFill = progFill;
                this._guiProgressText = progText;
                this._guiDotEl = dot;
                this._guiCollapseHandler = onCollapse;
                document.body.appendChild(panel);
                try {
                    requestAnimationFrame(() => { panel.style.opacity = '1'; panel.style.transform = 'translateY(0)'; });
                } catch (e) {
                    panel.style.opacity = '1';
                    panel.style.transform = 'none';
                }
                this._guiHookConsole();
                if (this._guiLogEl) this._guiLogEl.textContent = this._guiLogs.join('\n');
                this._guiRefreshStatus(true);
                console.log('%c[GUI] 可视化面板已就绪（右上角，可折叠；默认零网络请求）', 'color:#4CAF50');
            },
            _guiDestroy() {
                if (this._guiPanelEl && this._guiPanelEl.parentNode) {
                    this._guiPanelEl.parentNode.removeChild(this._guiPanelEl);
                }
                this._guiPanelEl = null;
                this._guiStatusEl = null;
                this._guiLogEl = null;
                this._guiBodyEl = null;
                this._guiProgressFill = null;
                this._guiProgressText = null;
                this._guiDotEl = null;
                this._guiBtns = null;
                this._guiCollapseHandler = null;
                try {
                    const hook = window.__xuexitongPlayerGuiConsoleHook;
                    if (hook && hook.app === this) hook.app = null;
                } catch (e) { /* ignore */ }
            },
            _guiHookConsole() {
                const hookKey = '__xuexitongPlayerGuiConsoleHook';
                let hook = window[hookKey];
                if (!hook) {
                    const bind = (fn) => (typeof fn === 'function' ? fn.bind(console) : function () {});
                    const orig = {
                        log: bind(console.log),
                        info: bind(console.info),
                        warn: bind(console.warn),
                        error: bind(console.error),
                        debug: bind(console.debug),
                    };
                    hook = { app: null, orig: orig };
                    const wrap = (level) => function () {
                        const args = Array.prototype.slice.call(arguments);
                        try { orig[level].apply(console, args); } catch (e) { /* 保留原始控制台行为优先 */ }
                        try {
                            if (hook.app && typeof hook.app._guiLog === 'function') {
                                hook.app._guiLog(level, hook.app._guiFormatArgs(args));
                            }
                        } catch (e) { /* GUI 镜像失败绝不影响主流程 */ }
                    };
                    console.log = wrap('log');
                    console.info = wrap('info');
                    console.warn = wrap('warn');
                    console.error = wrap('error');
                    console.debug = wrap('debug');
                    window[hookKey] = hook;
                }
                hook.app = this;
            },
            _guiFormatArgs(args) {
                const parts = [];
                const isStyle = (v) => typeof v === 'string' && /^(color|font|background|border|text-)/i.test(v.trim());
                for (let i = 0; i < args.length; i++) {
                    const a = args[i];
                    if (a === '%c') { i++; continue; }
                    if (typeof a === 'string') {
                        const hasC = a.indexOf('%c') >= 0;
                        parts.push(a.replace(/%c/g, ''));
                        // console.log('%cxxx', 'style') 的样式参数要连同 %c 一起丢弃，避免污染面板日志。
                        if (hasC && isStyle(args[i + 1])) i++;
                        continue;
                    }
                    if (a && a.name && a.message && a.stack) { parts.push(a.name + ': ' + a.message); continue; }
                    try { parts.push(typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a)); } catch (e) { parts.push(String(a)); }
                }
                return parts.join(' ').replace(/\s+/g, ' ').trim();
            },
            _guiLog(level, text) {
                if (!this.configs.guiEnabled) return;
                try {
                    if (!text) return;
                    const d = new Date();
                    const pad = (n) => (n < 10 ? '0' + n : '' + n);
                    const stamp = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
                    this._guiLogs.push('[' + stamp + '] ' + text);
                    const max = Math.max(10, Number(this.configs.guiMaxLogLines) || 60);
                    if (this._guiLogs.length > max) this._guiLogs.splice(0, this._guiLogs.length - max);
                    if (this._guiLogEl) {
                        this._guiLogEl.textContent = this._guiLogs.join('\n');
                        this._guiLogEl.scrollTop = this._guiLogEl.scrollHeight;
                    }
                    this._guiRefreshStatus(false);
                } catch (e) { /* GUI 绝不影响主流程 */ }
            },
            _guiRefreshStatus(force) {
                if (!this._guiStatusEl) return;
                const now = Date.now();
                if (!force && now - (this._guiLastRefreshTs || 0) < 400) return;
                this._guiLastRefreshTs = now;
                try {
                    const cell = this._cellData || {};
                    const chapters = Number(cell.cells) || 0;
                    const videos = Number(this._videoTaskCount) || 0;
                    // F9+：用缓存的视频元素展示进度（避免每次日志刷新都重扫 iframe）。
                    const v = this._videoEl || null;
                    let ratio = 0;
                    let ct = 0;
                    let dur = 0;
                    if (v) {
                        ct = Number(v.currentTime) || 0;
                        dur = Number(v.duration) || 0;
                        if (dur > 0) ratio = Math.min(1, ct / dur);
                    }
                    if (this._guiProgressFill) this._guiProgressFill.style.width = (ratio * 100).toFixed(1) + '%';
                    if (this._guiProgressText) {
                        this._guiProgressText.textContent = dur > 0
                            ? (Math.round(ratio * 100) + '%  ' + Math.floor(ct) + '/' + Math.round(dur) + 's')
                            : '等待视频…';
                    }
                    if (this._guiDotEl) {
                        const playing = !!this._isPlaying && !this._interactionBlocked;
                        this._guiDotEl.style.background = this._interactionBlocked ? '#f59e0b' : (playing ? '#22c55e' : '#64748b');
                        this._guiDotEl.style.animation = playing ? 'xtPulse 2s infinite' : 'none';
                    }
                    const lines = [];
                    lines.push('状态 ' + (this._isPlaying ? '播放中' : '已暂停/空闲')
                        + ' ｜ 步骤 ' + (this._currentStepTitle() || '未知')
                        + (this._interactionBlocked ? ' ｜ 互动题暂停（等人工）' : ''));
                    lines.push('章节 ' + ((Number(cell.currentCellIndex) || 0) + 1) + '/' + (chapters || '?')
                        + ' ｜ 任务点 ' + (videos ? ((Number(this._currentVideoTaskIndex) || 0) + 1) + '/' + videos : '?'));
                    lines.push('LLM ' + (this.configs.llmEnabled ? '开' : '关')
                        + ' ｜ 密钥 ' + (this._llmApiKey ? '已配置' : '未配置')
                        + ' ｜ 已应答 ' + this._llmAnswersThisSession + '/' + this.configs.llmMaxAnswersPerSession
                        + ' ｜ 自动提交 ' + (this.configs.llmAutoSubmit ? '开' : '关'));
                    if (this._llmLastAnswer) lines.push('最近答案 ' + String(this._llmLastAnswer.q || '').slice(0, 16) + ' → ' + this._llmLastAnswer.a);
                    if (this._llmChapterSuggestedCount) lines.push('章节测验建议 ' + this._llmChapterSuggestedCount + ' 题（仅提示）');
                    this._guiStatusEl.textContent = lines.join('\n');
                    const setToggle = (key, on, onLabel, offLabel) => {
                        const b = this._guiBtns && this._guiBtns[key];
                        if (!b) return;
                        b.textContent = on ? onLabel : offLabel;
                        b.style.background = on ? 'rgba(34,197,94,.18)' : '#1f2937';
                        b.style.borderColor = on ? 'rgba(34,197,94,.65)' : 'rgba(148,163,184,.2)';
                        b.style.color = on ? '#86efac' : '#e2e8f0';
                    };
                    setToggle('pause', !this._isPlaying, '继续播放', '暂停播放');
                    setToggle('llm', !!this.configs.llmEnabled, 'LLM 已开', 'LLM 已关');
                    setToggle('submit', !!this.configs.llmAutoSubmit, '自动提交开', '自动提交关');
                } catch (e) { /* GUI 绝不影响主流程 */ }
            },
            _guiAskKey() {
                let value = null;
                try {
                    if (typeof prompt === 'function') value = prompt('请输入 LLM API Key（只保存在当前页面内存，不写入磁盘/仓库）：', this._llmApiKey || '');
                    else if (window && typeof window.prompt === 'function') value = window.prompt('请输入 LLM API Key（仅存内存）：', this._llmApiKey || '');
                } catch (e) { value = null; }
                if (value === null || value === undefined) return;
                if (!String(value).trim()) { console.warn('%c[GUI] 未填写 Key，保持原配置不变', 'color:#FF9800'); return; }
                this.setLlmKey(value);
            },
            // ================= F10（V3.5）：LLM 互动题应答（默认关闭，需显式开启 + 提供 Key） =================
            setLlmKey(key) {
                this._llmApiKey = String(key == null ? '' : key).trim();
                const masked = this._llmApiKey ? (this._llmApiKey.slice(0, 5) + '***' + this._llmApiKey.slice(-4)) : '(空)';
                console.log('%c[LLM] API Key 已更新（只存内存）: ' + masked, 'color:#2196F3');
                this._guiRefreshStatus(true);
                return this._llmApiKey.length > 0;
            },
            setHttpTransport(fn) {
                // F36：可插拔 HTTP 传输（与 setLlmTransport 同思路）——油猴版走 GM_xmlhttpRequest；
                // 控制台/演练环境由宿主注入（演练通过 CDP 注入同源 fetch 实现）。
                this._httpTransport = typeof fn === 'function' ? fn : null;
                console.log('%c[HTTP] ' + (this._httpTransport ? '已设置' : '已清除') + '自定义传输实现', 'color:#2196F3');
                return !!this._httpTransport;
            },
            _httpGet(url, cb) {
                const done = typeof cb === 'function' ? cb : function () {};
                const transport = this._httpTransport || ((u, c) => {
                    let gm = null;
                    try {
                        if (typeof GM_xmlhttpRequest !== 'undefined' && GM_xmlhttpRequest) gm = GM_xmlhttpRequest;
                        else if (window && window.GM_xmlhttpRequest) gm = window.GM_xmlhttpRequest;
                    } catch (e) { gm = null; }
                    if (typeof gm !== 'function') { c(new Error('当前环境没有 HTTP 传输（油猴 GM_xmlhttpRequest 或 app.setHttpTransport）')); return null; }
                    return gm({
                        method: 'GET',
                        url: u,
                        onload: (res) => c(null, res && res.responseText),
                        onerror: (err) => c(err || new Error('HTTP 错误')),
                        ontimeout: () => c(new Error('HTTP 超时')),
                    });
                });
                try { transport(String(url), done); } catch (e) { done(e); }
            },
            _beaconGet(url, cb) {
                // F36b：setlog 在 fystat-ans.chaoxing.com（跨域），fetch/XHR 会被 CORS 拦截；
                // 用隐藏 iframe 导航发起 GET（携带 cookie、不受 CORS 限制），3 秒后回收 iframe。
                const done = typeof cb === 'function' ? cb : function () {};
                try {
                    const f = document.createElement('iframe');
                    f.style.cssText = 'display:none;width:0;height:0;border:0;';
                    f.src = String(url);
                    document.body.appendChild(f);
                    this._schedule(() => {
                        try { if (f.parentNode) f.parentNode.removeChild(f); } catch (e) { /* ignore */ }
                        done(null);
                    }, 3000);
                } catch (e) {
                    done(e);
                }
            },
            _increaseChapterStudyCount() {
                // F36：上游流程 —— studentstudyAjax → 提取 <script src="https://fystat-ans.chaoxing.com/log/setlog..."> → GET 之。
                if (this._chapterStudyBusy) return;
                const target = Math.max(0, Number(this.configs.chapterStudyCount) || 0);
                if (!target) return;
                this._chapterStudyBusy = true;
                let sent = 0;
                const delay = Math.max(500, Number(this.configs.chapterStudyDelayMs) || 2500);
                const step = () => {
                    if (sent >= target) {
                        this._chapterStudyBusy = false;
                        console.log('%c[章节次数] 已发送 ' + sent + ' 次 setlog，完成', 'color:#4CAF50');
                        return;
                    }
                    let ajaxUrl = '';
                    try {
                        const q = new URLSearchParams(location.search);
                        const pick = (k) => q.get(k) || '';
                        ajaxUrl = '/mooc-ans/mycourse/studentstudyAjax?courseId=' + pick('courseId')
                            + '&clazzid=' + pick('clazzid')
                            + '&chapterId=' + pick('chapterId')
                            + '&cpi=' + pick('cpi')
                            + '&verificationcode=&mooc2=1';
                    } catch (e) { ajaxUrl = ''; }
                    if (!ajaxUrl) { this._chapterStudyBusy = false; return; }
                    this._httpGet(ajaxUrl, (err, text) => {
                        if (err) { this._chapterStudyBusy = false; console.warn('%c[章节次数] 请求失败：' + (err && err.message ? err.message : err), 'color:#FF9800'); return; }
                        const re = /<script[^>]+src=\u0022(https:\/\/fystat-ans\.chaoxing\.com\/log\/setlog[^\u0022]+)\u0022/;
                        const m = re.exec(String(text || ''));
                        if (!m) { this._chapterStudyBusy = false; console.warn('%c[章节次数] 响应中未找到 setlog URL', 'color:#FF9800'); return; }
                        this._beaconGet(m[1], (err2) => {
                            if (err2) { this._chapterStudyBusy = false; console.warn('%c[章节次数] setlog 失败：' + (err2 && err2.message ? err2.message : err2), 'color:#FF9800'); return; }
                            sent++;
                            console.log('%c[章节次数] setlog ' + sent + '/' + target, 'color:#4CAF50');
                            this._schedule(step, delay);
                        });
                    });
                };
                step();
            },
            setLlmTransport(fn) {
                this._llmTransport = typeof fn === 'function' ? fn : null;
                console.log('%c[LLM] ' + (this._llmTransport ? '已设置' : '已清除') + '自定义传输实现', 'color:#2196F3');
                return !!this._llmTransport;
            },
            _llmSession() {
                if (!this._llmSessionId) {
                    let id = '';
                    try {
                        if (window && window.crypto && typeof window.crypto.randomUUID === 'function') {
                            id = window.crypto.randomUUID();
                        }
                    } catch (e) { id = ''; }
                    if (!id) id = 'xt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
                    this._llmSessionId = id;
                    console.log('%c[LLM] 生成本会话路由 ID（x-opencode-session，会话内固定复用）: ' + id, 'color:#607D8B');
                }
                return this._llmSessionId;
            },
            _llmCancelInFlight(reason) {
                if (!this._llmInFlight && !this._llmAbort) return;
                try { if (typeof this._llmAbort === 'function') this._llmAbort(); } catch (e) { /* ignore */ }
                this._llmAbort = null;
                this._llmInFlight = false;
                if (reason) console.log('%c[LLM] 已中止在途请求（' + reason + '）', 'color:#607D8B');
            },
            _llmRequest(payload, onDone, onFail) {
                // F33（V3.6 补丁）：请求节流 —— 最小间隔 + 抖动（0.7~1.3 倍），既防 429 也降低风控概率。
                const minGap = Math.max(0, Number(this.configs.llmMinIntervalMs) || 0);
                const nowTs = Date.now();
                const wait = this._llmNextAllowedTs ? Math.max(0, this._llmNextAllowedTs - nowTs) : 0;
                this._llmNextAllowedTs = nowTs + wait + Math.round(minGap * (0.7 + Math.random() * 0.6));
                if (wait > 0) {
                    console.log('%c[LLM] 请求节流：等待 ' + wait + 'ms 后发送（llmMinIntervalMs=' + minGap + '）', 'color:#607D8B');
                    this._schedule(() => this._llmRequestNow(payload, onDone, onFail), wait);
                    return null;
                }
                return this._llmRequestNow(payload, onDone, onFail);
            },
            _llmModelChain() {
                // F53：主模型 + 降级模型列表（去重、去空、保序）。
                const out = [];
                const push = (m) => {
                    const s = String(m == null ? '' : m).trim();
                    if (!s || out.indexOf(s) >= 0) return;
                    out.push(s);
                };
                push(this.configs.llmModel);
                const list = this.configs.llmModelFallbacks;
                if (Array.isArray(list)) list.forEach(push);
                return out;
            },
            _llmClassifyModelError(err) {
                // F53：判断失败原因是否需要"换模型"或"去掉 response_format 重试"。
                const msg = String((err && err.message) || err || '');
                const m = /HTTP\s+(\d{3})/.exec(msg);
                const status = m ? Number(m[1]) : 0;
                if (status === 400) return { code: 'HTTP 400（请求参数被拒）', nextModel: true, tryNoJsonMode: true };
                if (status === 401 || status === 403) {
                    const region = /RegionError/.test(msg) ? ' RegionError（地区门禁）' : '（无权限/鉴权失败）';
                    return { code: 'HTTP ' + status + region, nextModel: true };
                }
                if (status === 404 || status === 422) return { code: 'HTTP ' + status + '（模型不存在/不可用）', nextModel: true };
                if (status === 429) return { code: 'HTTP 429（限流）', nextModel: true };
                if (status >= 500) return { code: 'HTTP ' + status + '（网关错误）', nextModel: true };
                if (status) return { code: 'HTTP ' + status, nextModel: false };
                if (/超时|网络错误|timeout|ETIMEDOUT|ECONNRESET/i.test(msg)) return { code: '网络/超时', nextModel: true };
                if (/内容为空|token 耗尽/.test(msg)) return { code: '空响应', nextModel: true };
                return { code: msg.slice(0, 60) || '未知错误', nextModel: false };
            },
            setLlmModels(primary, fallbacks) {
                // F53：运行时切换模型（只存内存）。fallbacks 传数组则整体替换降级列表。
                if (primary != null && String(primary).trim()) this.configs.llmModel = String(primary).trim();
                if (Array.isArray(fallbacks)) {
                    this.configs.llmModelFallbacks = fallbacks.map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
                }
                this._llmModelIndex = 0;
                this._llmNoJsonMode = false;
                console.log('%c[LLM] 模型链已更新：' + this._llmModelChain().join(' → '), 'color:#2196F3');
                return this._llmModelChain();
            },
            _llmRequestChain(payload, onDone, onFail) {
                // F53：模型降级链 —— 依次尝试，停在第一个可用模型（本会话粘性复用），全部失败才回调失败。
                const chain = this._llmModelChain();
                if (this.configs.llmModelFallbackOn === false || chain.length <= 1) {
                    this._llmInFlight = true;
                    return this._llmAttempt(payload, onDone, onFail, false);
                }
                const startIdx = Math.max(0, Math.min(Number(this._llmModelIndex) || 0, chain.length - 1));
                let idx = startIdx;
                let noJsonMode = !!this._llmNoJsonMode;
                let lastErr = null;
                this._llmInFlight = true;
                const step = () => {
                    if (idx >= chain.length) {
                        this._llmInFlight = false;
                        onFail(lastErr || new Error('全部模型均不可用（' + chain.join(' → ') + '）'));
                        return;
                    }
                    const model = chain[idx];
                    const body = Object.assign({}, payload, { model: model });
                    if (noJsonMode) delete body.response_format;
                    this._llmAttempt(body, (content, meta) => {
                        if (idx !== startIdx) {
                            console.log('%c[LLM] 已切换模型：' + model + '（原 ' + chain[startIdx] + ' 不可用），本题起复用该模型', 'color:#4CAF50');
                        }
                        this._llmModelIndex = idx;
                        this._llmNoJsonMode = noJsonMode;
                        this._llmInFlight = false;
                        onDone(content, meta);
                    }, (err) => {
                        lastErr = err || new Error('LLM 请求失败');
                        const info = this._llmClassifyModelError(lastErr);
                        if (info.tryNoJsonMode && !noJsonMode) {
                            console.log('%c[LLM] 模型 ' + model + ' 判定 ' + info.code + ' → 去掉 response_format 重试一次', 'color:#FF9800');
                            noJsonMode = true;
                            this._schedule(step, 300);
                            return;
                        }
                        if (!info.nextModel) {
                            this._llmInFlight = false;
                            onFail(lastErr);
                            return;
                        }
                        const next = chain[idx + 1];
                        console.log('%c[LLM] 模型 ' + model + ' 不可用（' + info.code + '）'
                            + (next ? ' → 自动降级到 ' + next : ' → 已无更多备用模型'), 'color:#FF9800');
                        idx++;
                        if (idx < chain.length) {
                            this._llmModelIndex = idx;
                            noJsonMode = !!this._llmNoJsonMode;
                            this._schedule(step, Math.max(300, Math.min(1500, Number(this.configs.llmMinIntervalMs) || 800)));
                        } else {
                            this._llmInFlight = false;
                            onFail(lastErr);
                        }
                    }, true);
                };
                step();
                return null;
            },
            _llmRequestNow(payload, onDone, onFail) {
                const cfg = this.configs;
                // 60 秒心跳重试（最多 3 次）：整条模型链失败通常是"AI 接口断联"（网络/网关抖动），
                // 等一会儿往往就通了；不重试就会卡在"无法匹配选项 → 只存草稿 → 停止前进"等人。
                // 真机 2026-09-16：答题时 AI 断联即卡住，用户要求加此心跳重试。
                const interval = Math.max(1000, Number(cfg.llmRetryIntervalMs) || 60000);
                const maxRetries = Math.max(0, Number(cfg.llmMaxRetries == null ? 3 : cfg.llmMaxRetries));
                let tries = 0;
                const attempt = () => {
                    this._llmRequestChain(payload, onDone, (err) => {
                        tries++;
                        if (tries > maxRetries) { onFail(err); return; }
                        const reason = (err && err.message) ? err.message : String(err);
                        console.log('%c[LLM] AI 接口断联（' + reason.slice(0, 120) + '）→ ' + Math.round(interval / 1000)
                            + ' 秒后心跳重试（第 ' + tries + '/' + maxRetries + ' 次）', 'color:#FF9800');
                        this._schedule(attempt, interval);
                    });
                };
                attempt();
                return null;
            },
            _llmAttempt(payload, onDone, onFail, keepInFlight) {
                const cfg = this.configs;
                const timeoutMs = Math.max(1000, Number(cfg.llmTimeoutMs) || 30000);
                let timer = null;
                let settled = false;
                const finish = (ok, a, b) => {
                    if (settled) return;
                    settled = true;
                    if (!keepInFlight) this._llmInFlight = false;
                    this._llmAbort = null;
                    if (timer) this._cancelTimer(timer);
                    try { if (ok) onDone(a, b); else onFail(a); } catch (e) { console.error('[LLM] 回调处理失败:', e); }
                };
                const transport = this._llmTransport || ((opts) => {
                    let gm = null;
                    try {
                        if (typeof GM_xmlhttpRequest !== 'undefined' && GM_xmlhttpRequest) gm = GM_xmlhttpRequest;
                        else if (window && window.GM_xmlhttpRequest) gm = window.GM_xmlhttpRequest;
                    } catch (e) { gm = null; }
                    if (typeof gm !== 'function') {
                        opts.onerror(new Error('当前环境没有 GM_xmlhttpRequest：请使用油猴版 v3_optimized.user.js，或先用 app.setLlmTransport(fn) 注入传输实现'));
                        return null;
                    }
                    return gm({
                        method: opts.method,
                        url: opts.url,
                        headers: opts.headers,
                        data: opts.data,
                        timeout: opts.timeout,
                        onload: (res) => opts.onload(res && res.status, res && res.responseText),
                        onerror: (err) => opts.onerror(err || new Error('LLM 网络错误')),
                        ontimeout: () => opts.onerror(new Error('LLM 请求超时')),
                    });
                });
                this._llmInFlight = true;
                timer = this._schedule(() => finish(false, new Error('LLM 请求超时（' + timeoutMs + 'ms）')), timeoutMs);
                let handle = null;
                try {
                    handle = transport({
                        method: 'POST',
                        url: cfg.llmEndpoint,
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': 'Bearer ' + this._llmApiKey,
                            'x-opencode-session': this._llmSession(),
                        },
                        data: JSON.stringify(payload),
                        timeout: timeoutMs,
                        onload: (status, text) => {
                            if (status && (Number(status) < 200 || Number(status) >= 300)) {
                                finish(false, new Error('HTTP ' + status + '：' + String(text || '').slice(0, 200)));
                                return;
                            }
                            // OpenAI 兼容信封解包：只把助手正文（content）交给答案解析，绝不把整个响应/推理过程当答案。
                            let content = '';
                            let finishReason = '';
                            try {
                                const data = JSON.parse(String(text || ''));
                                const choice = data && data.choices && data.choices[0];
                                const msg = choice && choice.message;
                                content = String((msg && (msg.content || msg.reasoning_content)) || '');
                                finishReason = String((choice && choice.finish_reason) || '');
                            } catch (e) { content = ''; }
                            if (!content.trim()) {
                                const reason = finishReason === 'length'
                                    ? '推理 token 耗尽（finish_reason=length）：请增大 llmMaxTokens'
                                    : '模型返回内容为空（响应格式异常或网关错误）';
                                finish(false, new Error(reason));
                                return;
                            }
                            finish(true, content);
                        },
                        onerror: (err) => finish(false, err && err.message ? err : new Error(String(err || 'LLM 网络错误'))),
                    });
                } catch (e) { finish(false, e); return; }
                this._llmAbort = () => {
                    if (handle && typeof handle.abort === 'function') {
                        try { handle.abort(); } catch (e) { /* ignore */ }
                    }
                };
            },
            _llmNormalizeJudge(text) {
                const t = String(text == null ? '' : text).replace(/[\s\u0060*\u0022\u0027。．]+/g, '');
                if (!t) return '';
                if (/^(对|正确|是|√|T|true|yes)$/i.test(t)) return '对';
                if (/^(错|错误|否|×|F|false|no)$/i.test(t)) return '错';
                if (t.length <= 6 && /正确/.test(t)) return '对';
                if (t.length <= 6 && /错误/.test(t)) return '错';
                return '';
            },
            _llmExtractAnswer(text, opts) {
                // F37（V3.6 补丁）：兼容多选题、拒绝模板占位回显（如「选项字母」）、支持多字母；仍优先取最后一个 JSON。
                const raw = String(text == null ? '' : text);
                const wantMulti = !!(opts && opts.multi);
                const placeholder = /^(选项字母|答案字母|选项|答案|letter|choice|选项内容|待定|无|none)$/i;
                const lettersOf = (v) => {
                    if (v == null) return '';
                    if (Array.isArray(v)) v = v.join('');
                    const s = String(v).trim();
                    if (!s || placeholder.test(s)) return '';
                    const letters = s.toUpperCase().match(/[A-H]/g) || [];
                    if (!letters.length) return '';
                    const junk = s.replace(/[A-Ha-h、,，.．:：和及\s]/g, '');
                    if (!junk.length) return letters.join('');
                    const ascii = s.replace(/[^A-Za-z]/g, '');
                    if (ascii.length === letters.length) return letters.join('');
                    return '';
                };
                const jsonCandidates = raw.match(/\{[^{}]{0,600}\}/g) || [];
                for (let i = jsonCandidates.length - 1; i >= 0; i--) {
                    try {
                        const obj = JSON.parse(jsonCandidates[i]);
                        const value = obj && (obj.answer != null ? obj.answer : (obj.result != null ? obj.result : obj.choice));
                        const letters = lettersOf(value);
                        if (letters) return letters;
                        if (value != null && String(value).trim() && !placeholder.test(String(value).trim())) {
                            return String(value).trim();
                        }
                    } catch (e) { /* 继续尝试更早的 JSON */ }
                }
                const labeled = raw.match(/(?:答案|选项|answer)\s*[:：是为\s]*([A-H](?:\s*[、,，.．:：和及]?\s*[A-H])*)/i);
                if (labeled && labeled[1]) return labeled[1].toUpperCase().replace(/[^A-H]/g, '');
                const compact = raw.replace(/[\s\u0060*\u0022\u0027。．]+/g, '');
                if (compact.length <= 8) {
                    const judge = this._llmNormalizeJudge(compact);
                    if (judge) return judge;
                }
                if (wantMulti) {
                    // F37：多选兜底 —— 从回复末尾提取连续字母序列（推理模型常把答案写在最后）；必须在单选括号兜底之前。
                    const tail = raw.slice(-160);
                    const seq = tail.match(/[A-H](?:\s*[、,，.．:：和及]?\s*[A-H])+/g);
                    if (seq && seq.length) return seq[seq.length - 1].replace(/[^A-H]/g, '');
                }
                const bracketed = raw.match(/(?:^|[^A-Za-z])([A-H])(?:\s*[\)、.．:：]|\s*$)/);
                if (bracketed && bracketed[1]) return bracketed[1];
                return '';
            },
            _answerCacheKey(text) {
                return String(text || '').replace(/\s+/g, '').replace(/[（(][^（()）]{0,30}[)）]/g, '').slice(0, 240);
            },
            _answerCacheGet(text) {
                const key = this._answerCacheKey(text);
                if (!key) return null;
                if (!this._answerCache) this._answerCache = new Map();
                return this._answerCache.get(key) || null;
            },
            _answerCacheSet(text, kind, answer) {
                const key = this._answerCacheKey(text);
                const ans = String(answer == null ? '' : answer).trim();
                if (!key || !ans) return;
                if (!this._answerCache) this._answerCache = new Map();
                this._answerCache.set(key, { kind: kind, answer: ans, at: Date.now() });
                if (this._answerCache.size > 500) {
                    const firstKey = this._answerCache.keys().next().value;
                    this._answerCache.delete(firstKey);
                }
            },
            _llmBuildPayload(messages) {
                const payload = {
                    model: this.configs.llmModel,
                    messages: messages,
                    max_tokens: Math.max(256, Number(this.configs.llmMaxTokens) || 4096),
                    temperature: 0,
                };
                if (this.configs.llmJsonMode !== false) {
                    payload.response_format = { type: 'json_object' };
                }
                return payload;
            },
            _llmBuildMessages(question, options, opts) {
                const multi = !!(opts && opts.multi);
                const strict = !!(opts && opts.strict);
                const list = Array.isArray(options) ? options : [];
                const lines = list.map((o, i) => {
                    const label = o && o.letter ? String(o.letter) : String.fromCharCode(65 + i);
                    const body = String(o && o.text ? o.text : '').replace(/^[A-H][、.．:：\s]+/, '').trim();
                    return label + '、' + body;
                });
                let system = '你是课程答题助手。根据题目与选项选出正确答案，只输出一个 JSON 对象，不要解释、不要 Markdown、不要推理过程。';
                if (multi) system += '本题为多选题：answer 用多个选项字母连写（例如 "AC"），不要只给一个字母。';
                system += '答案必须是本题选项列表中的字母，不要照抄提示文字。';
                if (strict) system = '上一次输出无法解析。只输出一个 JSON 对象，禁止任何其他文字。' + system;
                else system += '示例：{"answer":"A"}。';
                const user = '题目：' + String(question || '').slice(0, 500)
                    + '\n选项：\n' + lines.join('\n')
                    + '\n只输出 JSON' + (multi ? '（多选：字母连写）' : '') + '，例如 ' + (multi ? '{"answer":"AC"}' : '{"answer":"A"}') + '。';
                return [
                    { role: 'system', content: system },
                    { role: 'user', content: user },
                ];
            },
            _cxNormalizeText(text) {
                // F35：移植上游 api/base.py normalize_text —— 异体字归一 + 去字母前缀/空白/标点 + 小写。
                let t = String(text == null ? '' : text);
                t = t.replace(/⻛/g, '风').replace(/⻔/g, '门').replace(/⻋/g, '车').replace(/⻢/g, '马');
                t = t.replace(/^[A-Za-z]\s*[.、:：)?）]?\s*/, '');
                t = t.replace(/\s+/g, '');
                t = t.replace(/[，。！？；：,.!?;:()（）\[\]【】\u0022\u201C\u201D\u2018\u2019\-_/\\|]/g, '');
                return t.toLowerCase();
            },
            _cxCleanAnswer(value) {
                // F35：移植上游 clean_res —— 去选项字母前缀与首尾标点（长度>1 时才去字母前缀）。
                const s = String(value == null ? '' : value).trim();
                if (s.length <= 1) return s;
                return s.replace(/^[A-Za-z]\s*[.、:：)?）]?\s*/, '').replace(/[.,!?;:，。！？；：]/g, '').trim();
            },
            _cxIsSubsequence(a, o) {
                // F35：移植上游 is_subsequence（a 的字符是否按序出现在 o 中）。
                const aa = String(a == null ? '' : a).toLowerCase();
                const oo = String(o == null ? '' : o).toLowerCase();
                if (!aa) return false;
                let i = 0;
                for (const ch of oo) { if (ch === aa[i]) i++; if (i >= aa.length) return true; }
                return false;
            },
            _cxSeqRatio(a, b) {
                // F35：移植 difflib.SequenceMatcher.ratio 的等价实现（Ratcliff-Obershelp；无 junk 启发式）。
                const A = String(a || '');
                const B = String(b || '');
                if (!A.length && !B.length) return 1;
                if (!A.length || !B.length) return 0;
                const longestMatch = (alo, ahi, blo, bhi) => {
                    let besti = alo, bestj = blo, bestsize = 0;
                    const b2j = new Map();
                    for (let j = blo; j < bhi; j++) {
                        const ch = B[j];
                        if (!b2j.has(ch)) b2j.set(ch, []);
                        b2j.get(ch).push(j);
                    }
                    let j2len = new Map();
                    for (let i = alo; i < ahi; i++) {
                        const newj2len = new Map();
                        const js = b2j.get(A[i]) || [];
                        for (const j of js) {
                            if (j < blo) continue;
                            if (j >= bhi) break;
                            const k = (j2len.get(j - 1) || 0) + 1;
                            newj2len.set(j, k);
                            if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
                        }
                        j2len = newj2len;
                    }
                    return { i: besti, j: bestj, size: bestsize };
                };
                let total = 0;
                const stack = [[0, A.length, 0, B.length]];
                while (stack.length) {
                    const cur = stack.pop();
                    const m = longestMatch(cur[0], cur[1], cur[2], cur[3]);
                    if (m.size > 0) {
                        total += m.size;
                        if (cur[0] < m.i && cur[2] < m.j) stack.push([cur[0], m.i, cur[2], m.j]);
                        if (m.i + m.size < cur[1] && m.j + m.size < cur[3]) stack.push([m.i + m.size, cur[1], m.j + m.size, cur[3]]);
                    }
                }
                return (2 * total) / (A.length + B.length);
            },
            _llmPickOptions(options, answer, opts) {
                // F35（V3.6 补丁）：选项匹配改为移植上游 api/base.py 的降级链：
                //   clean_res(去字母前缀) → is_subsequence → normalize_text + SequenceMatcher.ratio(0.8)；
                //   纯字母/多选字母/判断题的直接命中保留（这是页面的基本形态）。
                const list = Array.isArray(options) ? options : [];
                const ans = String(answer == null ? '' : answer).trim();
                if (!list.length || !ans) return [];
                const compact = ans.replace(/\s+/g, '').toUpperCase();
                const byLetter = (ch) => list.filter((opt) => String(opt.letter || '').toUpperCase() === ch);
                // 1) 纯字母答案（含多选：B / B、C / B和C）
                if (/^[A-H]([、,，.．:：和及]{0,2}[A-H])*$/.test(compact)) {
                    const picked = [];
                    for (const ch of compact) {
                        if (ch < 'A' || ch > 'H') continue;
                        for (const opt of byLetter(ch)) if (picked.indexOf(opt) < 0) picked.push(opt);
                    }
                    if (picked.length) return (opts && opts.single) ? picked.slice(0, 1) : picked;
                }
                // 2) 答案夹带单个字母（「选B」「B选项」「答案：B」「B（xxx）」）
                const letters = compact.match(/[A-H]/g) || [];
                if (letters.length === 1 && (compact.indexOf(letters[0]) === 0 || compact.replace(/[A-H]/g, '').length <= 8)) {
                    const hit = byLetter(letters[0]);
                    if (hit.length) return hit.slice(0, 1);
                }
                // 3) 判断题
                const judge = this._llmNormalizeJudge(ans);
                if (judge) {
                    const hit = list.filter((opt) => {
                        const t = String(opt.text || '');
                        if (judge === '对') return /正确|^对$|√|true/i.test(t);
                        if (judge === '错') return /错误|^错$|×|false/i.test(t);
                        return false;
                    });
                    if (hit.length) return hit.slice(0, 1);
                }
                // 4) 上游链：clean_res → normalize_text 包含匹配 → is_subsequence
                const cleaned = this._cxCleanAnswer(ans);
                const normalized = this._cxNormalizeText(cleaned);
                if (normalized) {
                    for (const opt of list) {
                        const optionText = String(opt.text || '');
                        const optNorm = this._cxNormalizeText(this._cxCleanAnswer(optionText));
                        if (!optNorm) continue;
                        if (optNorm === normalized || optNorm.indexOf(normalized) >= 0 || normalized.indexOf(optNorm) >= 0) return [opt];
                        if (this._cxIsSubsequence(normalized, optNorm)) return [opt];
                    }
                }
                // 5) 上游相似度兜底：SequenceMatcher.ratio ≥ 0.8
                let best = null;
                let bestScore = 0;
                for (const opt of list) {
                    const optNorm = this._cxNormalizeText(this._cxCleanAnswer(String(opt.text || '')));
                    if (!optNorm) continue;
                    const score = this._cxSeqRatio(normalized, optNorm);
                    if (score > bestScore) { bestScore = score; best = opt; }
                }
                if (best && bestScore >= 0.8) return [best];
                return [];
            },
            _llmPickOption(options, answer) {
                const picked = this._llmPickOptions(options, answer);
                return picked.length ? picked[0] : null;
            },
            _stripQuizChrome(text) {
                // F56：剥掉「视频内嵌题容器」的噪声文案，只留题干与选项。
                // 安全边界：**只有确认是内嵌题容器文本时才动手**（含「共 N 题」或「已答对 M 题」），
                // 否则一律原样返回 —— 避免误伤题干里本来就含"提交/回看"等词的普通题目。
                let t = String(text == null ? '' : text);
                // F59：计数占位可能**没有数字**（真机变体：「，已答对 题 单选题…」「， 单选题…」），
                // 因此守卫与剥离都用 \d* 而非 \d+ —— 否则两个变体剥不出同一串，去重键漂移，同一题会答两遍。
                if (!/(共\s*\d*\s*题|已答对\s*\d*\s*题)/.test(t)) return t;
                t = t.replace(/共\s*\d*\s*题/g, ' ').replace(/已答对\s*\d*\s*题/g, ' ');
                t = t.replace(/提交中|提交|继续学习|知识点回看|查看解析|回看/g, ' ');
                t = t.replace(/恭喜你[^。！!]*[。！!]?/g, ' ').replace(/真遗憾[^。！!]*[。！!]?/g, ' ');
                t = t.replace(/你的答题水准超过了\s*\d+%\s*的同学/g, ' ').replace(/再接再厉|答对了/g, ' ');
                // F56b：真实倒计时占位是无数字的「分钟」占位符（真机文本：…真遗憾，再接再厉！回看 分钟…），
                // 因此写成 \d* 而非 \d+，否则会残留 " 分钟" 尾巴让去重键不稳定。
                // F59 教训：这里**不能**再做"行首标点归一"之类的额外清理 —— 只有走剥离的那一版会被清理，
                // 而不含噪声的那一版会原样返回，两边反而永不相等（F59 首版就是这么红的）。
                // 不变量：只剥掉已识别的噪声文案，其余字符一字不改。
                t = t.replace(/\d*\s*分钟/g, ' ').replace(/\s+/g, ' ').trim();
                return t;
            },
            _quizProgress(text) {
                // F56：从内嵌题容器文本读「共 N 题 / 已答对 M 题」。
                const t = String(text == null ? '' : text);
                const total = /共\s*(\d+)\s*题/.exec(t);
                const correct = /已答对\s*(\d+)\s*题/.exec(t);
                const totalN = total ? Number(total[1]) : 0;
                const correctN = correct ? Number(correct[1]) : 0;
                return {
                    total: totalN,
                    correct: correctN,
                    allCorrect: totalN > 0 && correctN >= totalN,
                };
            },
            _llmQuestionKey(found) {
                // F56：去重键必须用「剥掉容器噪声」后的题干 —— 否则作答后计数从 0 变 1 就会让哈希变化，
                // 同一题被当成新题重答一遍（真机：已答对 1 题后又答了一次，answers=2 却只有 1 道题）。
                const t = this._stripQuizChrome(String((found && (found.questionText || found.text)) || ''));
                if (!t) return '';
                let hash = 0;
                for (let i = 0; i < t.length; i++) hash = ((hash << 5) - hash + t.charCodeAt(i)) | 0;
                return 'q' + hash;
            },
            _llmAskChoice(questionText, options, isMulti, cb) {
                // F37：选择题统一入口 —— 解析失败自动重试一次（严格 JSON 提示），多选按字母序列匹配。
                const done = typeof cb === 'function' ? cb : function () {};
                let attempt = 0;
                const ask = () => {
                    attempt++;
                    this._llmRequest(
                        this._llmBuildPayload(this._llmBuildMessages(questionText, options, { multi: !!isMulti, strict: attempt > 1 })),
                        (content) => {
                            const answer = this._llmExtractAnswer(content, { multi: !!isMulti });
                            const picked = this._llmPickOptions(options, answer, { single: !isMulti });
                            if (picked.length) { done(null, { answer: answer, picked: picked, raw: content, attempt: attempt }); return; }
                            if (attempt < 2) {
                                console.log('%c[LLM] 第 ' + attempt + ' 次输出无法解析，自动重试一次（严格 JSON 模式）', 'color:#FF9800');
                                this._schedule(ask, Math.max(600, Number(this.configs.llmMinIntervalMs) || 800));
                                return;
                            }
                            done(new Error('无法匹配选项'), { answer: answer, picked: [], raw: content, attempt: attempt });
                        },
                        (err) => {
                            if (attempt < 2) { this._schedule(ask, 1200); return; }
                            done(err || new Error('LLM 请求失败'), null);
                        }
                    );
                };
                ask();
            },
            _canLlmAnswer(found) {
                if (!this.configs.llmEnabled) return false;
                if (!this._llmApiKey) {
                    if (!this._llmWarnedNoKeyOnce) {
                        this._llmWarnedNoKeyOnce = true;
                        console.warn('%c[LLM] llmEnabled=true 但未配置 API Key：请点 GUI 面板「设置 Key」或执行 app.setLlmKey(...)；本题回退人工处理。', 'color:#FF9800');
                    }
                    return false;
                }
                if (!found || !Array.isArray(found.options) || found.options.length < 2) return false;
                if (this._llmInFlight) return false;
                if (!found.questionText && !found.text) return false;
                if (this._llmAnswersThisSession >= Math.max(1, Number(this.configs.llmMaxAnswersPerSession) || 50)) return false;
                return true;
            },
            _answerInteractionWithLlm(found) {
                const rawFull = String(found.questionText || found.text || '');
                // F56：已全部答对就别再答一遍 —— 既省 LLM 调用，也避免对已答对的多选题再点一次把选项点掉。
                const progress = this._quizProgress(rawFull);
                if (progress.allCorrect) {
                    // F57/F58：互动看门狗会以 ~1.5s 周期反复探测同一道"已答对"的题（真机修复前 10 秒 7 行）。
                    // F57 先做了 15 秒限频（真机残留：间隔 15~17 秒仍持续冒行），F58 收紧为**按题目键只提示一次**
                    // （记忆最近 50 个键）。**行为完全不变**：仍然每次都重新评估；若平台把该题重置为「已答对 0 题」，
                    // _quizProgress 的 allCorrect 变 false → 闸门不再命中 → 照常作答（F58-2 把这条前提钉成断言）。
                    const logKey = this._llmQuestionKey(found);
                    const seen = this._quizAllCorrectKeys || (this._quizAllCorrectKeys = []);
                    if (logKey && seen.indexOf(logKey) < 0) {
                        if (seen.length >= 50) seen.shift();
                        seen.push(logKey);
                        console.log('%c[LLM] 互动题已全部答对（' + progress.correct + '/' + progress.total + '），跳过重复作答', 'color:#4CAF50');
                    }
                    return;
                }
                const questionKey = this._llmQuestionKey(found);
                if (questionKey && questionKey === this._llmLastQuestionKey) return;
                this._llmLastQuestionKey = questionKey;
                const options = found.options.slice(0, 8).map((opt, index) => ({
                    letter: opt.letter || String.fromCharCode(65 + index),
                    text: opt.text,
                    el: opt.el,
                }));
                const rawQuestion = (this._stripQuizChrome(rawFull) || rawFull).slice(0, 500);
                // F52：互动题（视频内嵌题）的题干与选项也可能被 font-cxsecret 混淆，先解密再审题；
                // 若仍有"有字形却未解出"的混淆字，判为不确定 → 不自动作答，回退人工（与 F48/F49 同一策略）。
                this._cxSecretDecode([rawQuestion].concat(options.map((o) => o.text)), (decoded) => {
                    const question = String(decoded[0] || rawQuestion);
                    const opts = options.map((o, i) => ({ letter: o.letter, el: o.el, text: String(decoded[i + 1] || o.text) }));
                    console.log('%c[LLM] 检测到互动题，题干(已解码)：' + question.slice(0, 160), 'color:#607D8B');
                    if (opts.length) {
                        console.log('%c[LLM] 互动题选项(已解码)：' + opts.map((o) => o.letter + ':' + String(o.text).slice(0, 24)).join(' | '), 'color:#607D8B');
                    }
                    const unresolved = this._cxLastUnresolved || [];
                    if (unresolved.length) {
                        console.warn('%c[LLM] 互动题题干仍有 ' + unresolved.length + ' 个未解出的混淆字（' + unresolved.slice(0, 10).join('') + '），判为不确定 → 不自动作答，回退人工', 'color:#FF9800');
                        this._llmLastQuestionKey = '';
                        if (!this._interactionBlocked) this._blockInteractionForManual(found);
                        return;
                    }
                    this._guiRefreshStatus(true);
                    const isMulti = /多选/.test(question)
                        || opts.some((o) => { try { return !!(o.el && o.el.querySelector && o.el.querySelector('input[type=checkbox]')); } catch (e) { return false; } });
                    this._llmAskChoice(question, opts, isMulti, (err, result) => {
                        if (err || !result || !result.picked.length) {
                            console.warn('%c[LLM] 互动题作答失败，回退为人工处理：' + (err ? err.message : '无法匹配选项'), 'color:#FF9800');
                            this._llmLastQuestionKey = '';
                            if (!this._interactionBlocked) this._blockInteractionForManual(found);
                            return;
                        }
                        this._applyInteractionAnswer(found, opts, result);
                    });
                });
            },
            _applyInteractionAnswer(found, options, result) {
                // F37（V3.6 补丁）：支持多选（picked 可多个）；点击后仍走原有「提交/继续」逻辑。
                const picked = (result && result.picked) || [];
                const answer = String((result && result.answer) || '');
                if (!picked.length || !picked[0].el) {
                    console.warn('%c[LLM] 无法解析答案（原始返回: ' + String((result && result.raw) || '').slice(0, 160) + '），回退为人工处理', 'color:#FF9800');
                    this._llmLastQuestionKey = '';
                    if (!this._interactionBlocked) this._blockInteractionForManual(found);
                    return;
                }
                this._llmAnswersThisSession++;
                this._llmLastAnswer = { q: String(found.text || '').slice(0, 40), a: answer.slice(0, 20) };
                this._answerCacheSet(String(found.questionText || found.text || ''), 'choice', answer);
                this._guiRefreshStatus(true);
                // F42：提交按钮识别 + DOM 诊断 dump —— 与点击成败无关，先做（F55 回归修复：
                // 此前这段被挪进点击回调，点击失败即提前 return，导致"未找到提交按钮"的诊断不再打印）。
                const submitEl = this._findInteractionSubmit(found);
                if (!submitEl) {
                    console.warn('%c[LLM] 未找到提交/继续按钮：将先选中答案，请人工点击「提交/继续」（弹窗消失后脚本自动恢复）', 'color:#FF9800');
                    try {
                        // F42：诊断 dump —— 记录弹窗 DOM 与候选控件，便于下一次精准补按钮识别。
                        const scope = (found && found.el) || null;
                        const snap = scope ? String(scope.outerHTML || '').replace(/\s+/g, ' ').slice(0, 600) : '(no-scope)';
                        let cands = '';
                        if (scope && scope.querySelectorAll) {
                            cands = Array.from(scope.querySelectorAll('button,a,[class*="btn"],[class*="Btn"],[onclick]')).slice(0, 10)
                                .map((el) => el.tagName + '.' + String(el.className || '').slice(0, 24) + '[' + String(el.textContent || '').replace(/\s+/g, '').slice(0, 10) + ']').join(' § ');
                        }
                        console.warn('%c[LLM] 弹窗诊断: ' + snap + ' ｜ 候选: ' + cands, 'color:#607D8B');
                    } catch (e) { /* ignore */ }
                }
                // F55-B：先确保选项真正选上，再决定提交；没选上就绝不提交（否则空答白白消耗作答机会 + 属于伪造完成）。
                this._clickWithVerification(picked, (clickErr) => {
                    if (clickErr) {
                        console.warn('%c[LLM] 互动题选项点击未生效（' + clickErr.message + '）：已跳过提交，保留作答机会等下一轮重试', 'color:#FF9800');
                        this._llmLastQuestionKey = '';   // 清掉去重键，允许下一轮对同一题重试
                        return;
                    }
                    console.log('%c[LLM] 已选择答案 ' + answer + '（' + picked.map((c) => String(c.text || '').slice(0, 20)).join(' / ') + '）', 'color:#9C27B0');
                    if (!submitEl) return;   // 无提交按钮：诊断已打印、答案已选好，交人工提交
                    if (!this.configs.llmAutoSubmit) {
                        console.log('%c[LLM] 半自动模式：答案已选好，请人工点击「提交/继续」；如需自动提交请开启 llmAutoSubmit', 'color:#607D8B');
                        return;
                    }
                    const delay = 500 + Math.floor(Math.random() * 1000);
                    this._schedule(() => {
                        try {
                            submitEl.click();
                            console.log('%c[LLM] 已自动点击提交/继续按钮', 'color:#9C27B0');
                        } catch (e) {
                            console.warn('%c[LLM] 提交按钮点击失败，请手动提交', 'color:#FF9800');
                        }
                    }, delay);
                });
            },
            _findInteractionSubmit(found) {
                // F39：放宽提交/继续按钮识别 —— 兼容 class 含 submit/btn 的 div/span 与「提交答案/继续播放」等文案。
                const scope = found && found.el;
                if (!scope || !scope.querySelectorAll) return null;
                const selectors = [
                    '.submitBtn', '[class*="submit"]', '[class*="Submit"]',
                    '[class*="answer"] [class*="btn"]', '[class*="question"] [class*="btn"]',
                    'button', 'a', '[class*="btn"]',
                ];
                const words = /(提交|继续|确定|完成|下一题|知道了|开始播放)/;
                const search = (root) => {
                    if (!root || !root.querySelectorAll) return null;
                    for (const sel of selectors) {
                        let nodes = [];
                        try { nodes = Array.from(root.querySelectorAll(sel)); } catch (e) { nodes = []; }
                        for (const node of nodes) {
                            if (node === scope) continue;
                            const t = String(node.textContent || node.value || '').replace(/\s+/g, '');
                            if (t && t.length <= 12 && words.test(t)) return node;
                        }
                    }
                    return null;
                };
                return search(scope) || (scope.parentElement ? search(scope.parentElement) : null);
            },
            _extractInteractionOptions(nodes) {
                const optionRe = /^[A-H][、.．:：\s]|^(对|错|正确|错误)\s*$/;
                const out = [];
                const list = Array.from(nodes || []);
                for (const node of list) {
                    const t = String(node.textContent || node.value || '').replace(/\s+/g, ' ').trim();
                    if (!t || t.length > 60) continue;
                    if (!optionRe.test(t)) continue;
                    if (out.some((o) => o.text === t)) continue;
                    let letter = '';
                    const m = t.match(/^([A-H])[、.．:：\s]/);
                    if (m) letter = m[1];
                    else if (/^(对|正确)\s*$/.test(t)) letter = 'A';
                    else if (/^(错|错误)\s*$/.test(t)) letter = 'B';
                    out.push({ el: node, text: t, letter: letter });
                    if (out.length >= 8) break;
                }
                return out;
            },
            // ================= F10（V3.5，实验性）：章节测验建议答案（仅面板提示，绝不自动点击） =================
            _collectChapterTestQuestions() {
                const out = [];
                if (typeof document === 'undefined' || !document.querySelectorAll) return out;
                let boxes = [];
                try {
                    boxes = Array.from(document.querySelectorAll('.TiMu, [class*="TiMu"], .questionLi, [class*="questionLi"]'));
                } catch (e) { boxes = []; }
                for (const box of boxes) {
                    if (out.length >= 10) break;
                    try {
                        if (!this._isVisible(box)) continue;
                    } catch (e) { /* ignore */ }
                    let titleEl = null;
                    try { titleEl = box.querySelector('.Zy_TItle, .tiTitle, [class*="TiMu"] .fl, [class*="title"]'); } catch (e) { titleEl = null; }
                    const question = String((titleEl && titleEl.textContent) || box.textContent || '').replace(/\s+/g, ' ').trim();
                    if (question.length < 4) continue;
                    let optionNodes = [];
                    try { optionNodes = Array.from(box.querySelectorAll('.Zy_ulTop li, .answerList li, ul li, label')); } catch (e) { optionNodes = []; }
                    const options = [];
                    for (const node of optionNodes) {
                        const t = String(node.textContent || '').replace(/\s+/g, ' ').trim();
                        if (!t || t.length > 80) continue;
                        if (t === question) continue;
                        if (options.some((o) => o.text === t)) continue;
                        options.push({ el: node, text: t, letter: String.fromCharCode(65 + options.length) });
                        if (options.length >= 8) break;
                    }
                    if (options.length < 2) continue;
                    const key = question.slice(0, 100);
                    if (out.some((q) => q.key === key)) continue;
                    out.push({ box: box, question: question, options: options, key: key });
                }
                return out;
            },
            _maybeSuggestChapterTest() {
                if (!this.configs.llmChapterTest || !this.configs.llmEnabled) return false;
                if (this._llmChapterSuggesting || this._llmChapterSuggestDone) return true;
                if (!this._llmApiKey) {
                    console.warn('%c[LLM] llmChapterTest 已开启但未配置 API Key：维持默认「受限跳过」章节测验行为', 'color:#FF9800');
                    return false;
                }
                const questions = this._collectChapterTestQuestions();
                if (!questions.length) {
                    console.warn('%c[LLM] 章节测验页未识别出题目结构（实验性功能，需实机采样校准），维持默认跳过行为', 'color:#FF9800');
                    return false;
                }
                this._llmChapterSuggesting = true;
                console.log('%c[LLM] 章节测验：识别到 ' + questions.length + ' 道题，将逐题在面板给出建议答案（本版不会自动点击，请人工确认提交）', 'color:#9C27B0');
                this._askChapterTestQuestions(questions, 0);
                return true;
            },
            _askChapterTestQuestions(queue, index) {
                if (!queue || index >= queue.length) {
                    this._llmChapterSuggesting = false;
                    this._llmChapterSuggestDone = true;
                    console.log('%c[LLM] 章节测验建议已全部给出：请核对后手工作答并提交；本版不会自动点击测验选项', 'color:#4CAF50');
                    this._guiRefreshStatus(true);
                    return;
                }
                if (this._llmInFlight) {
                    this._schedule(() => this._askChapterTestQuestions(queue, index), 1000);
                    return;
                }
                const item = queue[index];
                this._llmRequest(
                    this._llmBuildPayload(this._llmBuildMessages(item.question, item.options)),
                    (text) => {
                        const answer = this._llmExtractAnswer(text);
                        const chosen = this._llmPickOption(item.options, answer);
                        this._llmChapterSuggestedCount++;
                        this._llmLastAnswer = { q: item.question.slice(0, 40), a: (answer || '解析失败') };
                        console.log('%c[章节测验建议 ' + (index + 1) + '/' + queue.length + '] ' + item.question.slice(0, 60) + ' → ' + (answer || '解析失败')
                            + (chosen ? '（对应选项：' + String(chosen.text || '').slice(0, 30) + '）' : ''), 'color:#9C27B0');
                        this._guiRefreshStatus(true);
                        this._askChapterTestQuestions(queue, index + 1);
                    },
                    (err) => {
                        console.warn('%c[章节测验建议] 第 ' + (index + 1) + ' 题请求失败：' + (err && err.message ? err.message : String(err)), 'color:#FF9800');
                        this._askChapterTestQuestions(queue, index + 1);
                    }
                );
            },
            // ================= F11（V3.6）：内嵌章节测验/作业（work）自动作答 =================
            _findUnfinishedWorks() {
                const found = [];
                const seen = new Set();
                const visit = (doc, depth) => {
                    if (!doc || depth > 6 || seen.has(doc)) return;
                    seen.add(doc);
                    let frames = [];
                    try { frames = Array.from(doc.querySelectorAll('iframe, frame')); } catch (e) { frames = []; }
                    for (const frame of frames) {
                        let jobid = '';
                        try { jobid = frame.getAttribute ? String(frame.getAttribute('jobid') || '') : ''; } catch (e) { jobid = ''; }
                        let childDoc = null;
                        try { childDoc = frame.contentDocument || (frame.contentWindow ? frame.contentWindow.document : null); } catch (e) { childDoc = null; }
                        if (jobid && jobid.indexOf('work-') === 0) {
                            let holder = null;
                            try { holder = frame.closest ? frame.closest('.ans-attach-ct') : null; } catch (e) { holder = null; }
                            let finished = false;
                            try { finished = holder ? holder.classList.contains('ans-job-finished') : false; } catch (e) { finished = false; }
                            let data = {};
                            try { data = JSON.parse(frame.getAttribute('data') || '{}'); } catch (e) { data = {}; }
                            found.push({ frame: frame, holder: holder, finished: finished, jobid: jobid, title: data.title || '', worktype: data.worktype || '' });
                            continue;
                        }
                        if (childDoc) visit(childDoc, depth + 1);
                    }
                };
                visit(typeof document === 'undefined' ? null : document, 0);
                return found;
            },
            _hasUnfinishedEmbeddedWork() {
                try { return this._findUnfinishedWorks().some((w) => !w.finished); } catch (e) { return false; }
            },
            _quizDocOf(workFrame) {
                // F43（V3.6 补丁）：作业模块是「work 模块 iframe → doHomeWorkNew iframe」两层结构，
                // 以前只在第一层找 .TiMu/textarea，导致「未能定位测验内容」而停止（真机：术中外科并发症）。
                const findQuiz = (doc, depth) => {
                    if (!doc || depth > 4) return null;
                    try {
                        if (doc.querySelector && (doc.querySelector('.TiMu') || doc.querySelector('textarea[id^="answer"]'))) {
                            return { doc: doc, win: doc.defaultView, frame: null };
                        }
                    } catch (e) { /* ignore */ }
                    let frames = [];
                    try { frames = Array.from(doc.querySelectorAll('iframe, frame')); } catch (e) { frames = []; }
                    for (const f of frames) {
                        let child = null;
                        try { child = f.contentDocument || (f.contentWindow ? f.contentWindow.document : null); } catch (e) { child = null; }
                        if (!child) continue;
                        const hit = findQuiz(child, depth + 1);
                        if (hit) { hit.frame = f; return hit; }
                    }
                    return null;
                };
                let base = null;
                try { base = workFrame.contentDocument || (workFrame.contentWindow ? workFrame.contentWindow.document : null); } catch (e) { base = null; }
                if (!base) return null;
                return findQuiz(base, 0);
            },
            // ================= F17（V3.6）：font-cxsecret 字形解密 =================
            // 原理：平台用「思源黑体子集」做反copy字体（乱码 codepoint → 真实字形）。系统装有 Noto Sans SC
            // （与思源黑体同一套字形设计），把乱码字与全 CJK 候选用同尺寸渲染做墨迹归一化位图匹配即可还原明文。
            // 真机验证：媕媑媒媖媓媔念 → 简析版画的概念（与已知明文完全一致，字面得分 0）。
            _md5Hex(input) {
                // F34：紧凑 MD5（输入按 latin1 处理；字形哈希输入只含数字/负号，无编码问题）。
                const s = String(input == null ? '' : input);
                const bytes = [];
                for (let i = 0; i < s.length; i++) {
                    const c = s.charCodeAt(i);
                    bytes.push(c & 0xff);
                    if (c > 0xff) bytes.push((c >> 8) & 0xff);
                }
                const bitLen = bytes.length * 8;
                bytes.push(0x80);
                while (bytes.length % 64 !== 56) bytes.push(0);
                const lenLo = bitLen >>> 0;
                const lenHi = Math.floor(bitLen / 0x100000000) >>> 0;
                bytes.push(lenLo & 0xff, (lenLo >>> 8) & 0xff, (lenLo >>> 16) & 0xff, (lenLo >>> 24) & 0xff);
                bytes.push(lenHi & 0xff, (lenHi >>> 8) & 0xff, (lenHi >>> 16) & 0xff, (lenHi >>> 24) & 0xff);
                const K = [];
                for (let i = 0; i < 64; i++) K.push(Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);
                const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
                    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
                    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
                    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
                const rotl = (x, c) => ((x << c) | (x >>> (32 - c))) >>> 0;
                let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
                for (let off = 0; off < bytes.length; off += 64) {
                    const M = new Array(16);
                    for (let i = 0; i < 16; i++) {
                        M[i] = (bytes[off + i * 4] | (bytes[off + i * 4 + 1] << 8) | (bytes[off + i * 4 + 2] << 16) | (bytes[off + i * 4 + 3] << 24)) >>> 0;
                    }
                    let A = a0, B = b0, C = c0, D = d0;
                    for (let i = 0; i < 64; i++) {
                        let F, g;
                        if (i < 16) { F = (B & C) | (~B & D); g = i; }
                        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
                        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
                        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
                        F = (F + A + K[i] + M[g]) >>> 0;
                        A = D; D = C; C = B;
                        B = (B + rotl(F, S[i])) >>> 0;
                    }
                    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
                }
                const hex = (n) => {
                    let out = '';
                    for (let i = 0; i < 4; i++) out += ('0' + ((n >>> (i * 8)) & 0xff).toString(16)).slice(-2);
                    return out;
                };
                return hex(a0) + hex(b0) + hex(c0) + hex(d0);
            },
            _cxB64ToBytes(b64) {
                try {
                    const bin = atob(String(b64 || ''));
                    const bytes = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
                    return bytes;
                } catch (e) {
                    return null;
                }
            },
            _cxFontHashMap() {
                // F34：window.__XT_FONT_MAP_B64 = 每条 18 字节（16B MD5 + 2B 字符码，大端）的 base64。
                if (this._cxFontHashTable) return this._cxFontHashTable;
                let b64 = '';
                try { b64 = (typeof window !== 'undefined' && window.__XT_FONT_MAP_B64) || ''; } catch (e) { b64 = ''; }
                if (!b64) return null;
                try {
                    const bin = atob(b64);
                    const map = new Map();
                    for (let i = 0; i + 17 < bin.length; i += 18) {
                        let hash = '';
                        for (let j = 0; j < 16; j++) hash += ('0' + bin.charCodeAt(i + j).toString(16)).slice(-2);
                        const code = (bin.charCodeAt(i + 16) << 8) | bin.charCodeAt(i + 17);
                        if (code) map.set(hash, String.fromCharCode(code));
                    }
                    this._cxFontHashTable = map;
                    return map;
                } catch (e) {
                    return null;
                }
            },
            async _cxInflate(bytes) {
                try {
                    const ds = new DecompressionStream('deflate');
                    const stream = new Blob([bytes]).stream().pipeThrough(ds);
                    const ab = await new Response(stream).arrayBuffer();
                    return new Uint8Array(ab);
                } catch (e) {
                    return null;
                }
            },
            async _cxWoffToSfnt(buf) {
                // F34：WOFF 解包（上游字体常为 WOFF；Chrome 用 DecompressionStream 解 zlib）。
                if (typeof DecompressionStream === 'undefined') return null;
                const u16 = (o) => (buf[o] << 8) | buf[o + 1];
                const u32 = (o) => ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0;
                const numTables = u16(12);
                const tables = [];
                for (let i = 0; i < numTables; i++) {
                    const off = 44 + i * 20;
                    const tag = String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
                    const offset = u32(off + 4);
                    const compLength = u32(off + 8);
                    const origLength = u32(off + 12);
                    let data;
                    if (compLength < origLength) {
                        data = await this._cxInflate(buf.slice(offset, offset + compLength));
                        if (!data) return null;
                    } else {
                        data = buf.slice(offset, offset + compLength);
                    }
                    tables.push({ tag: tag, data: data });
                }
                const n = tables.length;
                let searchRange = 1, entrySelector = 0;
                while (searchRange * 2 <= n) { searchRange *= 2; entrySelector++; }
                searchRange *= 16;
                const headerLen = 12 + n * 16;
                const outLen = headerLen + tables.reduce((s, t) => s + t.data.length + ((4 - (t.data.length % 4)) % 4), 0);
                const out = new Uint8Array(outLen);
                out[0] = 0; out[1] = 1; out[2] = 0; out[3] = 0;
                out[4] = (n >> 8) & 0xff; out[5] = n & 0xff;
                out[6] = (searchRange >> 8) & 0xff; out[7] = searchRange & 0xff;
                out[8] = (entrySelector >> 8) & 0xff; out[9] = entrySelector & 0xff;
                out[10] = (((n * 16 - searchRange) >> 8) & 0xff); out[11] = ((n * 16 - searchRange) & 0xff);
                let dataOff = headerLen;
                for (let i = 0; i < n; i++) {
                    const rec = 12 + i * 16;
                    const tag = tables[i].tag;
                    out[rec] = tag.charCodeAt(0); out[rec + 1] = tag.charCodeAt(1); out[rec + 2] = tag.charCodeAt(2); out[rec + 3] = tag.charCodeAt(3);
                    out[rec + 4] = 0; out[rec + 5] = 0; out[rec + 6] = 0; out[rec + 7] = 0;
                    out[rec + 8] = (dataOff >>> 24) & 0xff; out[rec + 9] = (dataOff >>> 16) & 0xff; out[rec + 10] = (dataOff >>> 8) & 0xff; out[rec + 11] = dataOff & 0xff;
                    const len = tables[i].data.length;
                    out[rec + 12] = (len >>> 24) & 0xff; out[rec + 13] = (len >>> 16) & 0xff; out[rec + 14] = (len >>> 8) & 0xff; out[rec + 15] = len & 0xff;
                    out.set(tables[i].data, dataOff);
                    dataOff += len + ((4 - (len % 4)) % 4);
                }
                return out;
            },
            _cxParseSfnt(buf) {
                try {
                    const u16 = (o) => (buf[o] << 8) | buf[o + 1];
                    const i16 = (o) => { const v = u16(o); return v >= 0x8000 ? v - 0x10000 : v; };
                    const u32 = (o) => ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0;
                    const numTables = u16(4);
                    const tables = {};
                    for (let i = 0; i < numTables; i++) {
                        const off = 12 + i * 16;
                        const tag = String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
                        tables[tag] = { offset: u32(off + 8), length: u32(off + 12) };
                    }
                    if (!tables.head || !tables.maxp || !tables.loca || !tables.glyf || !tables.cmap) return null;
                    const indexToLocFormat = i16(tables.head.offset + 50);
                    const numGlyphs = u16(tables.maxp.offset + 4);
                    const locaOffsets = [];
                    for (let i = 0; i < numGlyphs + 1; i++) {
                        locaOffsets.push(indexToLocFormat === 0 ? u16(tables.loca.offset + i * 2) * 2 : u32(tables.loca.offset + i * 4));
                    }
                    const cmap = new Map();
                    const cm = tables.cmap.offset;
                    const nSub = u16(cm + 2);
                    for (let i = 0; i < nSub; i++) {
                        const rec = cm + 4 + i * 8;
                        const subOff = cm + u32(rec + 4);
                        const format = u16(subOff);
                        if (format === 4) {
                            const segCount = u16(subOff + 6) / 2;
                            const endBase = subOff + 14;
                            const startBase = endBase + segCount * 2 + 2;
                            const deltaBase = startBase + segCount * 2;
                            const rangeBase = deltaBase + segCount * 2;
                            for (let s = 0; s < segCount; s++) {
                                const end = u16(endBase + s * 2), start = u16(startBase + s * 2);
                                const delta = i16(deltaBase + s * 2), rangeOff = u16(rangeBase + s * 2);
                                for (let c = start; c <= end && c !== 0xFFFF; c++) {
                                    let gid;
                                    if (rangeOff === 0) gid = (c + delta) & 0xFFFF;
                                    else {
                                        const gi = rangeBase + s * 2 + rangeOff + (c - start) * 2;
                                        if (gi + 1 >= buf.length) continue;
                                        gid = u16(gi);
                                        if (gid) gid = (gid + delta) & 0xFFFF;
                                    }
                                    if (gid) cmap.set(c, gid);
                                }
                            }
                        } else if (format === 12) {
                            const nGroups = u32(subOff + 12);
                            for (let g = 0; g < nGroups; g++) {
                                const base = subOff + 16 + g * 12;
                                const startChar = u32(base), endChar = u32(base + 4), startGid = u32(base + 8);
                                for (let c = startChar; c <= endChar; c++) cmap.set(c, startGid + (c - startChar));
                            }
                        }
                    }
                    return { buf: buf, tables: tables, locaOffsets: locaOffsets, numGlyphs: numGlyphs, cmap: cmap };
                } catch (e) {
                    return null;
                }
            },
            _cxGlyphHash(font, gid) {
                // F34：上游 hash_glyph —— 逐点拼接 "x{y}{flag&1}" 后取 MD5；复合/空字形跳过。
                try {
                    const buf = font.buf;
                    const u16 = (o) => (buf[o] << 8) | buf[o + 1];
                    const i16 = (o) => { const v = u16(o); return v >= 0x8000 ? v - 0x10000 : v; };
                    const start = font.locaOffsets[gid], end = font.locaOffsets[gid + 1];
                    if (end <= start) return '';
                    let p = font.tables.glyf.offset + start;
                    const numberOfContours = i16(p); p += 2;
                    if (numberOfContours <= 0) return '';
                    p += 8;
                    const endPts = [];
                    for (let i = 0; i < numberOfContours; i++) { endPts.push(u16(p)); p += 2; }
                    const instrLen = u16(p); p += 2 + instrLen;
                    const totalPts = endPts[endPts.length - 1] + 1;
                    const flags = [];
                    while (flags.length < totalPts) {
                        const f = buf[p]; p += 1;
                        flags.push(f);
                        if (f & 0x08) { let rep = buf[p]; p += 1; while (rep-- > 0 && flags.length < totalPts) flags.push(f); }
                    }
                    const xs = []; let x = 0;
                    for (let i = 0; i < totalPts; i++) {
                        const f = flags[i];
                        if (f & 0x02) { const d = buf[p]; p += 1; x += (f & 0x10) ? d : -d; }
                        else if (!(f & 0x10)) { const d = i16(p); p += 2; x += d; }
                        xs.push(x);
                    }
                    const ys = []; let y = 0;
                    for (let i = 0; i < totalPts; i++) {
                        const f = flags[i];
                        if (f & 0x04) { const d = buf[p]; p += 1; y += (f & 0x20) ? d : -d; }
                        else if (!(f & 0x20)) { const d = i16(p); p += 2; y += d; }
                        ys.push(y);
                    }
                    let posData = '';
                    let last = 0;
                    for (let c = 0; c < numberOfContours; c++) {
                        const endPoint = endPts[c];
                        for (let j = last; j <= endPoint; j++) posData += String(xs[j]) + String(ys[j]) + String(flags[j] & 0x01);
                        last = endPoint + 1;
                    }
                    return this._md5Hex(posData);
                } catch (e) {
                    return '';
                }
            },
            async _cxFontFromB64(b64) {
                const bytes = this._cxB64ToBytes(b64);
                if (!bytes || bytes.length < 12) return null;
                let buf = bytes;
                const sig = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
                if (sig === 'wOFF') {
                    buf = await this._cxWoffToSfnt(buf);
                    if (!buf) return null;
                }
                return this._cxParseSfnt(buf);
            },
            _kxRadicalTable() {
                // F42：移植上游 KX_RADICALS_TAB（康熙部首 → 常规汉字）。缺这一步，解密文本会残留
                // ⽛/⼒/⼆/⻣ 之类的部首字（上游 decrypt 末尾有此替换表）。
                if (this._kxRadicals) return this._kxRadicals;
                const from = "⼀⼁⼂⼃⼄⼅⼆⼇⼈⼉⼊⼋⼌⼍⼎⼏⼐⼑⼒⼓⼔⼕⼖⼗⼘⼙⼚⼛⼜⼝⼞⼟⼠⼡⼢⼣⼤⼥⼦⼧⼨⼩⼪⼫⼬⼭⼮⼯⼰⼱⼲⼳⼴⼵⼶⼷⼸⼹⼺⼻⼼⼽⼾⼿⽀⽁⽂⽃⽄⽅⽆⽇⽈⽉⽊⽋⽌⽍⽎⽏⽐⽑⽒⽓⽔⽕⽖⽗⽘⽙⽚⽛⽜⽝⽞⽟⽠⽡⽢⽣⽤⽥⽦⽧⽨⽩⽪⽫⽬⽭⽮⽯⽰⽱⽲⽳⽴⽵⽶⽷⽸⽹⽺⽻⽼⽽⽾⽿⾀⾁⾂⾃⾄⾅⾆⾇⾈⾉⾊⾋⾌⾍⾎⾏⾐⾑⾒⾓⾔⾕⾖⾗⾘⾙⾚⾛⾜⾝⾞⾟⾠⾡⾢⾣⾤⾥⾦⾧⾨⾩⾪⾫⾬⾭⾮⾯⾰⾱⾲⾳⾴⾵⾶⾷⾸⾹⾺⾻⾼髙⾽⾾⾿⿀⿁⿂⿃⿄⿅⿆⿇⿈⿉⿊⿋⿌⿍⿎⿏⿐⿑⿒⿓⿔⿕⺠⻬⻩⻢⻜⻅⺟⻓";
                const to = "一丨丶丿乙亅二亠人儿入八冂冖冫几凵刀力勹匕匚匸十卜卩厂厶又口囗土士夂夊夕大女子宀寸小尢尸屮山巛工己巾干幺广廴廾弋弓彐彡彳心戈戶手支攴文斗斤方无日曰月木欠止歹殳毋比毛氏气水火爪父爻爿片牙牛犬玄玉瓜瓦甘生用田疋疒癶白皮皿目矛矢石示禸禾穴立竹米糸缶网羊羽老而耒耳聿肉臣自至臼舌舛舟艮色艸虍虫血行衣襾見角言谷豆豕豸貝赤走足身車辛辰辵邑酉采里金長門阜隶隹雨青非面革韋韭音頁風飛食首香馬骨高高髟鬥鬯鬲鬼魚鳥鹵鹿麥麻黃黍黑黹黽鼎鼓鼠鼻齊齒龍龜龠民齐黄马飞见母长";
                const map = Object.create(null);
                for (let i = 0; i < from.length; i++) {
                    if (to[i]) map[from[i]] = to[i];
                }
                this._kxRadicals = map;
                return map;
            },
            _cxApplyKxRadicals(text) {
                const map = this._kxRadicalTable();
                const s = String(text == null ? '' : text);
                let out = '';
                for (const ch of s) out += (map[ch] || ch);
                return out;
            },
            async _cxFontDecodeChars(b64, chars) {
                // F42：支持多字体（b64 可为字符串或数组）——逐字体尝试，直到命中。
                const table = this._cxFontHashMap();
                const fontsB64 = (Array.isArray(b64) ? b64 : [b64]).filter(Boolean);
                if (!table || !fontsB64.length) return null;
                const fonts = [];
                for (const one of fontsB64) {
                    const f = await this._cxFontFromB64(one);
                    if (f) fonts.push(f);
                }
                if (!fonts.length) return null;
                const map = {};
                let hit = 0;
                const unresolved = [];
                const list = Array.isArray(chars) ? chars : Array.from(String(chars || ''));
                for (const ch of list) {
                    let real = null;
                    let hasGlyph = false;
                    for (const font of fonts) {
                        const gid = font.cmap.get(ch.charCodeAt(0));
                        if (gid == null) continue;                 // 该字不在混淆字体里 = 正常汉字，跳过
                        const hash = this._cxGlyphHash(font, gid);
                        if (!hash) continue;
                        hasGlyph = true;                            // 确实用混淆字体渲染
                        const found = table.get(hash);
                        if (found) { real = found; break; }
                    }
                    if (real && real !== ch) { map[ch] = this._cxApplyKxRadicals(real); hit++; }
                    // F49：有字形却没解出来 = 真乱码信号（与"正常汉字未命中"严格区分）
                    else if (hasGlyph) unresolved.push(ch);
                }
                return { map: map, hit: hit, total: list.length, unresolved: unresolved, font: fonts[0] };
            },
            _cxSecretFontsB64() {
                // F54（V3.7）：累积式收集 —— 同时修两个相反方向的问题：
                //   (1) 旧写法「if (this._cxFontsB64) return this._cxFontsB64;」是永久缓存：题目按组 AJAX 注入时
                //       新出现的 font-cxsecret 字体子集再也收不进来，该组混淆字的 gid 查不到 → 被当"正常汉字"
                //       原样保留（真机：2026-09-14T14-17-49 的 Q2「惵惫瑝參蠢惴惮」/Q3「惸烈的辩惫中需惴先亮瑆观点」）。
                //   (2) 反过来也不能"每次重扫即覆盖"：实测 font-cxsecret 规则是瞬态的，切走题目组后 DOM 里
                //       一条都不剩（tmp-verify/probe-font-stale.mjs：cachedFonts=1 / domFonts=0），覆盖会丢字体。
                // 因此取并集：保留历史收集到的，追加本次新发现的，永不收缩。
                const found = this._cxCollectFontsB64();
                const prev = Array.isArray(this._cxFontsB64) ? this._cxFontsB64 : [];
                const merged = prev.slice();
                for (const b of found) if (merged.indexOf(b) < 0) merged.push(b);
                if (merged.length !== prev.length) {
                    console.log('%c[字库解密] font-cxsecret 字体累积：本次扫到 ' + found.length
                        + ' 个，新增 ' + (merged.length - prev.length) + ' 个，合计 ' + merged.length + ' 个', 'color:#607D8B');
                }
                this._cxFontsB64 = merged;
                return merged;
            },
            _cxCollectFontsB64() {
                // F42（V3.6 补丁）：页面可能有多个 font-cxsecret 字体（不同题组不同子集）；
                // 只取第一个会导致部分字解密失败/命中率低。这里全部收集并去重。
                const out = [];
                const seenDocs = new Set();
                const visit = (doc, depth) => {
                    if (!doc || depth > 6 || seenDocs.has(doc)) return;
                    seenDocs.add(doc);
                    try {
                        for (const sheet of Array.from(doc.styleSheets || [])) {
                            try {
                                for (const rule of Array.from(sheet.cssRules || [])) {
                                    const t = rule.cssText || '';
                                    if (t.indexOf('font-cxsecret') >= 0 && t.indexOf('base64,') >= 0) {
                                        const data = t.split('base64,')[1].split('"')[0].split(')')[0];
                                        if (data && out.indexOf(data) < 0) out.push(data);
                                    }
                                }
                            } catch (e) { /* 跨域样式表 */ }
                        }
                    } catch (e) { /* ignore */ }
                    try {
                        for (const f of doc.querySelectorAll('iframe, frame')) {
                            let d = null;
                            try { d = f.contentDocument; } catch (e) { d = null; }
                            if (d) visit(d, depth + 1);
                        }
                    } catch (e) { /* ignore */ }
                };
                visit(typeof document === 'undefined' ? null : document, 0);
                return out;
            },
            _cxSecretFontB64() {
                const list = this._cxSecretFontsB64();
                return list.length ? list[0] : '';
            },
            _cxSecretDecode(texts, cb) {
                const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t == null ? '' : t));
                this._cxLastUnresolved = [];   // F49：本次解密的"未解出混淆字"清单
                const done = (out) => { try { cb(out); } catch (e) { console.error('[字库解密] 回调失败:', e); } };
                if (!this.configs.cxSecretDecode) { done(list); return; }
                const chars = [];
                for (const t of list) {
                    for (const ch of t) {
                        const c = ch.charCodeAt(0);
                        if (c >= 0x4e00 && c <= 0x9fa5 && chars.indexOf(ch) < 0) chars.push(ch);
                    }
                }
                if (!chars.length) { done(list); return; }
                const cached = this._cxSecretMap || (this._cxSecretMap = {});
                const todo = chars.filter((ch) => !Object.prototype.hasOwnProperty.call(cached, ch));
                const finish = () => done(list.map((t) => this._cxApplyKxRadicals(t.replace(/[\u4e00-\u9fa5]/g, (ch) => (Object.prototype.hasOwnProperty.call(cached, ch) ? cached[ch] : ch)))));
                if (!todo.length) { finish(); return; }
                const fontList = this._cxSecretFontsB64();
                const b64 = fontList[0] || '';
                if (!b64) { console.warn('%c[字库解密] 未找到 font-cxsecret 字体，跳过解码', 'color:#FF9800'); finish(); return; }
                // F47：run 可指定"只解密这批字"（哈希命中后仅对未命中的字做位图回退）
                const run = (charList) => {
                    try {
                        const R = 48, SIZE = 32;
                        const canvas = document.createElement('canvas');
                        canvas.width = canvas.height = R;
                        const ctx = canvas.getContext('2d', { willReadFrequently: true });
                        if (!ctx) { console.warn('%c[字库解密] 当前环境无 Canvas，跳过解码', 'color:#FF9800'); finish(); return; }
                        const bmp = (ch, family) => {
                            ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, R, R);
                            ctx.fillStyle = '#000'; ctx.font = '40px "' + family + '"';
                            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                            ctx.fillText(ch, R / 2, R / 2 + 1);
                            const img = ctx.getImageData(0, 0, R, R).data;
                            let minX = R, minY = R, maxX = -1, maxY = -1;
                            for (let y = 0; y < R; y++) {
                                for (let x = 0; x < R; x++) {
                                    if (img[(y * R + x) * 4] < 128) {
                                        if (x < minX) minX = x;
                                        if (x > maxX) maxX = x;
                                        if (y < minY) minY = y;
                                        if (y > maxY) maxY = y;
                                    }
                                }
                            }
                            if (maxX < 0) return null;
                            const w = maxX - minX + 1, h = maxY - minY + 1;
                            const out = new Float32Array(SIZE * SIZE);
                            for (let y = 0; y < SIZE; y++) {
                                for (let x = 0; x < SIZE; x++) {
                                    const sx = minX + Math.min(w - 1, Math.floor((x + 0.5) * w / SIZE));
                                    const sy = minY + Math.min(h - 1, Math.floor((y + 0.5) * h / SIZE));
                                    out[y * SIZE + x] = img[(sy * R + sx) * 4] < 128 ? 1 : 0;
                                }
                            }
                            return out;
                        };
                        let cands = (typeof window !== 'undefined' && window.__xtCxCands) || null;
                        if (!cands) {
                            cands = [];
                            for (let cp = 0x4e00; cp <= 0x9fa5; cp++) {
                                const ch = String.fromCharCode(cp);
                                const b = bmp(ch, 'Noto Sans SC');
                                if (b) cands.push({ ch: ch, b: b });
                            }
                            if (typeof window !== 'undefined') window.__xtCxCands = cands;
                        }
                        const matched = [];
                        const unresolved = [];
                        const queue = (charList && charList.length) ? charList : todo;
                        for (const ch of queue) {
                            const tb = bmp(ch, 'xt_cxsecret');
                            // F47：渲染不出字形 = cxsecret 字体尚未就绪 → **绝不能**把 ch→ch 写进缓存
                            // （旧实现会永久毒化 _cxSecretMap，导致这些字以后再也不尝试解密）
                            if (!tb) { unresolved.push(ch); continue; }
                            let best = '', bs = Infinity;
                            for (const c of cands) {
                                let d = 0;
                                for (let i = 0; i < SIZE * SIZE; i++) {
                                    const diff = tb[i] - c.b[i];
                                    if (diff) d += diff * diff;
                                }
                                if (d < bs) { bs = d; best = c.ch; }
                            }
                            cached[ch] = best || ch;
                            matched.push(ch + '→' + cached[ch]);
                        }
                        const real = matched.filter((m) => m.split('→')[0] !== m.split('→')[1]);
                        if (matched.length) console.log('%c[字库解密] 位图匹配 ' + matched.length + ' 字（其中真实改写 ' + real.length + ' 字）：' + matched.slice(0, 20).join(' '), 'color:#4CAF50');
                        if (unresolved.length) console.warn('%c[字库解密] ' + unresolved.length + ' 个字未能渲染字形（cxsecret 字体未就绪）→ 不写缓存，留待下次：' + unresolved.slice(0, 12).join(''), 'color:#FF9800');
                        finish();
                    } catch (e) { console.warn('%c[字库解密] 失败：' + (e && e.message ? e.message : e), 'color:#FF9800'); finish(); }
                };
                // F34：优先 glyf 哈希解密（上游算法，确定性 + 无系统字体依赖）；未命中则回退位图。
                if (String(this.configs.cxSecretFontMode || 'auto') !== 'bitmap' && this._cxFontHashMap()) {
                    const self = this;
                    this._cxFontDecodeChars(fontList, chars).then((res) => {
                        let hit = 0;
                        if (res && res.map) {
                            for (const k in res.map) {
                                if (Object.prototype.hasOwnProperty.call(res.map, k)) { cached[k] = res.map[k]; hit++; }
                            }
                        }
                        if (hit > 0) console.log('%c[字库解密] glyf 哈希命中 ' + hit + '/' + (res.total || chars.length) + ' 字（上游 Samueli924/chaoxing 算法）', 'color:#4CAF50');
                        this._cxLastUnresolved = (res && res.unresolved) || [];   // F49：供提交前置校验使用
                        // F47e（严格对齐上游 cxsecret_font.py::decrypt）：
                        //   上游只做一件事 —— 哈希命中即替换，未命中的字符**原样保留**（哈希表里只有
                        //   "被混淆字→真字" 的映射，"判断题/作/种/高/动/对/错" 这类正常汉字本来就不在表里）。
                        //   此处**不做任何位图兜底**：那既不是上游实现，又会在 FontFace 不 settle 时
                        //   把整条作答链挂死（真机卡死根因，已回退）。
                        finish();
                        const rest = chars.filter((ch) => !(res && res.map && Object.prototype.hasOwnProperty.call(res.map, ch)));
                        if (rest.length) {
                            console.log('%c[字库解密] 未命中 ' + rest.length + ' 字（正常汉字，按上游行为原样保留）：' + rest.slice(0, 16).join(''), 'color:#607D8B');
                        }
                    }).catch(() => { finish(); });
                    return;
                }
                // F47：位图回退前必须确保 cxsecret 字体已加载（旧实现只在非哈希分支加载，
                // 导致哈希分支回退时 bmp() 渲染不出字形）
                // F47b：字体加载加超时兜底 —— FontFace.load() 在字体数据异常时可能既不 resolve 也不 reject
                //（真机：回退路径静默悬挂，页面无日志但主线程空闲），超时也继续用位图匹配（画布会退回系统字体）。
                const loadFontOnce = (next) => {
                    if (this._cxFontLoaded || typeof FontFace === 'undefined' || !document.fonts) { next(''); return; }
                    let settled = false;
                    const go = (why) => {
                        if (settled) return;
                        settled = true;
                        if (why) console.warn('%c[字库解密] cxsecret 字体加载' + why + '，仍继续位图匹配', 'color:#FF9800');
                        next(why);
                    };
                    // F47c：硬兜底用**页面原生 setTimeout**，不用 app._schedule ——
                    // 真机实测：app 的定时器注册表可能被运行中的流程清掉，导致这里的超时永不触发、
                    // 整条回退路径静默悬挂（现象：cands=null、fontLoaded=false、无任何日志）。
                    const timer = setTimeout(() => go('超时（3 秒）'), 3000);
                    // 仍按项目定时器契约登记到 _timers：destroy() 时能被清理，
                    // 且满足对抗套件 H1 的静态审计（setTimeout 调用点必须登记）
                    try { if (!this._timers) this._timers = new Set(); this._timers.add(timer); } catch (e) { /* ignore */ }
                    try {
                        const ff = new FontFace('xt_cxsecret', 'url(data:font/ttf;base64,' + b64 + ')');
                        ff.load()
                            .then(() => { try { document.fonts.add(ff); } catch (e) { /* ignore */ } this._cxFontLoaded = true; clearTimeout(timer); go(''); })
                            .catch((err) => { clearTimeout(timer); go('失败：' + ((err && err.message) || err)); });
                    } catch (e) { clearTimeout(timer); go('异常：' + (e && e.message)); }
                };
                const runWithFont = (charList) => loadFontOnce(() => run(charList));
                runWithFont(todo);
            },
            _workQuestionList(quizDoc) {
                const win = quizDoc.defaultView;
                const out = [];
                let timus = [];
                try { timus = Array.from(quizDoc.querySelectorAll('.TiMu')); } catch (e) { timus = []; }
                timus.forEach((timu) => {
                    let typeLabel = '';
                    let rawText = '';
                    try { typeLabel = ((timu.querySelector('.newZy_TItle') || {}).textContent || '').replace(/\s+/g, ''); } catch (e) { typeLabel = ''; }
                    try { rawText = ((timu.querySelector('.Zy_TItle') || {}).textContent || '').replace(/\s+/g, ' ').trim(); } catch (e) { rawText = ''; }
                    let textarea = null;
                    try { textarea = timu.querySelector('textarea[id^="answer"]'); } catch (e) { textarea = null; }
                    if (!textarea) { try { textarea = quizDoc.querySelector('textarea[id^="answer"]'); } catch (e) { textarea = null; } }
                    const answerId = textarea ? String(textarea.id).replace(/^answer/, '') : '';
                    let typeCode = '';
                    try { typeCode = answerId && win.jQuery ? String(win.jQuery('#answertype' + answerId).val() || '') : ''; } catch (e) { typeCode = ''; }
                    // F17：先收集选项与编辑器，再判题型 —— 「有编辑器且无选项」一律按写作题处理
                    // （真机演练：资料题【资料题】被误判为选择题导致「无法匹配选项」而停止）。
                    let optionEls = [];
                    try {
                        optionEls = Array.from(timu.querySelectorAll('.Zy_ulTop li, .Zy_ulTk li')).filter((li) => {
                            // F18：排除编辑器外壳（含 UEditor/textarea/iframe 的 li 不是选项）。
                            // 真机教训：把编辑器外壳当选项点击 → 提交空值。
                            try { if (li.querySelector('.edui-editor, textarea, iframe, [class*="edui"]')) return false; } catch (e) { /* ignore */ }
                            const t = (li.textContent || '').replace(/\s+/g, ' ').trim();
                            // F63：上限 200 太紧 —— 真机（2026-09-15T09-53-54）四个引文式选项长度为 200/217/207/206，
                            // 被丢掉 3 个只剩 1 个 → 门禁判"选项不足"上锁（死循环）；另一题 303/311/308/300 全被丢
                            // → optionEls 为空 → 被当成写作题去填编辑器（静默走错分支，更糟）。
                            // 编辑器外壳已由上面的结构判断排除，这里只需一个防"整块文本被当选项"的上界。
                            if (!t || t.length > 1200) return false;
                            try { if (li.querySelector('input[type=radio], input[type=checkbox]')) return true; } catch (e) { /* ignore */ }
                            return /^([A-H][、.．:：\s]|(对|错|正确|错误)\s*$)/.test(t);
                        }).map((li) => ({ el: li, text: (li.textContent || '').replace(/\s+/g, ' ').trim() }));
                    } catch (e) { optionEls = []; }
                    let editorCount = 0;
                    try { editorCount = timu.querySelectorAll('.edui-editor').length; } catch (e) { editorCount = 0; }
                    // F18：过滤后没有真选项 → 一律按写作题处理（不再依赖题型标签，覆盖案例/讨论/资料等所有变体）。
                    const isShortAnswer = optionEls.length === 0 || /简答|论述|分析|写作|资料|案例|讨论/.test(typeLabel) || ['4', '5', '18', '26'].indexOf(typeCode) >= 0;
                    out.push({ typeLabel: typeLabel, typeCode: typeCode, rawText: rawText, answerId: answerId, textarea: textarea, isShortAnswer: isShortAnswer, optionEls: optionEls, editorCount: editorCount });
                });
                return out;
            },
            _workPlainTexts(title, count) {
                const t = String(title || '').replace(/\s+/g, ' ').trim();
                if (!t) return [];
                const parts = [];
                const re = /(?:^|\s)(\d{1,2})\s*[.、．]\s*/g;
                let last = -1;
                let m = null;
                while ((m = re.exec(t))) {
                    if (last >= 0) parts.push(t.slice(last, m.index).trim());
                    last = re.lastIndex;
                }
                if (last >= 0) parts.push(t.slice(last).trim());
                const cleaned = parts.map((s) => s.replace(/[。；;]$/, '')).filter(Boolean);
                if (cleaned.length >= count) return cleaned.slice(0, count);
                if (count === 1) return [t];
                return cleaned;
            },
            _llmBuildShortMessages(question) {
                // 注意：llmJsonMode 下 response_format=json_object 要求提示词必须包含 "json" 字样，否则网关返回 400（真机演练实证）。
                return [
                    { role: 'system', content: '你是课程答题助手。请直接给出简洁的参考答案，只输出一个 JSON 对象：{"answer":"答案正文"}，不要解释、不要 Markdown、不要推理过程。' },
                    { role: 'user', content: '题目：' + String(question || '').slice(0, 500) + '\n只输出 JSON，例如 {"answer":"..."}。' },
                ];
            },
            _llmExtractFreeText(content) {
                const raw = String(content == null ? '' : content).trim();
                if (!raw) return '';
                const jsonMatch = raw.match(/\{[\s\S]{0,400}\}/);
                if (jsonMatch) {
                    try {
                        const obj = JSON.parse(jsonMatch[0]);
                        const v = obj && (obj.answer != null ? obj.answer : obj.result);
                        if (v != null && String(v).trim()) return String(v).trim();
                    } catch (e) { /* 按纯文本处理 */ }
                }
                return raw.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim().slice(0, 1200);
            },
            _fillWorkAnswer(quizWin, question, text) {
                const ue = quizWin && quizWin.UE;
                if (!ue || !ue.instants) return false;
                const wantKey = 'answer' + question.answerId;
                let editor = null;
                for (const key of Object.keys(ue.instants)) {
                    const candidate = ue.instants[key];
                    if (candidate && candidate.textarea && String(candidate.textarea.id) === wantKey) { editor = candidate; break; }
                }
                if (!editor) editor = ue.instants[wantKey] || null;
                if (!editor || !editor.body) return false;
                try {
                    editor.body.innerHTML = '<p>' + String(text == null ? '' : text).replace(/[<>]/g, '') + '</p>';
                    if (typeof editor.sync === 'function') editor.sync();
                    // 关键：页面提交时按 answer<id> 键查找实例，未注册会导致其内部 try/catch 静默失败（真机演练实证）。
                    if (!ue.instants[wantKey]) ue.instants[wantKey] = editor;
                    return true;
                } catch (e) { return false; }
            },
            // F19：题目合格性预检——给 AI 发请求/提交前，先排除明显不合格的「题目」（界面文案、过短、选项不足等）。
            _isQuestionSane(questionText, question) {
                const raw = String(questionText == null ? '' : questionText);
                const t = raw.replace(/【[^】]{1,10}】/g, '').replace(/\s+/g, ' ').trim();
                if (!t) return { ok: false, reason: '题目文本为空' };
                // F64：短题干 + 真实选项 = 合法的「填空式单选」。真机：「1 【单选题】预防医学是」（解密后 5 字）
                // 配 A~E 五个完整选项，语义由选项补全；原写法「t.length < 8」先把它判死 → 上锁 → 随重启死循环。
                // 与 F60（长度 ≥12）/F61（词表）/F62（只认中文）同一类：内容启发式不能压过"已抽到 ≥2 个选项"这个结构证据。
                // 提前到这里计算，供下面的长度检查与 F60 的长度检查共用（F60 块里的重复声明已删除）。
                const hasChoiceOptions = !!(question && !question.isShortAnswer && (question.optionEls || []).length >= 2);
                if (t.length < 8 && !hasChoiceOptions) return { ok: false, reason: '题目文本过短（' + t.length + ' 字）' };
                // F61：只保留**有辨识度的多字短语**。原先词表里混进了真题中极常见的单/双字词
                // （提交、确定、取消、字体、字号、返回），导致合法题被误杀 —— 真机：
                // 「1 【多选题】论文初稿提交有哪些要求？」因含「提交」而上锁，并随自动重启反复触发（死循环）。
                // 真正的编辑器工具栏 dump 一定含下面这些短语（一整排 UI 标签），合法题干不会。
                if (/填写答案|段落格式|点击上传|wordNum|edui|取消静音|播放速度|加载完毕|上一题|下一题|继续观看/.test(t)) return { ok: false, reason: '题目疑似编辑器/播放器界面文案' };
                if (/^[0-9\s.、．]+$/.test(t)) return { ok: false, reason: '题目无有效文字内容' };
                const cjkCount = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
                // F62：内容量的度量不能只认中文 —— 真机两次把**全英文题**当"内容过少"上锁
                //（会话 2026-09-15T09-12-59 的《课程介绍与思辨性阅读》15 题全英文单选；
                //  审计里的 2026-09-14T15-00-46 同一道题），且会随自动重启反复触发（死循环）。
                // 现改为：中文字数 ≥4 **或** 拉丁字母 ≥8 均视为有实质内容。
                const latinCount = (t.match(/[A-Za-z]/g) || []).length;
                if (cjkCount < 4 && latinCount < 8) return { ok: false, reason: '题目中文内容过少（' + cjkCount + ' 字）' };
                // F40（V3.6 补丁）：4~5 字的短中文题只要带疑问特征或选择题选项就是合法题（真机：「5【单选题】眶下孔位于？」被误锁）。
                // F62：同样不能拿它卡英文题（英文题中文数恒为 0）。
                if (cjkCount < 6 && latinCount < 8 && !/[?？]/.test(t)
                    && !(question && !question.isShortAnswer && (question.optionEls || []).length >= 2)) {
                    return { ok: false, reason: '题目中文内容过少（' + cjkCount + ' 字）' };
                }
                // F60：与 F40 同一原则的漏网分支 —— 选择题只要已抽到 ≥2 个选项，就不再强求"含问号或长度 ≥12"。
                // 真机：题干「1 【单选题】（）相当于总论。」剥掉类型标签后只有 10 字，被误锁；
                // 且该节点会随 conductor 自动重启反复撞同一个锁（死循环），比"停一次"严重得多。
                // 空格与字数会因平台把「【单选题】」「（ ）」等另外渲染而失真，选项才是最强证据。
                // （hasChoiceOptions 已在函数开头计算，见 F64）
                if (t.length < 12 && !/[?？]/.test(t) && !hasChoiceOptions) {
                    return { ok: false, reason: '题目过短且无疑问特征' };
                }
                if (question && !question.isShortAnswer) {
                    const ops = (question.optionEls || []).length;
                    if (ops < 2) return { ok: false, reason: '选择题有效选项不足（' + ops + ' 个）' };
                }
                return { ok: true, reason: '' };
            },
            _lockWork(reason, detail) {
                this._workLocked = true;
                this._workLockReason = reason;
                console.warn('%c[作业] ⛔ 已上锁：' + reason + '（拒绝自动提交，请人工处理）' + (detail ? ' ｜ ' + String(detail).slice(0, 100) : ''), 'color:#F44336;font-weight:bold');
            },
            _optionLooksSelected(el) {
                // F41（V3.6 补丁）：平台选项选中态识别（<li role=radio aria-checked onclick=addChoice>，无 input）。
                if (!el) return false;
                try {
                    if (el.querySelector && el.querySelector('input:checked')) return true;
                    if (el.getAttribute && el.getAttribute('aria-checked') === 'true') return true;
                    const cls = String(el.className || '');
                    if (/(^|\s)(cur|current|active|selected|checked|choose|chosen|on)(\s|$)/i.test(cls)) return true;
                    if (el.querySelector && el.querySelector('[class*="cur"],[class*="activ"],[class*="select"],[class*="check"]')) return true;
                    const label = el.querySelector ? el.querySelector('label') : null;
                    if (label && /(^|\s)(cur|current|active|selected|checked|on)(\s|$)/i.test(String(label.className || ''))) return true;
                    return false;
                } catch (e) {
                    return false;
                }
            },
            _optionClickTargets(el) {
                // F55：选项的「可点目标」按级排列。平台选项常是 <li class=ans-videoquiz-opt> 里套真实
                // <input type=radio>（ExtJS 渲染）；对父级 li 调 .click() 不会激活内部 radio
                // （浏览器只在点击目标就是 radio 或其 <label> 时才切换），所以必须逐级下探。
                const out = [];
                if (!el || !el.querySelector) return [el];
                try {
                    const inp = el.querySelector('input[type="radio"],input[type="checkbox"]');
                    if (inp) out.push(inp);
                    let lab = null;
                    try { lab = (inp && inp.closest) ? inp.closest('label') : null; } catch (e) { lab = null; }
                    if (!lab) { try { lab = el.querySelector('label'); } catch (e) { lab = null; } }
                    if (lab && lab !== inp) out.push(lab);
                } catch (e) { /* ignore */ }
                out.push(el);
                return out;
            },
            _clickWithVerification(picked, cb) {
                // F41：点击选项后校验是否真的选中；平台偶发丢点击（真机：第 1 题点了没生效 → 有效作答 10/11 上锁）。
                // F55：改为「逐级升级点击」——每轮只点下一级目标，点完立即复验。
                //   第 1 轮点内嵌 input、第 2 轮点 label、第 3 轮点容器本身。
                //   每轮只点一个目标，避免 checkbox 被点两下互相抵消。
                const done = typeof cb === 'function' ? cb : function () {};
                const list = Array.isArray(picked) ? picked.filter((c) => c && c.el) : [];
                if (!list.length) { done(new Error('无可点击选项')); return; }
                let attempt = 0;
                const tryClick = () => {
                    attempt++;
                    const missing = list.filter((c) => !this._optionLooksSelected(c.el));
                    if (!missing.length) {
                        if (attempt > 1) console.log('%c[LLM] 选项已选中（第 ' + attempt + ' 级点击生效）', 'color:#4CAF50');
                        done(null);
                        return;
                    }
                    if (attempt > 3) { done(new Error('选项点击未生效（输入框/标签/容器 三级点击均未选中）')); return; }
                    let tag = '';
                    for (const c of missing) {
                        const targets = this._optionClickTargets(c.el);
                        const target = targets[Math.min(attempt - 1, targets.length - 1)];
                        tag = (target && target.tagName) ? String(target.tagName).toLowerCase() : '?';
                        try { target.click(); } catch (e) { /* ignore */ }
                    }
                    if (attempt > 1) console.log('%c[LLM] 选项点击第 ' + attempt + ' 次尝试（目标级: ' + tag + '）', 'color:#FF9800');
                    this._schedule(tryClick, 350);
                };
                tryClick();
            },
            // F18：提交前空值守卫——统计题目的有效作答（写作题看编辑器正文，选择题看是否有选中项）。
            _workHasAnswer(quiz, questions) {
                let filled = 0;
                for (const q of questions) {
                    if (q.isShortAnswer) {
                        let text = '';
                        try {
                            const ue = quiz.win && quiz.win.UE;
                            const wantKey = 'answer' + q.answerId;
                            let ed = null;
                            if (ue && ue.instants) {
                                for (const k of Object.keys(ue.instants)) {
                                    const c = ue.instants[k];
                                    if (c && c.textarea && String(c.textarea.id) === wantKey) { ed = c; break; }
                                }
                                if (!ed && ue.instants[wantKey]) ed = ue.instants[wantKey];
                            }
                            if (ed && typeof ed.getContent === 'function') text = ed.getContent();
                            else if (q.textarea) text = q.textarea.value;
                        } catch (e) { text = ''; }
                        if (String(text || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim().length > 0) filled++;
                    } else {
                        let checked = false;
                        try {
                            // F39（V3.6 补丁）：平台选项是 <li role=radio aria-checked onclick=addChoice>，没有 <input>；
                            // 只看 input:checked 会误判 0/10 并错误上锁（真机：10 题全选后仍报「有效作答 0/10」）。
                            checked = q.optionEls.some((o) => {
                                try {
                                    const el = o.el;
                                    if (!el) return false;
                                    if (el.querySelector && el.querySelector('input:checked')) return true;
                                    if (el.getAttribute && el.getAttribute('aria-checked') === 'true') return true;
                                    const cls = String(el.className || '');
                                    if (/(^|\s)(cur|current|active|selected|checked|choose|chosen|on)(\s|$)/i.test(cls)) return true;
                                    if (el.querySelector && el.querySelector('[class*="cur"],[class*="activ"],[class*="select"],[class*="check"]')) return true;
                                    const label = el.querySelector ? el.querySelector('label') : null;
                                    if (label && /(^|\s)(cur|current|active|selected|checked|on)(\s|$)/i.test(String(label.className || ''))) return true;
                                    return false;
                                } catch (e) { return false; }
                            });
                        } catch (e) { checked = false; }
                        if (checked) filled++;
                    }
                }
                return filled;
            },
            _workLooksSubmitted(work) {
                // 任务点标记可能延迟：工作页出现「待批阅/已完成/已提交」也算提交成功（真机演练：待批阅 + ans-job-finished 延迟）。
                try {
                    const quiz = this._quizDocOf(work.frame);
                    if (quiz && quiz.doc && quiz.doc.body) {
                        const t = String(quiz.doc.body.innerText || '');
                        return /待批阅|已完成|已提交/.test(t);
                    }
                } catch (e) { /* ignore */ }
                return false;
            },
            // F48：调用平台原生「暂时保存」（作业帧内 a.btnSave[onclick=noSubmit()]）
            // 返回 done(ok)；ok=true 表示暂存动作已发出（不代表平台已确认）
            _saveWorkDraft(quizWin, topDoc, done) {
                const finish = typeof done === 'function' ? done : function () {};
                const clickConfirm = () => {
                    try {
                        const all = Array.from(topDoc.querySelectorAll('a, button, span'));
                        const btn = all.filter((el) => {
                            const t = (el.innerText || '').trim();
                            if (t !== '确定' && t !== '是' && t !== '好的') return false;
                            return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
                        })[0];
                        if (btn) { btn.click(); return true; }
                    } catch (e) { /* ignore */ }
                    return false;
                };
                try {
                    let called = false;
                    if (quizWin && typeof quizWin.noSubmit === 'function') { quizWin.noSubmit(); called = true; }
                    if (!called && quizWin && quizWin.document) {
                        const el = quizWin.document.querySelector('a.btnSave, #tempsave, a[onclick*="noSubmit"]');
                        if (el) { el.click(); called = true; }
                    }
                    if (!called) { console.warn('%c[作业] 未找到「暂时保存」入口，无法暂存', 'color:#FF9800'); finish(false); return; }
                    console.log('%c[作业] 已点击「暂时保存」：本次只存草稿、不提交（不确定情况的安全策略）', 'color:#2196F3');
                    this._schedule(() => { clickConfirm(); finish(true); }, 900);
                } catch (e) {
                    console.warn('%c[作业] 暂存失败：' + (e && e.message ? e.message : e), 'color:#FF9800');
                    finish(false);
                }
            },
            _submitWork(quizWin, topDoc, done) {
                if (this.configs.workSanityLock && this._workLocked) {
                    console.warn('%c[作业] 已上锁（' + (this._workLockReason || '异常状态') + '）：拒绝任何提交动作', 'color:#F44336');
                    done(false, '作业已上锁：' + (this._workLockReason || '异常状态'));
                    return;
                }
                const clickConfirm = () => {
                    try {
                        const all = Array.from(topDoc.querySelectorAll('a, button, span'));
                        const btn = all.filter((el) => {
                            const t = (el.innerText || '').trim();
                            if (t !== '提交') return false;
                            return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
                        })[0];
                        if (btn) { btn.click(); return true; }
                    } catch (e) { /* ignore */ }
                    return false;
                };
                const tryClick = (left) => {
                    if (clickConfirm()) { done(true, ''); return; }
                    if (left <= 0) { done(false, '未找到确认提交弹窗（可能被风控拦截）'); return; }
                    this._schedule(() => tryClick(left - 1), 500);
                };
                try {
                    const before = this._findUnfinishedWorks().filter((w) => !w.finished).length;
                    if (typeof quizWin.btnBlueSubmit === 'function') quizWin.btnBlueSubmit();
                    else {
                        const el = quizWin.document.querySelector('.btnSubmit');
                        if (!el) { done(false, '未找到提交按钮'); return; }
                        el.click();
                    }
                    this._schedule(() => tryClick(20), 900);
                } catch (e) {
                    done(false, '提交入口调用失败：' + (e && e.message ? e.message : e));
                }
            },
            _handleEmbeddedWorks() {
                if (this._workBusy) return true;
                const works = this._findUnfinishedWorks().filter((w) => !w.finished);
                if (!works.length) return false;
                if (!this.configs.llmEnabled || !this.configs.llmEmbeddedWork) {
                    console.warn('%c[LLM] 检测到 ' + works.length + ' 个未完成的内嵌章节测验/作业：按当前配置不自动作答，已停止自动前进（绝不跳过）。'
                        + '开启自动作答：app.configs.llmEmbeddedWork = true（需先配置 LLM Key）', 'color:#FF9800');
                    return true;
                }
                if (!this._llmApiKey) {
                    console.warn('%c[LLM] 检测到未完成的内嵌章节测验，但未配置 API Key：已停止自动前进，请配置后重试', 'color:#FF9800');
                    return true;
                }
                this._workBusy = true;
                console.log('%c[LLM] 检测到 ' + works.length + ' 个未完成的内嵌章节测验/作业，开始逐题作答（仅简答题会自动填写，提交走平台原生流程）…', 'color:#2196F3');
                const nextWork = (wi) => {
                    if (wi >= works.length) {
                        this._workBusy = false;
                        console.log('%c[LLM] 内嵌章节测验/作业已全部提交完成，继续推进', 'color:#4CAF50');
                        this._schedule(() => {
                            let videoDone = true;
                            try {
                                const frames = this._getVideoTaskFrames();
                                if (frames && frames.length) videoDone = this._areAllVideoTasksComplete(frames);
                            } catch (e) { videoDone = true; }
                            if (videoDone) this.nextUnit(); else this.play();
                        }, 2500);
                        return;
                    }
                    const work = works[wi];
                    this._workLocked = false;
                    this._workLockReason = '';
                    const quiz = this._quizDocOf(work.frame);
                    if (!quiz || !quiz.doc) {
                        this._workBusy = false;
                        console.warn('%c[LLM] 未能定位测验内容，已停止自动前进（绝不跳过）', 'color:#FF9800');
                        return;
                    }
                    const questions = this._workQuestionList(quiz.doc);
                    if (!questions.length) {
                        this._workBusy = false;
                        // 用户 2026-09-16 规则：定位不到题目结构时**不提交**，并按配置**跳过该任务点**继续。
                        // 真机 2026-09-16 23:33：节点「视频+章节测验」双任务点，视频完成、切到测验后定位不到题目 →
                        // 原先硬停（绝不跳过）→ loopAlive=false + embedded=true 持续 2 拍 → 守望器 self-stopped → 整轮被停。
                        // 跳过不丢数据：该任务点仍未完成，下一轮/重进本课时会再处理。
                        if (this.configs.llmSkipNodeAfterRetries === false) {
                            console.warn('%c[LLM] 未识别到题目结构，已停止自动前进（llmSkipNodeAfterRetries=false）', 'color:#FF9800');
                            return;
                        }
                        console.warn('%c[LLM] 未识别到题目结构（不提交）→ 按规则跳过该任务点继续推进', 'color:#FF9800');
                        try { this._schedule(() => { try { this.nextUnit(); } catch (e) { console.error('[LLM] 跳过后推进失败:', e); } }, 1200); }
                        catch (e) { console.error('[LLM] 跳过后推进失败:', e); }
                        return;
                    }
                    const texts = this._workPlainTexts(work.title, questions.length);
                    console.log('%c[LLM] 作业《' + String(work.title || work.jobid).slice(0, 60) + '》共 ' + questions.length + ' 题', 'color:#2196F3');
                    const giveUp = (msg) => {
                        this._workBusy = false;
                        // F48：不确定/失败时先"只暂存不提交"——把已填答案存成草稿，再处理该任务点。
                        const skipAfter = () => {
                            // 用户 2026-09-16 规则：心跳重试耗尽后**不提交**，并**跳过该任务点**继续刷后面，
                            // 不再停在原地等人（否则整条自动链路被一道题卡死）。跳过 = 之后重进本课再处理，
                            // 既不会误交不确定答案，也不会丢进度。
                            if (this.configs.llmSkipNodeAfterRetries === false) {
                                console.warn('%c[LLM] 内嵌测验自动作答失败：' + msg + '；已停止自动前进（llmSkipNodeAfterRetries=false）', 'color:#FF9800');
                                return;
                            }
                            console.warn('%c[LLM] 内嵌测验自动作答失败：' + msg + '；已按规则【不提交 + 跳过该任务点】继续推进', 'color:#FF9800');
                            try { this._schedule(() => { try { this.nextUnit(); } catch (e) { console.error('[LLM] 跳过后推进失败:', e); } }, 1200); }
                            catch (e) { console.error('[LLM] 跳过后推进失败:', e); }
                        };
                        if (this.configs.workDraftOnUncertain !== false) {
                            try {
                                this._saveWorkDraft(quiz.win, document, (ok) => {
                                    console.warn('%c[LLM] 内嵌测验自动作答失败：' + msg + '；'
                                        + (ok ? '已暂存草稿（未提交）' : '且暂存失败'), 'color:#FF9800');
                                    skipAfter();
                                });
                                return;
                            } catch (e) { /* 落回普通失败日志 */ }
                        }
                        skipAfter();
                    };
                    const askNext = (qi) => {
                        if (qi >= questions.length) {
                            if (this._workLocked) { giveUp('作业已上锁（' + (this._workLockReason || '异常状态') + '），拒绝提交'); return; }
                            // F18/F19：提交前校验——必须每道题都有有效作答，否则上锁拒绝提交（防止空值/缺题入库）。
                            const filledCount = this._workHasAnswer(quiz, questions);
                            if (this.configs.workSanityLock && filledCount < questions.length) {
                                this._lockWork('有效作答 ' + filledCount + '/' + questions.length + '，未全部完成');
                                giveUp('有效作答 ' + filledCount + '/' + questions.length + '，未全部完成，已上锁拒绝提交');
                                return;
                            }
                            console.log('%c[作业] 提交前校验通过（有效作答 ' + filledCount + '/' + questions.length + ' 题）', 'color:#4CAF50');
                            this._submitWork(quiz.win, document, (ok, msg) => {
                                if (!ok) { giveUp(msg); return; }
                                const waitDone = (left) => {
                                    const all = this._findUnfinishedWorks();
                                    const target = all.filter((w) => w.jobid === work.jobid)[0];
                                    const submitted = target ? (target.finished || this._workLooksSubmitted(target)) : true;
                                    if (submitted) { nextWork(wi + 1); return; }
                                    if (left <= 0) { giveUp('提交后任务点未标记完成（可能进入人工批阅或需要验证码）'); return; }
                                    this._schedule(() => waitDone(left - 1), 2000);
                                };
                                this._schedule(() => waitDone(Math.max(3, Math.ceil((Number(this.configs.llmWorkWaitMs) || 45000) / 2000))), 800);
                            });
                            return;
                        }
                        const q = questions[qi];
                        // F18：优先使用真实题目文本（rawText），仅在过短/缺失时退回作业标题。
                        // 真机教训：此前误把作业标题当题干 → LLM 回答"题目信息不足"。
                        const rawQuestion = (q.rawText && q.rawText.replace(/\s+/g, '').length >= 10) ? q.rawText : (texts[qi] || q.rawText || String(work.title || ''));
                        const rawOptions = q.optionEls.map((o) => o.text);
                        // F17：先解密 font-cxsecret 混淆文本（题干 + 选项），再交给 LLM 作答/匹配。
                        this._cxSecretDecode([rawQuestion].concat(rawOptions), (decoded) => {
                            const questionText = decoded[0] || rawQuestion;
                            // F19：发给 AI 前先做题目合格性预检（不合格直接上锁，绝不把奇怪内容发出去）。
                            if (this.configs.workSanityLock) {
                                const sanity = this._isQuestionSane(questionText, q);
                                if (!sanity.ok) {
                                    this._lockWork('题目校验未通过：' + sanity.reason, questionText);
                                    giveUp('题目校验未通过（' + sanity.reason + '），已上锁拒绝提交');
                                    return;
                                }
                            }
                            // F49-A：把**解码后的题干与选项原文**完整打出来，便于人眼核对（不再只报"命中 N 字"）
                            console.log('%c[字库解密] 第 ' + (qi + 1) + ' 题题干(已解码)：' + String(questionText).slice(0, 220), 'color:#607D8B');
                            if (decoded.length > 1) {
                                console.log('%c[字库解密] 第 ' + (qi + 1) + ' 题选项(已解码)：'
                                    + decoded.slice(1).map((t, i) => String.fromCharCode(65 + i) + ':' + String(t).slice(0, 30)).join(' | '), 'color:#607D8B');
                            }
                            // F49-B：仍有"被混淆但没解出"的字 → 判为不确定 → 上锁 + 走 F48「只暂存不提交」
                            if (this.configs.workDraftOnUncertain !== false) {
                                const unresolved = this._cxLastUnresolved || [];
                                if (unresolved.length) {
                                    this._lockWork('题干解码不完整：' + unresolved.length + ' 个混淆字未解出（' + unresolved.slice(0, 10).join('') + '）', questionText);
                                    giveUp('题干仍含 ' + unresolved.length + ' 个未解出的混淆字（' + unresolved.slice(0, 10).join('') + '），判为不确定 → 只暂存不提交');
                                    return;
                                }
                            }
                            if (q.isShortAnswer) {
                                const cachedShort = this._answerCacheGet(questionText);
                                if (cachedShort && cachedShort.kind === 'short') {
                                    const okCached = this._fillWorkAnswer(quiz.win, q, cachedShort.answer);
                                    if (okCached) {
                                        console.log('%c[缓存] 第 ' + (qi + 1) + ' 题命中答案缓存（写作/简答），已填入编辑器', 'color:#10B981');
                                        askNext(qi + 1);
                                        return;
                                    }
                                }
                                console.log('%c[LLM] 第 ' + (qi + 1) + ' 题（写作/简答）作答中：' + String(questionText).slice(0, 50), 'color:#2196F3');
                                this._llmRequest(
                                    this._llmBuildPayload(this._llmBuildShortMessages(questionText)),
                                    (content) => {
                                        const text = this._llmExtractFreeText(content);
                                        // F19：LLM 未给出有效答案（空 / 明确表示无法作答 / 疑似推理泄漏）→ 上锁，拒绝提交。
                                        const flat = String(text || '').replace(/<[^>]*>/g, '').replace(/\s+/g, '');
                                        if (!flat || flat.length < 4 || /题目信息不足|无法提供参考答案|无法作答|乱码|We need answer/i.test(String(text || ''))) {
                                            this._lockWork('AI 未给出有效答案', text);
                                            giveUp('AI 未给出有效答案，已上锁拒绝提交');
                                            return;
                                        }
                                        this._answerCacheSet(questionText, 'short', text);
                                        const ok = this._fillWorkAnswer(quiz.win, q, text);
                                        console.log('%c[LLM] 第 ' + (qi + 1) + ' 题答案' + (ok ? '已填入编辑器' : '填充失败') + '：' + String(text).slice(0, 60), ok ? 'color:#9C27B0' : 'color:#FF9800');
                                        if (!ok) { this._lockWork('第 ' + (qi + 1) + ' 题答案填充失败'); giveUp('第 ' + (qi + 1) + ' 题答案填充失败'); return; }
                                        askNext(qi + 1);
                                    },
                                    (err) => giveUp('第 ' + (qi + 1) + ' 题请求失败：' + (err && err.message ? err.message : err))
                                );
                                return;
                            }
                            const options = q.optionEls.map((o, i) => ({ el: o.el, text: decoded[i + 1] || o.text, letter: String.fromCharCode(65 + i) }));
                            // F33：LLM → 缓存 → 人工 的降级链（对齐上游 TikuFallback）；命中缓存则不耗 token、不占节流配额。
                            const cachedChoice = this._answerCacheGet(questionText);
                            if (cachedChoice && cachedChoice.kind === 'choice') {
                                const cachedList = this._llmPickOptions(options, cachedChoice.answer);
                                if (cachedList.length) {
                                    cachedList.forEach((c) => { try { c.el.click(); } catch (e) { /* ignore */ } });
                                    console.log('%c[缓存] 第 ' + (qi + 1) + ' 题命中答案缓存，已选择：' + cachedList.map((c) => String(c.text || '').slice(0, 20)).join(' / '), 'color:#10B981');
                                    askNext(qi + 1);
                                    return;
                                }
                            }
                            const isMultiChoice = /多选/.test(String(q.typeLabel || ''))
                                || q.optionEls.some((o) => { try { return !!(o.el && o.el.querySelector && o.el.querySelector('input[type=checkbox]')); } catch (e) { return false; } });
                            this._llmAskChoice(questionText, options, isMultiChoice, (err, result) => {
                                if (err || !result || !result.picked.length) {
                                    // F37：失败时打印完整诊断（答案原文/LLM 原始输出/选项快照/是否多选），便于人工定位。
                                    console.warn('%c[LLM] 第 ' + (qi + 1) + ' 题作答失败：' + (err ? err.message : '无法匹配选项')
                                        + (isMultiChoice ? '（多选）' : '')
                                        + ' ｜ answer=' + JSON.stringify(String((result && result.answer) || '').slice(0, 40))
                                        + ' ｜ llmRaw=' + JSON.stringify(String((result && result.raw) || '').slice(0, 140))
                                        + ' ｜ options=' + options.map((o) => o.letter + ':' + String(o.text || '').slice(0, 16)).join(' | '), 'color:#FF9800');
                                    giveUp('第 ' + (qi + 1) + ' 题无法匹配选项');
                                    return;
                                }
                                this._answerCacheSet(questionText, 'choice', result.answer);
                                this._clickWithVerification(result.picked, (clickErr) => {
                                    if (clickErr) console.warn('%c[LLM] 第 ' + (qi + 1) + ' 题选项点击未生效（' + clickErr.message + '），继续下一题', 'color:#FF9800');
                                    console.log('%c[LLM] 第 ' + (qi + 1) + ' 题已选择：' + result.picked.map((c) => String(c.text || '').slice(0, 24)).join(' / '), 'color:#9C27B0');
                                    askNext(qi + 1);
                                });
                            });
                        });
                    };
                    askNext(0);
                };
                nextWork(0);
                return true;
            },
            // ================= F13（V3.6）：文档任务点（PDF/PPT/教案）自动翻阅 =================
            _findDocTaskFrames() {
                const found = [];
                const seen = new Set();
                const visit = (doc, depth) => {
                    if (!doc || depth > 6 || seen.has(doc)) return;
                    seen.add(doc);
                    let frames = [];
                    try { frames = Array.from(doc.querySelectorAll('iframe, frame')); } catch (e) { frames = []; }
                    for (const frame of frames) {
                        let jobid = '';
                        let src = '';
                        try { jobid = String(frame.getAttribute('jobid') || ''); src = String(frame.getAttribute('src') || ''); } catch (e) { jobid = ''; src = ''; }
                        if (jobid && /\/modules\//.test(src) && !/\/modules\/(video|work)\//.test(src)) {
                            let holder = null;
                            try { holder = frame.closest ? frame.closest('.ans-attach-ct') : null; } catch (e) { holder = null; }
                            const finished = holder ? holder.classList.contains('ans-job-finished') : false;
                            found.push({ frame: frame, holder: holder, finished: finished, jobid: jobid, src: src });
                            continue;
                        }
                        let childDoc = null;
                        try { childDoc = frame.contentDocument; } catch (e) { childDoc = null; }
                        if (childDoc) visit(childDoc, depth + 1);
                    }
                };
                visit(typeof document === 'undefined' ? null : document, 0);
                return found;
            },
            _hasUnfinishedDocTask() {
                try { return this._findDocTaskFrames().some((d) => !d.finished); } catch (e) { return false; }
            },
            // F44：文档任务点完成判定必须按「本任务点」收敛。
            // 原实现在等待回调里用「全站是否还有未完成文档任务点」判定本次是否完成：
            // 同一页面存在多个 PDF/PPT 任务点时该条件永远为真，于是第一个任务点两轮翻阅后必然报
            // 「滚动后任务点未标记完成」并停止自动前进（真机：12 个任务点，第 1 个已被平台标记仍被判未完成）。
            _isDocTaskFinished(docTask) {
                try {
                    if (!docTask) return true;
                    if (docTask.finished) return true;
                    const cur = this._findDocTaskFrames().find((d) => String(d.jobid) === String(docTask.jobid));
                    if (!cur) return true; // 任务点已不在 DOM（完成后挂件移除）→ 视为完成，避免死等
                    return !!cur.finished;
                } catch (e) { return false; }
            },
            _docScroller(doc) {
                let best = null;
                const visit = (d, dep) => {
                    if (!d || dep > 6 || best) return;
                    const cands = [];
                    try { cands.push(d.scrollingElement, d.documentElement, d.body); } catch (e) { /* ignore */ }
                    try { const els = Array.from(d.querySelectorAll('div, main, section')); for (const el of els.slice(0, 400)) cands.push(el); } catch (e) { /* ignore */ }
                    for (const el of cands) {
                        try { if (el && el.scrollHeight > el.clientHeight + 100 && el.clientHeight > 80) { best = el; return; } } catch (e) { /* ignore */ }
                    }
                    let frames = [];
                    try { frames = Array.from(d.querySelectorAll('iframe, frame')); } catch (e) { frames = []; }
                    for (const f of frames) {
                        let cd = null;
                        try { cd = f.contentDocument; } catch (e) { cd = null; }
                        if (cd) visit(cd, dep + 1);
                        if (best) return;
                    }
                };
                visit(doc, 0);
                return best;
            },
            _scrollDocToEnd(scroller, step, maxMs, cb) {
                const start = Date.now();
                let lastHeight = scroller ? (scroller.scrollHeight || 0) : 0;
                let stableCount = 0;
                const tick = () => {
                    if (!scroller) { cb(false, '未找到可滚动容器'); return; }
                    try {
                        const total = scroller.scrollHeight;
                        const max = Math.max(0, total - scroller.clientHeight);
                        const next = Math.min(max, (scroller.scrollTop || 0) + step);
                        scroller.scrollTop = next;
                        try { scroller.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) { /* ignore */ }
                        const pos = scroller.scrollTop || 0;
                        const atBottom = pos + scroller.clientHeight >= scroller.scrollHeight - 5;
                        if (atBottom) {
                            // 到底后停留观察：懒加载会让 scrollHeight 继续增长，必须等高度稳定才算真正到底。
                            if (total > lastHeight + 10) stableCount = 0; else stableCount++;
                            lastHeight = total;
                            if (stableCount >= 3) { cb(true, ''); return; }
                        } else {
                            stableCount = 0;
                            lastHeight = total;
                        }
                        if (Date.now() - start > Math.max(30000, maxMs)) { cb(atBottom, atBottom ? '' : '超时未滚到底部'); return; }
                    } catch (e) { cb(false, e.message); return; }
                    this._schedule(tick, Math.max(200, Number(this.configs.docTaskScrollStepMs) || 800));
                };
                this._schedule(tick, 300);
            },
            _processDocTasks(docs, idx, done) {
                if (idx >= docs.length) { done(true, ''); return; }
                const docTask = docs[idx];
                // F44：入口按本任务点复查（快照可能过期，或平台已标记但快照仍为未完成）。
                if (this._isDocTaskFinished(docTask)) { this._processDocTasks(docs, idx + 1, done); return; }
                let doc = null;
                try { doc = docTask.frame.contentDocument; } catch (e) { doc = null; }
                if (!doc) { done(false, '无法访问文档内容'); return; }
                const attempts = Math.max(1, Number(this.configs.docTaskAttempts) || 2);
                const runAttempt = (left) => {
                    const scroller = this._docScroller(doc);
                    if (!scroller) { done(false, '未找到文档滚动容器'); return; }
                    console.log('%c[文档任务] 开始翻阅 ' + String(docTask.jobid).slice(0, 24) + '（高度 ' + scroller.scrollHeight + 'px，第 ' + (attempts - left + 1) + '/' + attempts + ' 轮）', 'color:#2196F3');
                    const step = Math.max(200, Math.floor((scroller.clientHeight || 400) * 0.9));
                    this._scrollDocToEnd(scroller, step, Number(this.configs.docTaskMaxMs) || 240000, (ok, msg) => {
                        if (!ok) { done(false, '翻阅失败：' + msg); return; }
                        console.log('%c[文档任务] 本轮翻阅完成（高度 ' + scroller.scrollHeight + 'px），等待平台标记完成…', 'color:#2196F3');
                        const wait = (leftTicks) => {
                            // F44：只认本任务点是否被标记完成；完成后继续下一个任务点，
                            // 全部完成时经 idx 越界自然收敛为 done(true)（保持"全部完成才继续推进"的原语义）。
                            if (this._isDocTaskFinished(docTask)) {
                                console.log('%c[文档任务] 任务点 ' + String(docTask.jobid).slice(0, 24) + ' 已被平台标记完成，继续下一个任务点', 'color:#4CAF50');
                                this._processDocTasks(docs, idx + 1, done);
                                return;
                            }
                            if (leftTicks <= 0) {
                                if (left > 1) {
                                    console.log('%c[文档任务] 尚未标记完成，追加一轮翻阅…', 'color:#FF9800');
                                    runAttempt(left - 1);
                                    return;
                                }
                                done(false, '滚动后任务点未标记完成');
                                return;
                            }
                            this._schedule(() => wait(leftTicks - 1), 2000);
                        };
                        this._schedule(() => wait(Math.max(3, Math.ceil((Number(this.configs.docTaskWaitMs) || 45000) / 2000))), 1000);
                    });
                };
                runAttempt(attempts);
            },
            _handleDocTasks() {
                if (this._docTaskBusy) return true;
                const docs = this._findDocTaskFrames().filter((d) => !d.finished);
                if (!docs.length) return false;
                if (!this.configs.docTaskScroll) {
                    console.warn('%c[文档任务] 检测到 ' + docs.length + ' 个未完成文档任务点（PDF/PPT/教案）：按当前配置不自动翻阅，已停止自动前进（绝不跳过）。'
                        + '开启：app.configs.docTaskScroll = true', 'color:#FF9800');
                    return true;
                }
                this._docTaskBusy = true;
                console.log('%c[文档任务] 检测到 ' + docs.length + ' 个未完成文档任务点，开始自动翻阅…', 'color:#2196F3');
                this._processDocTasks(docs, 0, (ok, msg) => {
                    this._docTaskBusy = false;
                    if (ok) {
                        console.log('%c[文档任务] 已全部完成，继续推进', 'color:#4CAF50');
                        this._schedule(() => this.play(), 2000);
                    } else {
                        console.warn('%c[文档任务] 自动翻阅未完成：' + msg + '；已停止自动前进，请人工处理', 'color:#FF9800');
                    }
                });
                return true;
            },
            // ================= F45（V3.6）：讨论任务点（insertbbs/BBS）自动参与 =================
            _findDiscussTaskFrames() {
                const found = [];
                const seen = new Set();
                const visit = (doc, depth) => {
                    if (!doc || depth > 6 || seen.has(doc)) return;
                    seen.add(doc);
                    let frames = [];
                    try { frames = Array.from(doc.querySelectorAll('iframe, frame')); } catch (e) { frames = []; }
                    for (const frame of frames) {
                        let src = '';
                        try { src = String(frame.getAttribute('src') || ''); } catch (e) { src = ''; }
                        if (/\/modules\/insertbbs\//.test(src)) {
                            let holder = null;
                            try { holder = frame.closest ? frame.closest('.ans-attach-ct') : null; } catch (e) { holder = null; }
                            const finished = holder ? holder.classList.contains('ans-job-finished') : false;
                            let data = null;
                            try { data = JSON.parse(String(frame.getAttribute('data') || '{}')); } catch (e) { data = null; }
                            found.push({ frame: frame, holder: holder, finished: finished, src: src, data: data });
                            continue;
                        }
                        let childDoc = null;
                        try { childDoc = frame.contentDocument; } catch (e) { childDoc = null; }
                        if (childDoc) visit(childDoc, depth + 1);
                    }
                };
                visit(typeof document === 'undefined' ? null : document, 0);
                return found;
            },
            _hasUnfinishedDiscussTask() {
                try { return this._findDiscussTaskFrames().some((d) => !d.finished); } catch (e) { return false; }
            },
            _discussTopicUrl(item) {
                // 1) 首选：讨论卡片 #topicMainDiv[data]（insertbbs 帧内同源，含 bbsid/uuid/courseId/classId）
                try {
                    const doc = item.frame.contentDocument;
                    if (doc) {
                        const seen = new Set();
                        let url = '';
                        const visit = (d, depth) => {
                            if (!d || depth > 3 || url || seen.has(d)) return;
                            seen.add(d);
                            let card = null;
                            try { card = d.getElementById ? d.getElementById('topicMainDiv') : null; } catch (e) { card = null; }
                            if (card) { url = String(card.getAttribute('data') || ''); if (url) return; }
                            let frames = [];
                            try { frames = Array.from(d.querySelectorAll('iframe, frame')); } catch (e) { frames = []; }
                            for (const f of frames) {
                                let cd = null;
                                try { cd = f.contentDocument; } catch (e) { cd = null; }
                                if (cd) visit(cd, depth + 1);
                                if (url) return;
                            }
                        };
                        visit(doc, 0);
                        if (url) return url;
                    }
                } catch (e) { /* ignore */ }
                // 2) 退化：章节讨论面板里的同类话题链接
                try {
                    const a = document.querySelector('#posDiscussScroll a[href*="replysList"], a[href*="replysList"]');
                    if (a) return String(a.getAttribute('href') || '');
                } catch (e) { /* ignore */ }
                return '';
            },
            _httpPost(url, body, cb) {
                // F45：POST 传输。油猴走 GM_xmlhttpRequest（自带 cookie、不受 CORS 限制）；
                // 宿主注入的传输以第 3 个参数收到 {method,data}（旧实现忽略该参数会退化为 GET，由平台拒绝，不会伪造成功）。
                const done = typeof cb === 'function' ? cb : function () {};
                if (this._httpTransport) {
                    try { this._httpTransport(String(url), done, { method: 'POST', data: String(body), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }); } catch (e) { done(e); }
                    return;
                }
                let gm = null;
                try {
                    if (typeof GM_xmlhttpRequest !== 'undefined' && GM_xmlhttpRequest) gm = GM_xmlhttpRequest;
                    else if (window && window.GM_xmlhttpRequest) gm = window.GM_xmlhttpRequest;
                } catch (e) { gm = null; }
                if (typeof gm !== 'function') { done(new Error('当前环境没有 HTTP 传输（油猴 GM_xmlhttpRequest 或 app.setHttpTransport），无法提交讨论回复')); return; }
                try {
                    gm({
                        method: 'POST',
                        url: String(url),
                        data: String(body),
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        onload: (res) => done(null, res && res.responseText),
                        onerror: (err) => done(err || new Error('HTTP 错误')),
                        ontimeout: () => done(new Error('HTTP 超时')),
                    });
                } catch (e) { done(e); }
            },
            _uuid4() {
                try { if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID(); } catch (e) { /* ignore */ }
                return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
                    const r = Math.random() * 16 | 0;
                    return (ch === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
                });
            },
            _discussReplyText(item, cb) {
                const fixed = String(this.configs.discussReplyText || '').trim();
                if (fixed) { cb(null, fixed); return; }
                const d = (item && item.data) || {};
                const title = String(d.title || this._currentStepTitle() || '').slice(0, 100);
                const detail = String(d.detail || '').replace(/\s+/g, ' ').slice(0, 1500);
                if (!this.configs.llmEnabled || !this._llmApiKey) {
                    cb(new Error('未配置讨论回复文本：请开启 LLM（app.configs.llmEnabled=true + app.setLlmKey）或设置 app.configs.discussReplyText'));
                    return;
                }
                const prompt = '你是口腔医学课程的学生，正在参与课程讨论。请针对下面的话题写一段 150~400 字的回复：'
                    + '紧扣话题给到的病例/资料与量化数据，分点给出可执行的处理思路，语气客观、像学生参与讨论；'
                    + '不要出现"作为AI""根据资料"等字样，不要复述题目，不要用 Markdown 标题。\n\n'
                    + '话题标题：' + title + '\n话题内容：' + detail;
                const payload = {
                    model: this.configs.llmModel,
                    messages: [{ role: 'user', content: prompt }],
                    max_tokens: Math.max(1024, Number(this.configs.llmMaxTokens) || 4096),
                    temperature: 0.3,
                };
                this._llmRequest(payload, (content) => {
                    let out = String(content || '').replace(/^\s*```[\s\S]*?\n/, '').replace(/```\s*$/, '').trim();
                    if (!out) { cb(new Error('LLM 未返回可用回复文本')); return; }
                    cb(null, out.slice(0, 900));
                }, (err) => cb(err || new Error('LLM 请求失败')));
            },
            _reloadDiscussCard(item) {
                // F45：重载讨论卡片，让服务端 isFinished 重新下发 → 卡片 postMessage → insertbbs greenligth() → ans-job-finished
                try {
                    const doc = item.frame.contentDocument;
                    if (!doc) return;
                    const seen = new Set();
                    const visit = (d, depth) => {
                        if (!d || depth > 3 || seen.has(d)) return;
                        seen.add(d);
                        let frames = [];
                        try { frames = Array.from(d.querySelectorAll('iframe, frame')); } catch (e) { frames = []; }
                        for (const f of frames) {
                            let u = '';
                            try { u = String(f.contentWindow.location.href || ''); } catch (e) { u = ''; }
                            if (/bbscircle/.test(u)) { try { f.contentWindow.location.reload(); } catch (e) { /* ignore */ } }
                            let cd = null;
                            try { cd = f.contentDocument; } catch (e) { cd = null; }
                            if (cd) visit(cd, depth + 1);
                        }
                    };
                    visit(doc, 0);
                } catch (e) { /* ignore */ }
            },
            _discussParticipate(item, cb) {
                const url = this._discussTopicUrl(item);
                if (!url) { cb(new Error('未找到讨论话题链接（topicMainDiv[data] / replysList）')); return; }
                const m = /\/topic\/v3\/bbs\/([0-9a-zA-Z-]+)\/([0-9a-zA-Z-]+)\/replysList/.exec(url);
                if (!m) { cb(new Error('讨论话题 URL 解析失败：' + url.slice(0, 90))); return; }
                const bbsid = m[1];
                const topicUuid = m[2];
                const q = (k) => { const r = new RegExp('[?&]' + k + '=([^&]*)').exec(url); return r ? r[1] : ''; };
                const courseId = q('courseId');
                const classId = q('classId');
                // F45：回帖端点一律由话题 URL 推导 origin，不在源码里硬编码外部主机（满足 F5-2 外部 URL 静态策略）。
                let raw = String(url).trim();
                if (raw.indexOf('//') === 0) raw = 'https:' + raw;
                let origin = '';
                try { origin = new URL(raw).origin; } catch (e) { origin = ''; }
                if (!/^https?:/.test(raw) || !origin) { cb(new Error('讨论话题 URL 不是绝对地址，无法确定回帖端点：' + raw.slice(0, 90))); return; }
                this._httpGet(raw, (err, html) => {
                    if (err) { cb(new Error('获取讨论话题页失败（跨域需 GM_xmlhttpRequest 或宿主传输）：' + (err.message || err))); return; }
                    const tk = /urlToken\s*[:=]\s*["']([^"']+)["']/.exec(String(html || ''));
                    if (!tk) { cb(new Error('讨论话题页未返回 urlToken（未登录或页面结构变化）')); return; }
                    this._discussReplyText(item, (tErr, text) => {
                        if (tErr) { cb(tErr); return; }
                        const body = [
                            'courseId=' + encodeURIComponent(courseId),
                            'classId=' + encodeURIComponent(classId),
                            'replyId=',
                            'uuid=' + this._uuid4(),
                            'topic_content=' + encodeURIComponent(text),
                            'files_url=',
                            'files_attr=',
                            'anonymous=0',
                            'urlToken=' + encodeURIComponent(tk[1]),
                            'bbsid=' + encodeURIComponent(bbsid),
                        ].join('&');
                        const postUrl = origin + '/pc/invitation/' + topicUuid + '/addReplys';
                        this._httpPost(postUrl, body, (pErr, res) => {
                            if (pErr) { cb(new Error('提交讨论回复失败：' + (pErr.message || pErr))); return; }
                            let ok = false;
                            try { ok = !!JSON.parse(String(res || '{}')).status; } catch (e) { ok = false; }
                            if (!ok) { cb(new Error('平台未接受讨论回复：' + String(res || '').slice(0, 160))); return; }
                            console.log('%c[讨论任务] 已提交讨论回复（' + text.length + ' 字），等待平台标记完成…', 'color:#4CAF50');
                            this._reloadDiscussCard(item);
                            const waitMs = Math.max(5000, Number(this.configs.discussTaskWaitMs) || 60000);
                            this._schedule(() => {
                                const jobid = item.data && item.data.jobid ? String(item.data.jobid) : '';
                                const all = this._findDiscussTaskFrames();
                                const cur = jobid ? all.find((d) => String(d.data && d.data.jobid) === jobid) : all.find((d) => !d.finished);
                                if (cur && cur.finished) { cb(null); return; }
                                cb(new Error('回复已提交但任务点未标记完成（讨论卡片可能未刷新或平台延迟）'));
                            }, waitMs);
                        });
                    });
                });
            },
            _handleDiscussTasks() {
                if (this._discussTaskBusy) return true;
                const list = this._findDiscussTaskFrames().filter((d) => !d.finished);
                if (!list.length) return false;
                if (!this.configs.discussTaskAuto) {
                    console.warn('%c[讨论任务] 检测到 ' + list.length + ' 个未完成讨论任务点（BBS）：按当前配置不自动参与，已停止自动前进（绝不跳过）。'
                        + '开启：app.configs.discussTaskAuto = true', 'color:#FF9800');
                    return true;
                }
                this._discussTaskBusy = true;
                console.log('%c[讨论任务] 检测到 ' + list.length + ' 个未完成讨论任务点（BBS），开始自动参与…', 'color:#2196F3');
                const nextTask = (idx) => {
                    if (idx >= list.length) {
                        this._discussTaskBusy = false;
                        console.log('%c[讨论任务] 已全部参与完成，继续推进', 'color:#4CAF50');
                        this._schedule(() => this.play(), 2000);
                        return;
                    }
                    this._discussParticipate(list[idx], (err) => {
                        if (err) {
                            this._discussTaskBusy = false;
                            console.warn('%c[讨论任务] 自动参与未完成：' + (err.message || err) + '；已停止自动前进，请人工处理', 'color:#FF9800');
                            return;
                        }
                        nextTask(idx + 1);
                    });
                };
                nextTask(0);
                return true;
            },
            destroy() {
                this._isPlaying = false;
                this._nextUnitPending = false;
                // 幂等/可注销审计：启动轮询定时器挂在 window[BOOT_TIMER_KEY] 上（不属于 app 实例），
                // destroy() 也要把它停掉，否则「目录未就绪时 destroy() → 20 秒后又被启动」会重新拉起脚本。
                if (window[BOOT_TIMER_KEY]) {
                    clearInterval(window[BOOT_TIMER_KEY]);
                    window[BOOT_TIMER_KEY] = null;
                }
                this._clearCheckInterval();
                this._stopInteractionWatcher();
                this._unbindVisibilityRecovery();
                // F9（V3.5）：移除 GUI 面板并注销 console 镜像，避免脚本重载后面板/监听叠加。
                this._guiDestroy();
                // F10（V3.5）：中止在途 LLM 请求，避免 destroy 后回调再操作页面。
                this._llmCancelInFlight('destroy');
                // F68（V3.7）：人脸等待状态清零，避免 destroy→run 后残留「等人脸」标志导致自动推进停摆。
                this._faceWaitActive = false;
                this._faceWaitNotified = false;
                // F4（#32 #54 #55）：守卫相关的延时器、视频事件、用户交互监听全部清理干净。
                this._clearTimers();
                this._detachVideoEvents();
                this._invalidateVideoCache('destroy');
                this._treeContainerEl = null;
                this._stepNavigationBound = false;
                $(document).off('.xuexitongPlayerV3');
                // F4（#26 #54）：不再在 document/window 上劫持 mouseleave/mouseout，
                // 因此这里也没有全局 preventDefault 监听需要移除（旧实现的劫持已被整体删除）。
                this._userPaused = false;
                this._interactionBlocked = false;
                this._currentVideoTaskIndex = 0;
                this._videoTaskAllComplete = false;
                this._handlingVideoEnd = false;
                this._taskDialogClicksThisUnit = 0;
                this._taskDialogCapLogged = false;
                this._seekBackTimesThisUnit = 0;
                this._seekBackCapLogged = false;
                this._userMutedChoice = null;
                this._unbindUserMuteTracking();
                this._consecutiveNoVideoAdvances = 0;
                this._resumeAttemptsThisUnit = 0;
                this._resumeCapLogged = false;
                console.log('%c脚本已停止（destroy）：定时器、视频事件与页面监听均已清理。', 'color:#607D8B');
            },
        };

        window.app = app;
        window[APP_KEY] = app;
        // F10（V3.5）：油猴 @grant GM_xmlhttpRequest 后脚本运行在沙箱中，
        // 补一条 unsafeWindow 桥，保证页面控制台里的 app.run()/app.setLlmKey() 调试流程仍可用。
        try {
            if (typeof unsafeWindow !== 'undefined' && unsafeWindow && unsafeWindow !== window) {
                unsafeWindow.app = app;
                unsafeWindow[APP_KEY] = app;
            }
        } catch (e) { /* 页面上下文（直贴脚本）没有 unsafeWindow，忽略 */ }

        try {
            app.run();
        } catch (error) {
            // F7（#4 #5 #16 #17 #18 #23 #33 #47）：启动失败必须给出可操作提示，而不是丢一个看不懂的报错。
            console.error('%c脚本运行失败: ', 'color:#F44336;font-weight:bold', error && error.message ? error.message : error);
            console.log('处理方法：1) 确认当前是学习通课程播放页（地址含 /mycourse/studentstudy）；'
                + '2) 等左侧目录渲染完成后执行 app.run()；3) 仍失败请刷新页面；4) 也可改用油猴版 v3_optimized.user.js。');
        }
    }
})();