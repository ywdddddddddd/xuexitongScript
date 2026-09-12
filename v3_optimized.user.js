// ==UserScript==
// @name         学习通自动刷课脚本 V3.6
// @namespace    local.codex.xuexitong
// @version      3.6.0
// @description  自动播放、自动切换下一小节；V3.6 内嵌章节测验自动作答（默认关闭，绝不跳过）；V3.5 GUI 面板与互动题应答；沿用 V3.4 导航/播放/风控修复（详见 README）
// @author       Codex
// @match        *://mooc1.chaoxing.com/mycourse/studentstudy*
// @match        *://*.chaoxing.com/mycourse/studentstudy*
// @match        *://*.chaoxing.com/mooc2-ans/mycourse/studentstudy*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      opencode.ai
// ==/UserScript==

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
                // 思路移植自 PR #48 @CsuCook1e：任务点弹窗节流与视频任务点上限（本仓库额外加了次数上限，防止异常页面下无限点）
                taskDialogClickCooldownMs: 8000,
                taskDialogMaxClicksPerUnit: 3,
                videoTaskFrameMaxDepth: 4,
                videoTaskFrameMaxCount: 12,
                // F12（V3.6）：片尾停滞保护——已播放达到该比例且平台已标记任务点完成时，视同片尾完成直接推进。
                videoCompleteRatio: 0.9,
                // F15（V3.6）：拦截平台「鼠标移出页面自动暂停」的防挂机暂停（真机实测：window 上 mouseout 监听调用 pause()）。
                // 只拦截「无用户意图」的暂停；最近 1.5 秒有点击/按键的操作仍正常放行。
                pauseGuard: true,
                // F17（V3.6）：font-cxsecret 反copy字体自动解密（用系统 Noto Sans SC 做字形匹配）。
                cxSecretDecode: true,
                // F13（V3.6）：文档任务点（PDF/PPT/教案）自动翻阅。默认关闭；开启后自动滚动文档到底部并等待平台标记完成。
                docTaskScroll: false,
                docTaskScrollStepMs: 800,
                // F13 修正：懒加载文档越滚越长，步数上限会误判「到底」；改为时间上限 + 「到底且高度稳定」双条件。
                docTaskMaxMs: 240000,
                docTaskWaitMs: 45000,
                docTaskAttempts: 2,
                // F9（V3.5）：GUI 可视化面板。纯本地 DOM，不产生任何额外网络请求。
                guiEnabled: true,
                guiMaxLogLines: 60,
                // F10（V3.5）：LLM 互动题应答。默认关闭；开启后才会访问 llmEndpoint。
                // 密钥只存内存：GUI 面板「设置 Key」或控制台 app.setLlmKey(...)。
                llmEnabled: false,
                llmEndpoint: 'https://opencode.ai/zen/go/v1/chat/completions',
                llmModel: 'deepseek-flash',
                // 实测：推理模型在 max_tokens 过小时会把配额耗在 reasoning 上导致 content 为空，必须 >= 1024。
                llmMaxTokens: 4096, // 实测：推理 token 可达 1600+，1024 会把配额吃光导致空响应（finish_reason=length）
                // true=请求体带 response_format:{"type":"json_object"}，约束模型只输出 JSON；自定义端点不支持时设为 false。
                llmJsonMode: true,
                llmTimeoutMs: 30000,
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
            _llmAnswersThisSession: 0,
            _llmLastAnswer: null,
            _llmLastQuestionKey: '',
            _llmWarnedNoKeyOnce: false,
            _llmChapterSuggesting: false,
            _llmChapterSuggestDone: false,
            _llmChapterSuggestedCount: 0,
            _workBusy: false,
            _docTaskBusy: false,
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
                this._currentVideoTaskIndex = 0;
                this._videoTaskCount = 0;
                this._videoTaskAllComplete = false;
                this._handlingVideoEnd = false;
                this._taskDialogClicksThisUnit = 0;
                this._taskDialogCapLogged = false;
                this._seekBackTimesThisUnit = 0;
                this._seekBackCapLogged = false;
                this._llmChapterSuggesting = false;
                this._llmChapterSuggestDone = false;
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
            _checkVideoStatus() {
                try {
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

                    // F12（V3.6）：片尾停滞保护 —— 平台会在片尾主动暂停（恢复次数耗尽后假死）。已播放 ≥ videoCompleteRatio
                    // 且平台已完成标记时，视同片尾完成直接推进（真机演练：4、宋 元 卡在 255/261，平台已 complete=true）。
                    if (this._isPlaying && !video.ended) {
                        try {
                            const ratio = Number(this.configs.videoCompleteRatio) || 0.9;
                            const frames = this._getVideoTaskFrames ? this._getVideoTaskFrames() : [];
                            const platformDone = frames.length > 0 && this._areAllVideoTasksComplete ? this._areAllVideoTasksComplete(frames) : false;
                            if (platformDone && video.duration > 0 && current / video.duration >= ratio) {
                                console.log('%c视频已播放 ≥ ' + Math.round(ratio * 100) + '% 且平台已标记任务点完成，按片尾完成处理并推进', 'color:#4CAF50');
                                this._handleVideoEnded();
                                return;
                            }
                        } catch (e) { /* 保底：不阻塞主流程 */ }
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
                    const el = this._getVideoEl();
                    if (el == null) {
                        if (this._currentStepTitle() === '视频') {
                            throw new Error('视频组件尚未加载完成');
                        }
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
                        if (this._advanceLearningStep()) {
                            console.log('%c当前不在视频页，已尝试切到下一学习步骤，2秒后重试', 'color:#607D8B');
                            this._schedule(() => {
                                this.play();
                            }, 2000);
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
                    this._videoEventHandle();
                    el.playbackRate = this.configs.playbackRate;
                    // F4（#19 #32）：不默认强制静音；只沿用用户此前手动选择过的静音状态。
                    this._applyUserMuteChoice(el);

                    try {
                        // PR #56：play() 可能永不 settle，这里加超时保护，超时按播放失败处理（重试/静音兜底）。
                        await this._withTimeout(el.play(), this.configs.playTimeoutMs, 'play() 超时，播放器未进入播放状态');
                        this._tryTimes = 0;
                        console.log(`%c视频开始播放，倍速: ${el.playbackRate}x`, 'color:#4CAF50');
                        this._startVideoMonitoring();
                    } catch (playError) {
                        console.error('视频播放失败:', playError);
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
            _handleNoVideoNode() {
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

                if (verdict.completed) {
                    if (this._consecutiveNoVideoAdvances >= this.configs.maxConsecutiveNoVideoAdvances) {
                        console.error(`%c连续自动前进已达上限（${this.configs.maxConsecutiveNoVideoAdvances} 次），已停止以避免死循环（#38 #43）。`, 'color:#F44336;font-weight:bold');
                        console.log('处理方法：请人工确认课程目录结构；确认无误后可执行 app.nextUnit() 逐节跳过，或执行 app.run() 重新开始。');
                        this._releaseNavLock('无视频自动前进触顶');
                        return;
                    }
                    this._consecutiveNoVideoAdvances++;
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
            _isCompleteTaskClass(value) {
                // 思路移植自 PR #48 @CsuCook1e（_isCompleteTaskClass）：覆盖 ans-job-finished 这类真实任务点类名。
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
                this._currentVideoTaskIndex = 0;
                this._llmChapterSuggesting = false;
                this._llmChapterSuggestDone = false;
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
            _getVideoEl() {
                // F6（#18 #52 #55）：扩大选择器覆盖 + 提高嵌套 frame 搜索深度（带上限）+ 缓存失效。
                if (this._videoEl && this._videoEl.isConnected === false) {
                    this._invalidateVideoCache('缓存的视频节点已脱离文档（iframe 重载）');
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
                ].join(', ');
                let candidates = [];
                try {
                    candidates = Array.from(rootDoc.querySelectorAll(selector));
                } catch (e) {
                    candidates = [];
                }
                const promptRe = /(请选择|请回答|请作答|选择你认为|判断题|单选题|多选题|请你判断)/;
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
                    try {
                        frameDoc = frame.contentDocument || (frame.contentWindow ? frame.contentWindow.document : null);
                    } catch (e) {
                        frameDoc = null;
                    }
                    if (!frameDoc) continue;
                    const nested = this._findInteractionDialog(frameDoc, depth + 1);
                    if (nested) return nested;
                }
                return null;
            },
            _checkInteractionDialog() {
                if (!this.configs.interactionGuard) return null;
                // 章节测验页自身就有题目容器：那里沿用原有的「受限跳转」逻辑，不做互动弹窗判定，
                // 避免把正常章节测验误判成视频互动弹窗。
                if (this._isChapterTest()) return null;
                const found = this._findInteractionDialog(document, 0);
                if (found) {
                    // F10（V3.5）：仅当显式开启 LLM 且配置齐全时尝试自动选择；失败一律回退「暂停等人工」。
                    if (!this._interactionBlocked && this._canLlmAnswer(found)) {
                        this._answerInteractionWithLlm(found);
                    } else if (!this._interactionBlocked) {
                        this._blockInteractionForManual(found);
                    }
                } else if (this._interactionBlocked) {
                    this._interactionBlocked = false;
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
            _startInteractionWatcher() {
                // F5（#29 #39）：只检测、只暂停；全脚本没有任何自动答题/外部模型调用。
                if (!this.configs.interactionGuard) return;
                if (this._interactionWatcher) return;
                this._interactionWatcher = setInterval(() => {
                    try {
                        this._checkInteractionDialog();
                        this._guiRefreshStatus(false);
                        if (!this._interactionBlocked) {
                            // 思路移植自 PR #48 @CsuCook1e：平台弹「当前章节还有任务点未完成」时，
                            // 点「去学习/去完成」回到未完成任务点（受冷却与次数上限约束），不点「下一节」硬闯。
                            this._handleTaskPointDialog('monitor');
                        }
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
                panel.style.cssText = 'position:fixed;top:10px;right:10px;width:330px;max-height:48vh;z-index:2147483000;'
                    + 'background:rgba(17,24,39,0.94);color:#e5e7eb;font:12px/1.5 Consolas,Menlo,monospace;'
                    + 'border:1px solid #374151;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.35);overflow:hidden;';
                const header = document.createElement('div');
                header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:6px 8px;background:#1f2937;';
                const title = document.createElement('span');
                title.textContent = '学习通脚本监控 ' + this.version;
                title.style.cssText = 'font-weight:bold;color:#93c5fd;';
                const collapseBtn = document.createElement('button');
                collapseBtn.type = 'button';
                collapseBtn.textContent = '—';
                collapseBtn.title = '折叠/展开';
                collapseBtn.style.cssText = 'background:#374151;color:#e5e7eb;border:0;border-radius:4px;width:22px;height:18px;line-height:1;cursor:pointer;';
                header.appendChild(title);
                header.appendChild(collapseBtn);
                const bodyWrap = document.createElement('div');
                bodyWrap.style.cssText = 'padding:6px 8px;';
                const statusEl = document.createElement('div');
                statusEl.style.cssText = 'white-space:pre-wrap;color:#cbd5e1;';
                const logEl = document.createElement('pre');
                logEl.style.cssText = 'margin:6px 0 0;padding:4px 6px;max-height:170px;overflow:auto;background:#0b1220;'
                    + 'border-radius:6px;color:#9ca3af;font:11px/1.45 Consolas,Menlo,monospace;white-space:pre-wrap;word-break:break-all;';
                const btnRow = document.createElement('div');
                btnRow.style.cssText = 'display:flex;gap:4px;margin-top:6px;flex-wrap:wrap;';
                const addBtn = (label, help, handler) => {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.textContent = label;
                    b.title = help;
                    b.style.cssText = 'background:#374151;color:#e5e7eb;border:0;border-radius:4px;padding:2px 6px;font-size:11px;cursor:pointer;';
                    b.addEventListener('click', handler);
                    btnRow.appendChild(b);
                    return b;
                };
                addBtn('暂停/继续', '暂停或恢复自动播放', () => {
                    if (this._isPlaying) {
                        this._clearCheckInterval();
                        this._isPlaying = false;
                        console.log('%c[GUI] 已暂停自动播放（点「暂停/继续」恢复）', 'color:#FF9800');
                    } else {
                        console.log('%c[GUI] 恢复自动播放', 'color:#4CAF50');
                        this.play();
                    }
                });
                addBtn('下一节', '立即切换到下一小节', () => this.nextUnit());
                addBtn('LLM 开/关', '切换 llmEnabled（默认关闭）', () => {
                    this.configs.llmEnabled = !this.configs.llmEnabled;
                    console.log('%c[GUI] LLM 应答已' + (this.configs.llmEnabled ? '开启' : '关闭'), 'color:#2196F3');
                    this._guiRefreshStatus(true);
                });
                addBtn('自动提交 开/关', '切换 llmAutoSubmit（默认关闭：先选答案再人工提交）', () => {
                    this.configs.llmAutoSubmit = !this.configs.llmAutoSubmit;
                    console.log('%c[GUI] LLM 自动提交已' + (this.configs.llmAutoSubmit ? '开启' : '关闭'), 'color:#2196F3');
                    this._guiRefreshStatus(true);
                });
                addBtn('设置 Key', '设置 LLM API Key（只保存在当前页面内存）', () => this._guiAskKey());
                addBtn('清空日志', '清空面板日志', () => {
                    this._guiLogs = [];
                    if (logEl) logEl.textContent = '';
                });
                bodyWrap.appendChild(statusEl);
                bodyWrap.appendChild(logEl);
                bodyWrap.appendChild(btnRow);
                panel.appendChild(header);
                panel.appendChild(bodyWrap);
                const onCollapse = () => {
                    this._guiCollapsed = !this._guiCollapsed;
                    bodyWrap.style.display = this._guiCollapsed ? 'none' : 'block';
                    collapseBtn.textContent = this._guiCollapsed ? '+' : '—';
                };
                collapseBtn.addEventListener('click', onCollapse);
                this._guiPanelEl = panel;
                this._guiStatusEl = statusEl;
                this._guiLogEl = logEl;
                this._guiBodyEl = bodyWrap;
                this._guiCollapseHandler = onCollapse;
                document.body.appendChild(panel);
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
                if (!force && now - (this._guiLastRefreshTs || 0) < 500) return;
                this._guiLastRefreshTs = now;
                try {
                    const cell = this._cellData || {};
                    const chapters = Number(cell.cells) || 0;
                    const videos = Number(this._videoTaskCount) || 0;
                    const lines = [];
                    lines.push('状态: ' + (this._isPlaying ? '播放中' : '空闲')
                        + ' ｜ 步骤: ' + (this._currentStepTitle() || '未知')
                        + ' ｜ 互动题: ' + (this._interactionBlocked ? '暂停（等人工）' : '正常'));
                    lines.push('进度: 章节 ' + ((Number(cell.currentCellIndex) || 0) + 1) + '/' + (chapters || '?')
                        + ' ｜ 视频任务点 ' + (videos ? ((Number(this._currentVideoTaskIndex) || 0) + 1) + '/' + videos : '?'));
                    lines.push('LLM: ' + (this.configs.llmEnabled ? '开' : '关')
                        + ' ｜ 密钥: ' + (this._llmApiKey ? '已配置' : '未配置')
                        + ' ｜ 已应答: ' + this._llmAnswersThisSession + '/' + this.configs.llmMaxAnswersPerSession
                        + ' ｜ 自动提交: ' + (this.configs.llmAutoSubmit ? '开' : '关'));
                    if (this._llmLastAnswer) lines.push('最近答案: ' + this._llmLastAnswer.q + ' → ' + this._llmLastAnswer.a);
                    if (this._llmChapterSuggestedCount) lines.push('章节测验建议: ' + this._llmChapterSuggestedCount + ' 题（仅提示，需人工确认）');
                    this._guiStatusEl.textContent = lines.join('\n');
                } catch (e) { /* ignore */ }
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
                const cfg = this.configs;
                const timeoutMs = Math.max(1000, Number(cfg.llmTimeoutMs) || 30000);
                let timer = null;
                let settled = false;
                const finish = (ok, a, b) => {
                    if (settled) return;
                    settled = true;
                    this._llmInFlight = false;
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
            _llmExtractAnswer(text) {
                const raw = String(text == null ? '' : text);
                // 优先取「最后一个」JSON 对象：推理模型可能把示例/推理过程写进 content，末尾的才是最终答案。
                const jsonCandidates = raw.match(/\{[^{}]{0,400}\}/g) || [];
                for (let i = jsonCandidates.length - 1; i >= 0; i--) {
                    try {
                        const obj = JSON.parse(jsonCandidates[i]);
                        const value = obj && (obj.answer != null ? obj.answer : (obj.result != null ? obj.result : obj.choice));
                        if (value != null && String(value).trim()) return String(value).trim();
                    } catch (e) { /* 继续尝试更早的 JSON */ }
                }
                const labeled = raw.match(/(?:答案|选项|answer)\s*[:：是为]?\s*([A-Ha-h])/i);
                if (labeled && labeled[1]) return labeled[1].toUpperCase();
                const compact = raw.replace(/[\s\u0060*\u0022\u0027。．]+/g, '');
                if (compact.length <= 8) {
                    const judge = this._llmNormalizeJudge(compact);
                    if (judge) return judge;
                }
                const bracketed = raw.match(/(?:^|[^A-Za-z])([A-H])(?:\s*[\)、.．:：]|\s*$)/);
                if (bracketed && bracketed[1]) return bracketed[1];
                return '';
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
            _llmBuildMessages(question, options) {
                const opts = Array.isArray(options) ? options : [];
                const lines = opts.map((o, i) => {
                    const label = o && o.letter ? String(o.letter) : String.fromCharCode(65 + i);
                    const body = String(o && o.text ? o.text : '').replace(/^[A-H][、.．:：\s]+/, '').trim();
                    return label + '、' + body;
                });
                const system = '你是课程答题助手。根据题目与选项选出唯一正确答案，只输出一个 JSON 对象，'
                    + '不要解释、不要 Markdown、不要推理过程：{"answer":"选项字母"}。'
                    + '判断题没有字母选项时，answer 输出 "对" 或 "错"。';
                const user = '题目：' + String(question || '').slice(0, 500)
                    + '\n选项：\n' + lines.join('\n')
                    + '\n只输出 JSON，例如 {"answer":"A"}。';
                return [
                    { role: 'system', content: system },
                    { role: 'user', content: user },
                ];
            },
            _llmPickOption(options, answer) {
                const list = Array.isArray(options) ? options : [];
                const ans = String(answer == null ? '' : answer).trim();
                if (!list.length || !ans) return null;
                const upper = ans.toUpperCase();
                for (const opt of list) {
                    const letter = String(opt.letter || '').toUpperCase();
                    if (letter && letter === upper) return opt;
                    const t = String(opt.text || '').toUpperCase();
                    if (t.indexOf(upper + '、') === 0 || t.indexOf(upper + '.') === 0 || t.indexOf(upper + '．') === 0) return opt;
                }
                const judge = this._llmNormalizeJudge(ans);
                if (judge) {
                    for (const opt of list) {
                        const t = String(opt.text || '');
                        if (judge === '对' && /正确|^对$|√|true/i.test(t)) return opt;
                        if (judge === '错' && /错误|^错$|×|false/i.test(t)) return opt;
                    }
                }
                const normalized = ans.replace(/^[A-Ha-h][、.．:：\s]*/, '').trim();
                if (normalized) {
                    for (const opt of list) {
                        const t = String(opt.text || '').replace(/^[A-Ha-h][、.．:：\s]*/, '').trim();
                        if (t && (t === normalized || t.indexOf(normalized) >= 0 || normalized.indexOf(t) >= 0)) return opt;
                    }
                }
                return null;
            },
            _llmQuestionKey(found) {
                const t = String((found && (found.questionText || found.text)) || '');
                if (!t) return '';
                let hash = 0;
                for (let i = 0; i < t.length; i++) hash = ((hash << 5) - hash + t.charCodeAt(i)) | 0;
                return 'q' + hash;
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
                const questionKey = this._llmQuestionKey(found);
                if (questionKey && questionKey === this._llmLastQuestionKey) return;
                this._llmLastQuestionKey = questionKey;
                const options = found.options.slice(0, 8).map((opt, index) => ({
                    letter: opt.letter || String.fromCharCode(65 + index),
                    text: opt.text,
                    el: opt.el,
                }));
                const question = String(found.questionText || found.text || '').slice(0, 500);
                console.log('%c[LLM] 检测到互动题，正在请求大模型作答（结果会显示在本面板）…', 'color:#2196F3');
                this._guiRefreshStatus(true);
                this._llmRequest(
                    this._llmBuildPayload(this._llmBuildMessages(question, options)),
                    (text) => this._applyInteractionAnswer(found, options, text),
                    (err) => {
                        console.warn('%c[LLM] 请求失败，回退为人工处理：' + (err && err.message ? err.message : String(err)), 'color:#FF9800');
                        this._llmLastQuestionKey = '';
                        if (!this._interactionBlocked) this._blockInteractionForManual(found);
                    }
                );
            },
            _applyInteractionAnswer(found, options, responseText) {
                const answer = this._llmExtractAnswer(responseText);
                const chosen = this._llmPickOption(options, answer);
                if (!chosen || !chosen.el) {
                    console.warn('%c[LLM] 无法解析答案（原始返回: ' + String(responseText || '').slice(0, 160) + '），回退为人工处理', 'color:#FF9800');
                    this._llmLastQuestionKey = '';
                    if (!this._interactionBlocked) this._blockInteractionForManual(found);
                    return;
                }
                this._llmAnswersThisSession++;
                this._llmLastAnswer = {
                    q: String(found.text || '').slice(0, 40),
                    a: String(answer || '').slice(0, 20),
                };
                try {
                    if (typeof chosen.el.click === 'function') chosen.el.click();
                    else if (chosen.el.querySelector) {
                        const input = chosen.el.querySelector('input[type=radio], input[type=checkbox]');
                        if (input && typeof input.click === 'function') input.click();
                    }
                } catch (e) {
                    console.warn('%c[LLM] 选项点击失败：' + (e && e.message ? e.message : String(e)), 'color:#FF9800');
                }
                console.log('%c[LLM] 已选择答案 ' + answer + '（' + String(chosen.text || '').slice(0, 40) + '）', 'color:#9C27B0');
                this._guiRefreshStatus(true);
                const submitEl = this._findInteractionSubmit(found);
                if (!submitEl) {
                    console.warn('%c[LLM] 未找到提交/继续按钮：答案已选好，请手动提交（弹窗消失后脚本自动恢复）', 'color:#FF9800');
                    return;
                }
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
            },
            _findInteractionSubmit(found) {
                const scope = found && found.el;
                if (!scope || !scope.querySelectorAll) return null;
                const selectors = [
                    '.answerQuestion .submitBtn',
                    '.interaction .submitBtn',
                    '[class*="answer"] [class*="btn"]',
                    '[class*="question"] [class*="btn"]',
                    'button',
                    'a',
                ];
                const words = /^(提交|继续|下一节|确定|完成|我知道了|确定提交|继续播放)$/;
                for (const sel of selectors) {
                    let nodes = [];
                    try { nodes = Array.from(scope.querySelectorAll(sel)); } catch (e) { nodes = []; }
                    for (const node of nodes) {
                        const t = String(node.textContent || '').replace(/\s+/g, '');
                        if (words.test(t)) return node;
                    }
                }
                return null;
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
                let doc = null;
                try { doc = workFrame.contentDocument; } catch (e) { doc = null; }
                if (!doc) return null;
                let inner = null;
                try { inner = doc.querySelector('#frame_content'); } catch (e) { inner = null; }
                if (inner) {
                    try {
                        const d = inner.contentDocument;
                        if (d && d.querySelector && d.querySelector('.TiMu')) return { doc: d, win: d.defaultView, frame: inner };
                    } catch (e) { /* ignore */ }
                }
                try {
                    if (doc.querySelector && doc.querySelector('.TiMu')) return { doc: doc, win: doc.defaultView, frame: null };
                } catch (e) { /* ignore */ }
                return null;
            },
            // ================= F17（V3.6）：font-cxsecret 字形解密 =================
            // 原理：平台用「思源黑体子集」做反copy字体（乱码 codepoint → 真实字形）。系统装有 Noto Sans SC
            // （与思源黑体同一套字形设计），把乱码字与全 CJK 候选用同尺寸渲染做墨迹归一化位图匹配即可还原明文。
            // 真机验证：媕媑媒媖媓媔念 → 简析版画的概念（与已知明文完全一致，字面得分 0）。
            _cxSecretFontB64() {
                if (this._cxFontB64) return this._cxFontB64;
                let found = '';
                const seen = new Set();
                const visit = (doc, depth) => {
                    if (!doc || depth > 6 || found || seen.has(doc)) return;
                    seen.add(doc);
                    try {
                        for (const sheet of Array.from(doc.styleSheets || [])) {
                            try {
                                for (const rule of Array.from(sheet.cssRules || [])) {
                                    const t = rule.cssText || '';
                                    if (t.indexOf('font-cxsecret') >= 0 && t.indexOf('base64,') >= 0) {
                                        found = t.split('base64,')[1].split('"')[0].split(')')[0];
                                        return;
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
                this._cxFontB64 = found;
                return found;
            },
            _cxSecretDecode(texts, cb) {
                const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t == null ? '' : t));
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
                const finish = () => done(list.map((t) => t.replace(/[\u4e00-\u9fa5]/g, (ch) => (Object.prototype.hasOwnProperty.call(cached, ch) ? cached[ch] : ch))));
                if (!todo.length) { finish(); return; }
                const b64 = this._cxSecretFontB64();
                if (!b64) { console.warn('%c[字库解密] 未找到 font-cxsecret 字体，跳过解码', 'color:#FF9800'); finish(); return; }
                const run = () => {
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
                        for (const ch of todo) {
                            const tb = bmp(ch, 'xt_cxsecret');
                            if (!tb) { cached[ch] = ch; continue; }
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
                        if (matched.length) console.log('%c[字库解密] 已还原 ' + matched.length + ' 个混淆字：' + matched.slice(0, 20).join(' '), 'color:#4CAF50');
                        finish();
                    } catch (e) { console.warn('%c[字库解密] 失败：' + (e && e.message ? e.message : e), 'color:#FF9800'); finish(); }
                };
                if (!this._cxFontLoaded && typeof FontFace !== 'undefined' && document.fonts) {
                    try {
                        const ff = new FontFace('xt_cxsecret', 'url(data:font/ttf;base64,' + b64 + ')');
                        ff.load().then(() => { document.fonts.add(ff); this._cxFontLoaded = true; run(); }).catch(() => { run(); });
                    } catch (e) { run(); }
                } else { run(); }
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
                    try { optionEls = Array.from(timu.querySelectorAll('.Zy_ulTop li, .Zy_ulTk li')).map((li) => ({ el: li, text: (li.textContent || '').replace(/\s+/g, ' ').trim() })); } catch (e) { optionEls = []; }
                    let editorCount = 0;
                    try { editorCount = timu.querySelectorAll('.edui-editor').length; } catch (e) { editorCount = 0; }
                    const isShortAnswer = (optionEls.length === 0 && editorCount > 0) || /简答|论述|分析|写作|资料/.test(typeLabel) || ['4', '5', '18', '26'].indexOf(typeCode) >= 0;
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
            _submitWork(quizWin, topDoc, done) {
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
                    const quiz = this._quizDocOf(work.frame);
                    if (!quiz || !quiz.doc) {
                        this._workBusy = false;
                        console.warn('%c[LLM] 未能定位测验内容，已停止自动前进（绝不跳过）', 'color:#FF9800');
                        return;
                    }
                    const questions = this._workQuestionList(quiz.doc);
                    if (!questions.length) {
                        this._workBusy = false;
                        console.warn('%c[LLM] 未识别到题目结构，已停止自动前进（绝不跳过）', 'color:#FF9800');
                        return;
                    }
                    const texts = this._workPlainTexts(work.title, questions.length);
                    console.log('%c[LLM] 作业《' + String(work.title || work.jobid).slice(0, 60) + '》共 ' + questions.length + ' 题', 'color:#2196F3');
                    const giveUp = (msg) => {
                        this._workBusy = false;
                        console.warn('%c[LLM] 内嵌测验自动作答失败：' + msg + '；已停止自动前进，请人工处理', 'color:#FF9800');
                    };
                    const askNext = (qi) => {
                        if (qi >= questions.length) {
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
                        const rawQuestion = texts[qi] || q.rawText || String(work.title || '');
                        const rawOptions = q.optionEls.map((o) => o.text);
                        // F17：先解密 font-cxsecret 混淆文本（题干 + 选项），再交给 LLM 作答/匹配。
                        this._cxSecretDecode([rawQuestion].concat(rawOptions), (decoded) => {
                            const questionText = decoded[0] || rawQuestion;
                            if (q.isShortAnswer) {
                                console.log('%c[LLM] 第 ' + (qi + 1) + ' 题（写作/简答）作答中：' + String(questionText).slice(0, 50), 'color:#2196F3');
                                this._llmRequest(
                                    this._llmBuildPayload(this._llmBuildShortMessages(questionText)),
                                    (content) => {
                                        const text = this._llmExtractFreeText(content);
                                        const ok = this._fillWorkAnswer(quiz.win, q, text);
                                        console.log('%c[LLM] 第 ' + (qi + 1) + ' 题答案' + (ok ? '已填入编辑器' : '填充失败') + '：' + String(text).slice(0, 60), ok ? 'color:#9C27B0' : 'color:#FF9800');
                                        if (!ok) { giveUp('第 ' + (qi + 1) + ' 题答案填充失败'); return; }
                                        askNext(qi + 1);
                                    },
                                    (err) => giveUp('第 ' + (qi + 1) + ' 题请求失败：' + (err && err.message ? err.message : err))
                                );
                                return;
                            }
                            const options = q.optionEls.map((o, i) => ({ el: o.el, text: decoded[i + 1] || o.text, letter: String.fromCharCode(65 + i) }));
                            this._llmRequest(
                                this._llmBuildPayload(this._llmBuildMessages(questionText, options)),
                                (content) => {
                                    const answer = this._llmExtractAnswer(content);
                                    const chosen = this._llmPickOption(options, answer);
                                    if (!chosen) { giveUp('第 ' + (qi + 1) + ' 题无法匹配选项'); return; }
                                    try { chosen.el.click(); } catch (e) { /* ignore */ }
                                    console.log('%c[LLM] 第 ' + (qi + 1) + ' 题已选择：' + String(chosen.text || '').slice(0, 40), 'color:#9C27B0');
                                    askNext(qi + 1);
                                },
                                (err) => giveUp('第 ' + (qi + 1) + ' 题请求失败：' + (err && err.message ? err.message : err))
                            );
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
                if (docTask.finished) { this._processDocTasks(docs, idx + 1, done); return; }
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
                            const still = this._findDocTaskFrames().filter((d) => !d.finished);
                            if (!still.length) { done(true, ''); return; }
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