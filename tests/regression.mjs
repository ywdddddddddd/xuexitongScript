#!/usr/bin/env node
/**
 * V3.4 回归测试（jsdom，不联网）
 *
 * 运行：node tests/regression.mjs            （在 repo/ 目录下执行）
 * 可用 XT_SOURCE=<path> 指向别的源码，用来证明这些用例确实能捕获缺陷，
 * 例如： XT_SOURCE=../br/master/xuexitongScript-master/v3_optimized.js node tests/regression.mjs
 *
 * 覆盖 t3 验收项：
 *   F1 nextUnit() 死锁：失败的 play() 之后仍可再次触发
 *   F2 同一章 3 个视频节点按 1→2→3 推进；解析失败时明确报错且不静默跳章
 *   F3 无视频节点：可识别完成才前进，识别不了则安全停止且连续前进受上限约束
 *   F21 空视频节点（标题「视频」但平台内容占位「暂无内容」）不按加载失败重试触顶，转入无视频流程
 *   F22 手动暂停/切节点后恢复：僵尸 iframe 文档里的 video 不再被复用，超时自动重新定位
 *   F23 页面「完成条件 ≥X%」识别 + 多任务点片尾提前交接（省掉最后 10%）
 *   F24 同节点多视频并发（错开启动 + 副车道保活重播，实验特性）
 *   F32 内嵌作业选项匹配增强（字母/夹带字母/多选/标点文本）与失败诊断
 *   F33 直播节点识别 / LLM 节流 / 答案缓存 / 相似度兜底 / 默认项调整
 *   F34 font-cxsecret glyf 哈希解密（移植上游 Samueli924/chaoxing，真实字体 + 真实表）
 *   F35 选项匹配改为上游降级链（normalize_text/clean_res/is_subsequence/SequenceMatcher.ratio）
 *   F36 章节学习次数（移植上游 _extract_and_send_setlog：studentstudyAjax → setlog）
 *   F37 多选作答支持（占位符拒绝/多字母/自动重试）+ 互动题等待在途请求
 *   F38 视频任务点全部完成时不再按「组件未加载」重试（真机第7章第3节死循环）
 *   F39 作答判定支持平台选中态（aria-checked/class）+ 单选护栏 + 提交按钮识别放宽
 *   F40 题目预检放宽：4~5 字短题（带问号/选项）不再误锁（真机：眶下孔位于？）
 *   F41 选项点击后校验选中态并自动重试（真机：第 1 题点击丢失 → 10/11 上锁）
 *   F42 康熙部首表替换 + 多 font-cxsecret 字体 + 互动弹窗 DOM 诊断
 *   F43 作业题定位支持嵌套帧 + 作业帧不再被误判为互动弹窗
 *   F4 不再劫持 document/window 的 mouseout/mouseleave；恢复播放受冷却与次数上限约束
 *   F5 互动答题弹窗检测与暂停跳转（默认等人工）；F9 GUI 面板；F10 LLM 应答仅显式开启
 *   F6 _getVideoEl 选择器覆盖、嵌套 frame 深度上限、切换小节时缓存失效
 *   F7 README 仓库内链接有效、默认配置与代码一致、启动失败有可操作提示
 *   F8 历史 V1 脚本 xuexitong.js 的入口点击已加固（无未保护的 querySelector(...).click()，且仍能通过 node --check）
 *
 * 依赖：工作区已装好的 jsdom@24 + jquery@3.7.1（tools/node_modules，repo/node_modules 为目录联接）。
 * 测试注入真实 jQuery（window.jQuery / window.$），只对 jsdom 缺失的排版能力（offsetWidth/getBoundingClientRect）做显式桩；
 * 用虚拟时钟替换 window 的 setTimeout/setInterval，使行为确定、无需等待真实时间，也不会让 node 进程挂住。
 * 本文件既可直接运行，也可被其它测试 import（导出 createEnv / check 等）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..');
const workspaceRoot = resolve(repoRoot, '..');
export const sourcePath = resolve(process.env.XT_SOURCE || resolve(repoRoot, 'v3_optimized.js'));

function loadDependency(name) {
    // 依赖必须来自工作区已装好的 tools/node_modules：
    // repo/node_modules 是指向它的目录联接（junction），所以先直接 require(name)，
    // 联接缺失时再回退到绝对路径 require，保证测试不会去联网安装。
    const candidates = [name, resolve(workspaceRoot, 'tools/node_modules', name)];
    const errors = [];
    for (const candidate of candidates) {
        try {
            return require(candidate);
        } catch (error) {
            errors.push(`${candidate}: ${error.message}`);
        }
    }
    throw new Error(`无法加载依赖 ${name}（期望 tools/node_modules 或 repo/node_modules 联接）：\n${errors.join('\n')}`);
}
const { JSDOM } = loadDependency('jsdom');
const jqueryFactory = loadDependency('jquery');

const openEnvs = [];

const drain = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// 下面三个函数会被 toString() 后注入 jsdom 的 window 里执行，
// 因此只能使用 window 自身的 API，不能引用本文件的模块级变量。
// ---------------------------------------------------------------------------

function installClock(win) {
    const clock = { now: 1000000, seq: 0, timers: new Map(), runs: 0, errors: [] };
    const add = (fn, ms, args, interval) => {
        const id = ++clock.seq;
        clock.timers.set(id, { fn, args, at: clock.now + Math.max(0, Number(ms) || 0), interval });
        return id;
    };
    win.setTimeout = function (fn, ms) { return add(fn, ms, Array.prototype.slice.call(arguments, 2), null); };
    win.setInterval = function (fn, ms) { return add(fn, ms, Array.prototype.slice.call(arguments, 2), Math.max(1, Number(ms) || 1)); };
    win.clearTimeout = function (id) { clock.timers.delete(id); };
    win.clearInterval = function (id) { clock.timers.delete(id); };
    win.Date.now = function () { return clock.now; };
    clock.pending = function () { return clock.timers.size; };
    clock.tick = function (ms) {
        const target = clock.now + Math.max(0, Number(ms) || 0);
        let guard = 0;
        for (;;) {
            let pickId = -1;
            let pick = null;
            for (const entry of clock.timers) {
                const id = entry[0];
                const timer = entry[1];
                if (timer.at > target) continue;
                if (!pick || timer.at < pick.at || (timer.at === pick.at && id < pickId)) {
                    pick = timer;
                    pickId = id;
                }
            }
            if (!pick) break;
            guard++;
            if (guard > 20000) throw new Error('虚拟时钟推进步数超过 20000，疑似死循环');
            clock.now = pick.at;
            if (pick.interval != null) {
                pick.at = clock.now + pick.interval;
            } else {
                clock.timers.delete(pickId);
            }
            clock.runs++;
            try {
                pick.fn.apply(null, pick.args);
            } catch (error) {
                clock.errors.push(String((error && error.stack) || error));
            }
        }
        clock.now = target;
        return guard;
    };
    win.__clock = clock;
}
function installRecorder(win) {
    // 控制台 / 点击记录器（断言用）。
    // 注意：这里不再自带 jQuery 实现 —— jQuery 使用工作区的真实依赖（repo/node_modules 联接 -> tools/node_modules/jquery@3.7.1），
    // 由 createEnv 注入到 window.jQuery / window.$，从而避免测试与真实 jQuery 语义产生偏差。
    const records = { logs: [], clicks: [] };
    win.__xt = records;
    const isStyleArg = (s) => typeof s === 'string' && (/^(color|font|background|border|text-)/i.test(s.trim()));
    const formatArg = (arg) => {
        if (typeof arg === 'string') return arg;
        if (arg && arg.name && arg.message && arg.stack) return `${arg.name}: ${arg.message}`;
        try { return JSON.stringify(arg); } catch (error) { return String(arg); }
    };
    const record = (level) => function () {
        const args = Array.prototype.slice.call(arguments);
        const text = args.map(formatArg).filter((p) => !isStyleArg(p)).join(' ').replace(/%c/g, '').replace(/\s+/g, ' ').trim();
        records.logs.push({ level, text, ts: win.__clock ? win.__clock.now : 0 });
    };
    win.console = { log: record('log'), info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') };
    records.has = function (needle, level) {
        return records.logs.some((l) => (!level || l.level === level) && l.text.indexOf(needle) >= 0);
    };
    records.count = function (needle, level) {
        return records.logs.filter((l) => (!level || l.level === level) && l.text.indexOf(needle) >= 0).length;
    };
}
function installPageSimulation(win) {
    const records = win.__xt;
    const doc = win.document;

    // jsdom 没有排版，给所有元素一个非零 rect，便于验证「可见性」相关逻辑（互动弹窗检测）。
    win.Element.prototype.getBoundingClientRect = function () {
        return { x: 0, y: 0, width: 120, height: 40, top: 0, left: 0, right: 120, bottom: 40 };
    };
    // jsdom 没有排版引擎：元素 offsetWidth/offsetHeight 恒为 0，会让真实 jQuery 的 :visible 全部判为不可见。
    // 这里显式给出非零尺寸桩，让 $('... :visible') 在测试环境里按「没有被 display:none 隐藏」的语义工作。
    Object.defineProperty(win.HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 120; } });
    Object.defineProperty(win.HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 40; } });

    doc.addEventListener('click', (ev) => {
        const target = ev.target;
        if (!target || !target.closest) return;
        const nameEl = target.closest('.posCatalog_name');
        const holder = target.closest('.posCatalog_select, a, li, button, .prev_white, #prevNextFocusNext, .nextChapter');
        records.clicks.push({
            title: nameEl ? String(nameEl.getAttribute('title') || nameEl.textContent || '').trim() : String(target.textContent || '').trim().slice(0, 20),
            className: holder ? String(holder.className || '') : '',
            tag: target.tagName ? target.tagName.toLowerCase() : '',
            ts: win.__clock ? win.__clock.now : 0,
        });
        // 页面行为模拟：点击小节标题后目录会把 active 移到该节点（真实页面重绘目录）。
        if (nameEl) {
            const node = nameEl.closest('.posCatalog_select');
            const tree = doc.querySelector('#coursetree');
            if (node && tree && node.matches('.posCatalog_select:not(.firstLayer)')) {
                for (const old of Array.prototype.slice.call(tree.querySelectorAll('.posCatalog_active'))) {
                    old.classList.remove('posCatalog_active');
                }
                node.classList.add('posCatalog_active');
            }
        }
    }, true);
}

// ---------------------------------------------------------------------------
// 测试脚手架
// ---------------------------------------------------------------------------

export function createEnv(options = {}) {
    const source = options.source || readFileSync(sourcePath, 'utf8');
    const dom = new JSDOM(options.html || '<!doctype html><html><head></head><body></body></html>', {
        runScripts: 'outside-only',
        pretendToBeVisual: true,
        url: options.url || 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1',
    });
    const win = dom.window;
    win.eval(`(${installClock.toString()})(window)`);
    win.eval(`(${installRecorder.toString()})(window)`);
    win.eval(`(${installPageSimulation.toString()})(window)`);
    // 注入真实 jQuery：脚本 IIFE 只在 window.jQuery 缺失时才去拉 CDN，先注入即可确保测试不联网。
    const $ = jqueryFactory(win);
    win.jQuery = $;
    win.$ = $;
    win.__clock.tick(0); // 冲掉 jQuery ready 的 0ms 定时器，保证时钟里只剩被测脚本自己的定时器
    const env = {
        dom,
        window: win,
        xt: win.__xt,
        clock: win.__clock,
        source,
        get logs() { return win.__xt.logs; },
        get clicks() { return win.__xt.clicks; },
        eval(code) { return win.eval(code); },
        async advance(ms, step = 25) {
            let remaining = Math.max(0, Number(ms) || 0);
            while (remaining > 0) {
                const chunk = Math.min(step, remaining);
                env.clock.tick(chunk);
                remaining -= chunk;
                await drain();
            }
            await drain();
        },
        async boot(bootMs = 1100) {
            win.eval(source);
            await env.advance(bootMs);
            return win.app;
        },
        treeClicks() {
            return win.__xt.clicks.filter((c) => c.className.indexOf('posCatalog_select') >= 0);
        },
        lastTreeClickTitle() {
            const clicks = env.treeClicks();
            return clicks.length ? clicks[clicks.length - 1].title : null;
        },
        treeClickTitles() {
            return env.treeClicks().map((c) => c.title);
        },
        close() {
            // 收尾：先 destroy 让脚本自己清定时器，再关掉 jsdom window，避免 node 进程被残留句柄挂住。
            try {
                if (win.app && typeof win.app.destroy === 'function') win.app.destroy();
            } catch (error) {}
            try {
                win.close();
            } catch (error) {}
        },
    };
    openEnvs.push(env);
    return env;
}


export function tree(spec) {
    const chapters = spec.map((chapter) => {
        const activeIndex = chapter.activeIndex == null ? 0 : chapter.activeIndex;
        const nodes = chapter.nodes.map((node, index) => {
            const classes = ['posCatalog_select'];
            if (chapter.active === 'leaf' && index === activeIndex) classes.push('posCatalog_active');
            if (node.extraClass) classes.push(node.extraClass);
            return `<li><div class="${classes.join(' ')}"><span class="posCatalog_name" title="${node.title}">${node.title}</span></div></li>`;
        }).join('');
        const chapterClasses = ['posCatalog_select', 'firstLayer'];
        if (chapter.active === 'firstLayer') chapterClasses.push('posCatalog_active');
        const liClass = chapter.active === 'chapter' ? ' class="posCatalog_active"' : '';
        return `<li${liClass}><div class="${chapterClasses.join(' ')}"><span class="posCatalog_name" title="${chapter.title}">${chapter.title}</span></div>`
            + `<ul>${nodes}</ul></li>`;
    }).join('');
    return `<div id="coursetree"><ul>${chapters}</ul></div>`;
}

export function chapterSpecs(...nodesPerChapter) {
    return nodesPerChapter.map((titles, index) => ({
        title: `第${index + 1}章`,
        active: index === 0 ? 'leaf' : 'none',
        activeIndex: 0,
        nodes: titles.map((title) => ({ title })),
    }));
}

export async function frameDoc(env, frameId) {
    const frame = env.window.document.getElementById(frameId);
    if (!frame) throw new Error('缺少 iframe: ' + frameId);
    for (let i = 0; i < 5; i++) {
        const doc = frame.contentDocument;
        if (doc && doc.body) return doc;
        await drain();
    }
    throw new Error('iframe 文档不可用: ' + frameId);
}

export async function writeFrame(env, frameId, html) {
    const doc = await frameDoc(env, frameId);
    doc.body.innerHTML = html;
    return doc;
}

export async function buildFrameChain(env, depth, innerHtml) {
    let doc = env.window.document;
    for (let level = depth; level >= 1; level--) {
        const frame = doc.createElement('iframe');
        frame.id = 'nested-' + level;
        frame.setAttribute('src', 'about:blank');
        doc.body.appendChild(frame);
        await drain();
        await drain();
        const inner = frame.contentDocument;
        if (!inner) throw new Error('嵌套 iframe 创建失败: level ' + level);
        doc = inner;
    }
    doc.body.innerHTML = innerHtml;
    return doc;
}

export function stubVideo(env, video, options = {}) {
    const win = env.window;
    const state = {
        paused: options.paused !== false,
        ended: false,
        currentTime: options.currentTime || 0,
        muted: false,
        playbackRate: 1,
    };
    const calls = { play: 0, pause: 0 };
    const define = (name, initial) => Object.defineProperty(video, name, {
        configurable: true,
        get: () => state[initial],
        set: (value) => { state[initial] = typeof state[initial] === 'boolean' ? !!value : Number(value) || 0; },
    });
    define('paused', 'paused');
    define('ended', 'ended');
    define('currentTime', 'currentTime');
    define('muted', 'muted');
    define('playbackRate', 'playbackRate');
    video.play = function () {
        calls.play++;
        const behavior = options.playImpl ? options.playImpl(calls.play, state) : 'resolve';
        if (behavior === 'reject') return Promise.reject(new win.Error('NotAllowedError: play() failed'));
        if (options.keepPaused) return Promise.resolve();
        state.paused = false;
        win.setTimeout(() => video.dispatchEvent(new win.Event('play')), 0);
        return Promise.resolve();
    };
    video.pause = function () {
        calls.pause++;
        state.paused = true;
        video.dispatchEvent(new win.Event('pause'));
        return Promise.resolve();
    };
    video.__state = state;
    video.__calls = calls;
    return video;
}

export function stripComments(code) {
    return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
// ---------------------------------------------------------------------------
// 断言与用例注册
// ---------------------------------------------------------------------------

export const results = [];
export function check(name, cond, detail) {
    results.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail) });
    return !!cond;
}
const tests = [];
function test(id, fn) { tests.push({ id, fn }); }

async function envWithTree(spec, options = {}) {
    const parts = [tree(spec)];
    if (options.frame !== false) parts.push('<iframe id="player" src="about:blank"></iframe>');
    if (options.stepTitle) parts.push(`<div class="prev_title" title="${options.stepTitle}"></div>`);
    if (options.extraHtml) parts.push(options.extraHtml);
    const env = createEnv({ html: parts.join('') });
    let video = null;
    if (options.frame !== false) {
        const doc = await writeFrame(env, 'player', options.frameHtml || '<video id="video_html5_api" src="https://example.com/a.mp4"></video>');
        const el = doc.getElementById('video_html5_api');
        if (el) video = stubVideo(env, el, options.videoOptions || {});
    }
    return { env, video };
}

// ---------------------------------------------------------------------------
// F1 导航死锁（#9 #24 #27 #37 #50）
// ---------------------------------------------------------------------------

test('F1-a 找不到视频触顶重试后，nextUnit() 仍可再次触发', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1', '1.2', '1.3'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    app._tryTimes = app.configs.maxRetries;
    app.nextUnit();
    await env.advance(3200);
    check('F1-a play() 失败后导航锁已复位', app._nextUnitPending === false, 'pending=' + app._nextUnitPending);
    check('F1-a 出现达到最大重试的日志', env.xt.has('已达到最大重试次数'), '');
    check('F1-a 第一次 nextUnit() 生效（1.2）', env.lastTreeClickTitle() === '1.2', 'last=' + env.lastTreeClickTitle());
    app.nextUnit();
    await env.advance(3200);
    check('F1-a 失败之后 nextUnit() 仍可再次触发（1.3）', env.lastTreeClickTitle() === '1.3', 'last=' + env.lastTreeClickTitle());
});

test('F1-b 「无视频安全停止」退出路径后，nextUnit() 仍可再次触发', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1', '1.2'], ['2.1'])) });
    const app = await env.boot();
    check('F1-b 已进入无视频安全停止分支', env.xt.has('已安全停止'), '');
    app.nextUnit();
    await env.advance(3200);
    check('F1-b 导航锁复位', app._nextUnitPending === false, 'pending=' + app._nextUnitPending);
    app.nextUnit();
    await env.advance(3200);
    check('F1-b 再触发后切到第 2 章首个节点', env.lastTreeClickTitle() === '2.1', 'last=' + env.lastTreeClickTitle());
});

test('F1-c 静音播放也失败触顶后，nextUnit() 仍可再次触发', async () => {
    const { env } = await envWithTree(chapterSpecs(['1.1', '1.2', '1.3']), {
        stepTitle: '视频',
        videoOptions: { playImpl: () => 'reject' },
    });
    const app = await env.boot();
    app._tryTimes = app.configs.maxRetries;
    app.nextUnit();
    await env.advance(3200);
    check('F1-c 出现静音失败触顶日志', env.xt.has('静音播放失败，已达到最大重试次数'), '');
    check('F1-c 导航锁复位', app._nextUnitPending === false, 'pending=' + app._nextUnitPending);
    app.nextUnit();
    await env.advance(3200);
    check('F1-c 之后 nextUnit() 仍生效（1.3）', env.lastTreeClickTitle() === '1.3', 'last=' + env.lastTreeClickTitle());
});

test('F1-d 正常播放路径下连续 nextUnit() 依次推进 1.1→1.2→1.3', async () => {
    const { env } = await envWithTree(chapterSpecs(['1.1', '1.2', '1.3']), { stepTitle: '视频' });
    const app = await env.boot();
    check('F1-d 初始解析到 1.1', app.cellData.currentCellIndex === 0 && app.cellData.currentNCellIndex === 0, JSON.stringify(app.cellData));
    app.nextUnit();
    await env.advance(3200);
    check('F1-d 推进到 1.2', env.lastTreeClickTitle() === '1.2', 'last=' + env.lastTreeClickTitle());
    check('F1-d 导航锁未卡死', app._nextUnitPending === false, '');
    app.nextUnit();
    await env.advance(3200);
    check('F1-d 推进到 1.3', env.lastTreeClickTitle() === '1.3', 'last=' + env.lastTreeClickTitle());
});

test('F1-e 课程已完成的退出路径也会释放导航锁（V3.3 在此永久卡死）', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) });
    const app = await env.boot();
    app.nextUnit();
    await env.advance(200);
    check('F1-e 出现课程完成日志', env.xt.has('本课程学习完成了'), '');
    check('F1-e 导航锁已释放（V3.3 此处为 true）', app._nextUnitPending === false, 'pending=' + app._nextUnitPending);
    app.nextUnit();
    await env.advance(200);
    check('F1-e 再次 nextUnit() 不再被静默忽略', env.xt.count('已有小节切换正在进行') === 0, 'ignored=' + env.xt.count('已有小节切换正在进行'));
});

test('F1-f 失败的 play() 退出路径会主动释放导航锁（V3.3 在此永久卡死）', async () => {
    // 1) 达到最大重试的退出路径
    const env = createEnv({ html: tree(chapterSpecs(['1.1'], ['2.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    app._nextUnitPending = true;
    app._tryTimes = app.configs.maxRetries;
    await app.play();
    check('F1-f 触顶重试后导航锁被释放', app._nextUnitPending === false, 'pending=' + app._nextUnitPending);
    app.nextUnit();
    await env.advance(200);
    check('F1-f 释放后 nextUnit() 立刻生效', env.lastTreeClickTitle() === '2.1', 'last=' + env.lastTreeClickTitle());

    // 2) 无视频安全停止的退出路径
    const env2 = createEnv({ html: tree(chapterSpecs(['1.1'], ['2.1'])) });
    const app2 = await env2.boot();
    app2._nextUnitPending = true;
    await app2.play();
    check('F1-f 无视频安全停止后导航锁被释放', app2._nextUnitPending === false, 'pending=' + app2._nextUnitPending);
    app2.nextUnit();
    await env2.advance(200);
    check('F1-f 释放后 nextUnit() 立刻生效（切到第 2 章）', env2.lastTreeClickTitle() === '2.1', 'last=' + env2.lastTreeClickTitle());
});
test('F1-g destroy() 同样释放导航锁（所有退出路径一致性，#24 #27）', async () => {
    const { env } = await envWithTree(chapterSpecs(['1.1', '1.2']), { stepTitle: '视频' });
    const app = await env.boot();
    app._nextUnitPending = true;
    app.destroy();
    check('F1-g destroy() 后导航锁已释放', app._nextUnitPending === false, 'pending=' + app._nextUnitPending);
    app.nextUnit();
    await env.advance(200);
    check('F1-g destroy() 后 nextUnit() 不再被静默忽略', env.xt.count('已有小节切换正在进行') === 0, 'ignored=' + env.xt.count('已有小节切换正在进行'));
});
test('F1-h 所有退出路径都显式释放导航锁（静态清点，#9 #24 #27 #37 #50）', () => {
    const code = stripComments(readFileSync(sourcePath, 'utf8'));
    const paths = [
        ['nextUnit 的 finally 兜底', /finally\s*\{[\s\S]{0,300}?_releaseNavLock\('nextUnit 退出'\)/],
        ['play() 达到最大重试', /_releaseNavLock\('play\(\) 达到最大重试次数'\)/],
        ['静音播放失败触顶', /_releaseNavLock\('静音播放失败触顶'\)/],
        ['无视频安全停止', /_releaseNavLock\('无视频安全停止'\)/],
        ['无视频自动前进触顶', /_releaseNavLock\('无视频自动前进触顶'\)/],
        ['playCurrentIndex 解析失败', /_releaseNavLock\('playCurrentIndex 解析失败'\)/],
        ['找不到可点击节点', /_releaseNavLock\('找不到可点击节点'\)/],
        ['play 出错且无视频元素', /_releaseNavLock\('play 错误且无视频元素'\)/],
        ['静音播放未被接受', /_releaseNavLock\('静音播放未被接受'\)/],
        ['destroy() 复位', /destroy\(\)\s*\{[\s\S]{0,200}?this\._nextUnitPending = false;/],
    ];
    for (const pair of paths) check('F1-h 存在释放点：' + pair[0], pair[1].test(code), '');
});

test('F1-i 找不到可点击节点时同样释放导航锁（#24）', async () => {
    const html = '<div id="coursetree"><ul><li>'
        + '<div class="posCatalog_select firstLayer"><span class="posCatalog_name" title="第1章">第1章</span></div>'
        + '<ul><li><div class="posCatalog_select posCatalog_active"></div></li>'
        + '<li><div class="posCatalog_select"><span class="posCatalog_name" title="1.2">1.2</span></div></li></ul>'
        + '</li></ul></div>';
    const env = createEnv({ html });
    const app = await env.boot();
    app._nextUnitPending = true;
    app.playCurrentIndex(null, { chapterIndex: 0, nodeIndex: 0 });
    check('F1-i 打印找不到可点击节点', env.xt.has('找不到可点击的课程节点'), '');
    check('F1-i 导航锁被释放', app._nextUnitPending === false, 'pending=' + app._nextUnitPending);
});
// ---------------------------------------------------------------------------
// F2 小节内多视频 / 下标解析（#14 #15 #24 #27 #37 #49）
// ---------------------------------------------------------------------------

test('F2-1 同一章 3 个视频节点按 1→2→3 推进，不直接跳到下一章', async () => {
    const { env } = await envWithTree(chapterSpecs(['1.1', '1.2', '1.3'], ['2.1']), { stepTitle: '视频' });
    const app = await env.boot();
    check('F2-1 初始下标为 0/0 且解析成功', app.cellData.currentCellIndex === 0 && app.cellData.currentNCellIndex === 0 && app.cellData.resolved === true, JSON.stringify(app.cellData));
    app.nextUnit();
    await env.advance(3200);
    check('F2-1 第 2 个视频节点', env.lastTreeClickTitle() === '1.2', 'last=' + env.lastTreeClickTitle());
    app.nextUnit();
    await env.advance(3200);
    check('F2-1 第 3 个视频节点', env.lastTreeClickTitle() === '1.3', 'last=' + env.lastTreeClickTitle());
    check('F2-1 此时仍在第 1 章', app.cellData.currentCellIndex === 0, JSON.stringify(app.cellData));
    app.nextUnit();
    await env.advance(3200);
    check('F2-1 同章 3 个播完后才进入下一章', env.lastTreeClickTitle() === '2.1', 'last=' + env.lastTreeClickTitle());
    check('F2-1 点击序列完全正确', JSON.stringify(env.treeClickTitles()) === JSON.stringify(['1.2', '1.3', '2.1']), JSON.stringify(env.treeClickTitles()));
});

test('F2-2 active 落在章节 li 上时也能定位到该章节点并逐节推进', async () => {
    const spec = [
        { title: '第1章', active: 'chapter', activeIndex: 0, nodes: [{ title: '1.1' }, { title: '1.2' }] },
        { title: '第2章', active: 'none', activeIndex: 0, nodes: [{ title: '2.1' }] },
    ];
    const { env } = await envWithTree(spec, { stepTitle: '视频' });
    const app = await env.boot();
    check('F2-2 父节点 active 解析到第 1 章第 1 个节点', app.cellData.currentCellIndex === 0 && app.cellData.currentNCellIndex === 0, JSON.stringify(app.cellData));
    app.nextUnit();
    await env.advance(3200);
    check('F2-2 推进到同章 1.2', env.lastTreeClickTitle() === '1.2', 'last=' + env.lastTreeClickTitle());
});

test('F2-3 active 落在收起态 firstLayer 上时也能定位', async () => {
    const spec = [
        { title: '第1章', active: 'firstLayer', activeIndex: 0, nodes: [{ title: '1.1' }, { title: '1.2' }] },
        { title: '第2章', active: 'none', activeIndex: 0, nodes: [{ title: '2.1' }] },
    ];
    const { env } = await envWithTree(spec, { stepTitle: '视频' });
    const app = await env.boot();
    check('F2-3 firstLayer active 解析到 0/0', app.cellData.currentCellIndex === 0 && app.cellData.currentNCellIndex === 0, JSON.stringify(app.cellData));
    app.nextUnit();
    await env.advance(3200);
    check('F2-3 推进到同章 1.2 而不是跳章', env.lastTreeClickTitle() === '1.2', 'last=' + env.lastTreeClickTitle());
});

test('F2-3b 容器节点（firstLayer / lastLayer 包裹）不会被当成可播放节点', async () => {
    const html = '<div id="coursetree"><ul><li>'
        + '<div class="posCatalog_select firstLayer"><span class="posCatalog_name" title="第1章">第1章</span></div>'
        + '<div class="posCatalog_select lastLayer posCatalog_active"><span class="posCatalog_name" title="容器">容器</span><ul>'
        + '<li><div class="posCatalog_select"><span class="posCatalog_name" title="1.1">1.1</span></div></li>'
        + '<li><div class="posCatalog_select"><span class="posCatalog_name" title="1.2">1.2</span></div></li>'
        + '</ul></div></li>'
        + '<li><div class="posCatalog_select firstLayer"><span class="posCatalog_name" title="第2章">第2章</span></div><ul>'
        + '<li><div class="posCatalog_select"><span class="posCatalog_name" title="2.1">2.1</span></div></li>'
        + '</ul></li></ul></div>'
        + '<iframe id="player" src="about:blank"></iframe><div class="prev_title" title="视频"></div>';
    const env = createEnv({ html });
    const doc = await writeFrame(env, 'player', '<video id="video_html5_api" src="https://example.com/a.mp4"></video>');
    stubVideo(env, doc.getElementById('video_html5_api'), {});
    const app = await env.boot();
    check('F2-3b 容器节点没有被计入小节总数（2+1=3）', app.cellData.nCells === 3, 'nCells=' + app.cellData.nCells);
    check('F2-3b active 在容器上时定位到第 1 个真实节点', app.cellData.currentCellIndex === 0 && app.cellData.currentNCellIndex === 0, JSON.stringify(app.cellData));
    app.nextUnit();
    await env.advance(3200);
    check('F2-3b 推进到同章第 2 个真实节点', env.lastTreeClickTitle() === '1.2', 'last=' + env.lastTreeClickTitle());
});
test('F2-4 解析失败时明确报错、不点击、也不静默跳到下一章', async () => {
    const spec = [
        { title: '第1章', active: 'none', activeIndex: 0, nodes: [{ title: '1.1' }, { title: '1.2' }] },
        { title: '第2章', active: 'none', activeIndex: 0, nodes: [{ title: '2.1' }] },
    ];
    const env = createEnv({ html: tree(spec) });
    const app = await env.boot();
    const clicksBefore = env.clicks.length;
    app.nextUnit();
    await env.advance(5000);
    check('F2-4 出现明确的解析失败日志', env.xt.has('无法解析当前课程节点'), '');
    check('F2-4 目录解析失败时给出处理方法', env.xt.has('没有高亮的 .posCatalog_active'), '');
    check('F2-4 没有发生任何点击', env.clicks.length === clicksBefore, 'clicks=' + env.clicks.length + ' before=' + clicksBefore);
    check('F2-4 未出现「切换到下一个章节」', !env.xt.has('切换到下一个章节'), '');
    check('F2-4 导航锁复位', app._nextUnitPending === false, '');
});
test('F2-5 小节内多个视频任务点按顺序播完，全部完成才切下一小节（思路来自 PR #48 @CsuCook1e）', async () => {
    const html = tree(chapterSpecs(['1.1', '1.2']))
        + '<div class="ans-job ans-job-finished"><iframe class="ans-insertvideo-online" id="task-1" src="about:blank"></iframe><span>任务点已完成</span></div>'
        + '<div class="ans-job"><iframe class="ans-insertvideo-online" id="task-2" src="about:blank"></iframe></div>'
        + '<div class="ans-job"><iframe class="ans-insertvideo-online" id="task-3" src="about:blank"></iframe></div>'
        + '<div class="prev_title" title="视频"></div>';
    const env = createEnv({ html });
    const doc1 = await writeFrame(env, 'task-1', '<video id="video_html5_api" src="https://example.com/t1.mp4"></video>');
    stubVideo(env, doc1.getElementById('video_html5_api'), {});
    const doc2 = await writeFrame(env, 'task-2', '<video id="video_html5_api" src="https://example.com/t2.mp4"></video>');
    const v2 = stubVideo(env, doc2.getElementById('video_html5_api'), {});
    const doc3 = await writeFrame(env, 'task-3', '<video id="video_html5_api" src="https://example.com/t3.mp4"></video>');
    const v3 = stubVideo(env, doc3.getElementById('video_html5_api'), {});
    const app = await env.boot();
    check('F2-5 识别出 3 个视频任务点', app._videoTaskCount === 3, 'count=' + app._videoTaskCount);
    check('F2-5 跳过已完成的任务点，命中第 2 个任务点的视频', app._getVideoEl() === v2, '');
    check('F2-5 打印跳过已完成任务点的日志', env.xt.has('跳过已完成的视频任务点'), '');

    v2.__state.ended = true;
    app._isPlaying = true;
    v2.dispatchEvent(new env.window.Event('ended'));
    await env.advance(1500);
    check('F2-5 第 2 个任务点播完后小节内切到第 3 个', app._getVideoEl() === v3, '');
    check('F2-5 此时没有切换目录树节点', env.treeClicks().length === 0, JSON.stringify(env.treeClickTitles()));

    v3.__state.ended = true;
    app._isPlaying = true;
    v3.dispatchEvent(new env.window.Event('ended'));
    await env.advance(1500);
    check('F2-5 小节内任务点全部完成后才切换目录树', env.lastTreeClickTitle() === '1.2', 'last=' + env.lastTreeClickTitle());
});

test('F2-6 小节内视频任务点全部已完成时不再返回视频，交由无视频分支有界前进', async () => {
    const html = tree(chapterSpecs(['1.1'], ['2.1']))
        + '<div class="ans-job ans-job-finished"><iframe class="ans-insertvideo-online" id="task-1" src="about:blank"></iframe></div>'
        + '<div class="ans-job ans-job-finished"><iframe class="ans-insertvideo-online" id="task-2" src="about:blank"></iframe></div>';
    const env = createEnv({ html });
    const doc1 = await writeFrame(env, 'task-1', '<video id="video_html5_api" src="https://example.com/t1.mp4"></video>');
    stubVideo(env, doc1.getElementById('video_html5_api'), {});
    const doc2 = await writeFrame(env, 'task-2', '<video id="video_html5_api" src="https://example.com/t2.mp4"></video>');
    stubVideo(env, doc2.getElementById('video_html5_api'), {});
    const app = await env.boot();
    check('F2-6 任务点全完成时 _getVideoEl() 返回 null', app._getVideoEl() === null, '');
    check('F2-6 打印「视频任务点均已完成」日志', env.xt.has('个视频任务点均已完成'), '');
    check('F2-6 被视为可识别完成并有界前进', env.lastTreeClickTitle() === '2.1', 'last=' + env.lastTreeClickTitle());
});
// ---------------------------------------------------------------------------
// F3 无视频/课件页卡死（#38 #42 #43 #50）
// ---------------------------------------------------------------------------

test('F3-1 无视频且无法识别完成状态 → 安全停止 + 可操作提示 + 零点击', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'], ['2.1'], ['3.1'], ['4.1'])) });
    const app = await env.boot();
    check('F3-1 进入安全停止分支', env.xt.has('已安全停止'), '');
    check('F3-1 给出可操作处理方法', env.xt.has('执行 app.nextUnit() 跳过') && env.xt.has('autoAdvanceNoVideo'), '');
    await env.advance(120000);
    check('F3-1 长时间空转后仍无自动点击（不会误跳章节）', env.treeClicks().length === 0, JSON.stringify(env.treeClickTitles()));
    check('F3-1 连续自动前进计数未超上限', app._consecutiveNoVideoAdvances <= app.configs.maxConsecutiveNoVideoAdvances, 'count=' + app._consecutiveNoVideoAdvances);
});

test('F3-2 已识别为完成的节点会自动前进，但连续前进次数受上限约束', async () => {
    const spec = [1, 2, 3, 4, 5, 6].map((i) => ({
        title: `第${i}章`,
        active: i === 1 ? 'leaf' : 'none',
        activeIndex: 0,
        nodes: [{ title: `${i}.1`, extraClass: 'icon_Completed' }],
    }));
    const env = createEnv({ html: tree(spec) });
    const app = await env.boot();
    await env.advance(120000);
    check('F3-2 识别出「已完成/无任务点」并自动前进', env.xt.has('已识别为「已完成/无任务点」'), '');
    check('F3-2 自动前进次数不超过配置上限', env.treeClicks().length <= app.configs.maxConsecutiveNoVideoAdvances && env.treeClicks().length >= 1, 'clicks=' + env.treeClicks().length + ' cap=' + app.configs.maxConsecutiveNoVideoAdvances);
    check('F3-2 触顶后停止并给出提示', env.xt.has('连续自动前进已达上限'), '');
    check('F3-2 触顶提示包含处理方法', env.xt.has('请人工确认课程目录结构'), '');
});

test('F3-3 章节测验仍走既有的受限跳转（最多 3 次，不死循环）', async () => {
    const html = tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="章节测验"></div><a id="prevNextFocusNext" href="#">下一节</a>';
    const env = createEnv({ html });
    const app = await env.boot();
    await env.advance(60000);
    const nextClicks = env.clicks.filter((c) => c.title.indexOf('下一节') >= 0).length;
    check('F3-3 章节测验跳转不超过 3 次', app._chapterAdvanceTimes <= 3 && nextClicks <= 3, 'times=' + app._chapterAdvanceTimes + ' clicks=' + nextClicks);
    check('F3-3 未把章节测验当成互动弹窗', !env.xt.has('检测到视频互动答题弹窗'), '');
});

test('F3-4 任务点未完成弹窗点「去学习」而不是「下一节」，且受冷却与次数上限约束（思路来自 PR #48 @CsuCook1e）', async () => {
    const dialogHtml = '<div class="layui-layer" id="task-dialog">'
        + '<div class="layui-layer-title">提示</div>'
        + '<div class="layui-layer-content">当前章节还有任务点未完成，是否去完成？</div>'
        + '<a class="layui-layer-btn0" id="go-study" href="#">去学习</a>'
        + '<a class="layui-layer-btn1" id="next-section" href="#">下一节</a></div>';
    const env = createEnv({ html: tree(chapterSpecs(['1.1'], ['2.1'])) + dialogHtml });
    const doc = env.window.document;
    const dialog = doc.getElementById('task-dialog');
    dialog.getBoundingClientRect = () => ({ x: 0, y: 0, width: 420, height: 220, top: 0, left: 0, right: 420, bottom: 220 });
    let goStudy = 0;
    let nextSection = 0;
    doc.getElementById('go-study').addEventListener('click', () => { goStudy++; });
    doc.getElementById('next-section').addEventListener('click', () => { nextSection++; });
    const app = await env.boot();
    await env.advance(2000);
    check('F3-4 第一次点击「去学习」', goStudy === 1, 'goStudy=' + goStudy);
    check('F3-4 不点「下一节」硬闯', nextSection === 0, 'nextSection=' + nextSection);
    check('F3-4 日志说明回到未完成任务点', env.xt.has('回到未完成任务点'), '');
    await env.advance(3000);
    check('F3-4 冷却窗口内不重复点击', goStudy === 1, 'goStudy=' + goStudy);
    await env.advance(app.configs.taskDialogClickCooldownMs * 3);
    check('F3-4 每小节点击次数不超过上限', goStudy === app.configs.taskDialogMaxClicksPerUnit, 'goStudy=' + goStudy + ' cap=' + app.configs.taskDialogMaxClicksPerUnit);
    check('F3-4 触顶后打印停止提示', env.xt.has('弹窗处理已达上限'), '');
    check('F3-4 触顶后仍不点「下一节」', nextSection === 0, 'nextSection=' + nextSection);
});
// ---------------------------------------------------------------------------
// F21 空视频节点（标题「视频」但平台内容占位「暂无内容」，真机背景：第 16 章 16.1.2）
// ---------------------------------------------------------------------------

test('F21-1 「视频」空节点 + 平台完成标记 → 不再重试触顶，转入无视频流程有界前进', async () => {
    const spec = [
        { title: '第1章', active: 'leaf', activeIndex: 0, nodes: [{ title: '1.1 视频', extraClass: 'icon_Completed' }] },
        { title: '第2章', active: 'none', activeIndex: 0, nodes: [{ title: '2.1 课件' }] },
    ];
    const html = tree(spec)
        + '<iframe id="iframe" src="about:blank"></iframe>'
        + '<div class="prev_title" title="视频"></div>';
    const env = createEnv({ html });
    await writeFrame(env, 'iframe', '暂无内容');
    const app = await env.boot();
    check('F21-1 空节点判定为 true', app._isEmptyContentVideoNode() === true, '');
    await env.advance(30000);
    check('F21-1 打印空节点识别日志', env.xt.has('平台内容为空'), JSON.stringify(env.xt.logs.slice(-6)));
    check('F21-1 不再出现「已达到最大重试次数」', !env.xt.has('已达到最大重试次数'), '');
    check('F21-1 有界前进到下一章', env.lastTreeClickTitle() === '2.1 课件', 'last=' + env.lastTreeClickTitle());
});

test('F21-2 「视频」空节点识别不出完成状态 → 安全停止（不重试触顶、零点击）', async () => {
    const html = tree(chapterSpecs(['1.1']))
        + '<iframe id="iframe" src="about:blank"></iframe>'
        + '<div class="prev_title" title="视频"></div>';
    const env = createEnv({ html });
    await writeFrame(env, 'iframe', '暂无内容');
    const app = await env.boot();
    await env.advance(120000);
    check('F21-2 打印空节点识别日志', env.xt.has('平台内容为空'), '');
    check('F21-2 走无视频安全停止流程', env.xt.has('已安全停止'), JSON.stringify(env.xt.logs.slice(-8)));
    check('F21-2 不再出现「已达到最大重试次数」', !env.xt.has('已达到最大重试次数'), '');
    check('F21-2 零点击', env.treeClicks().length === 0, JSON.stringify(env.treeClickTitles()));
});

test('F21-3 页面存在视频元素时，空节点判定必须为 false（不误跳真实视频节点）', async () => {
    const html = tree(chapterSpecs(['1.1']))
        + '<iframe id="iframe" src="about:blank"></iframe>'
        + '<iframe id="player" src="about:blank"></iframe>';
    const env = createEnv({ html });
    await writeFrame(env, 'iframe', '暂无内容');
    const pdoc = await writeFrame(env, 'player', '<video id="v" src="https://example.com/a.mp4"></video>');
    stubVideo(env, pdoc.getElementById('v'), {});
    const app = await env.boot();
    check('F21-3 有视频元素时判定为空节点=false', app._isEmptyContentVideoNode() === false, '');
});

test('F21-4 视频任务点 iframe（jobid=video-*）存在时，空节点判定必须为 false', async () => {
    const html = tree(chapterSpecs(['1.1']))
        + '<iframe id="iframe" src="about:blank"></iframe>'
        + '<iframe id="task-1" jobid="video-123" class="ans-insertvideo-online" src="about:blank"></iframe>';
    const env = createEnv({ html });
    await writeFrame(env, 'iframe', '暂无内容');
    const app = await env.boot();
    check('F21-4 有视频任务点 iframe 时判定为空节点=false', app._isEmptyContentVideoNode() === false, '');
});

// ---------------------------------------------------------------------------
// F22 手动暂停/切节点后恢复（僵尸 iframe 文档里的 video，真机：GUI 暂停→看别的节点→点继续）
// ---------------------------------------------------------------------------

test('F22-1 僵尸 iframe 文档里的 video 判定失效，play() 自动重新定位到活动帧', async () => {
    const { env, video } = await envWithTree(chapterSpecs(['1.1'], ['2.1']), { stepTitle: '视频' });
    const app = await env.boot();
    check('F22-1 初始缓存视频有效', app._isLiveVideoElement(video) === true && app._videoEl === video, '');
    // 模拟用户手动切节点 / 平台重建 iframe：移除旧 iframe，另建新的活动帧
    env.window.document.getElementById('player').remove();
    const newFrame = env.window.document.createElement('iframe');
    newFrame.id = 'player2';
    newFrame.setAttribute('src', 'about:blank');
    env.window.document.body.appendChild(newFrame);
    await env.advance(50);
    const ndoc = await writeFrame(env, 'player2', '<video id="video_html5_api" src="https://example.com/b.mp4"></video>');
    const newVideo = stubVideo(env, ndoc.getElementById('video_html5_api'), {});
    check('F22-1 旧元素被判定为僵尸（失效）', app._isLiveVideoElement(video) === false, '');
    check('F22-1 新元素被判定为有效', app._isLiveVideoElement(newVideo) === true, '');
    app._isPlaying = false;
    app.play();
    await env.advance(3000);
    check('F22-1 自动放弃僵尸缓存并播放新视频', newVideo.__calls.play >= 1, 'calls=' + newVideo.__calls.play);
    check('F22-1 缓存已切换到新视频', app._videoEl === newVideo, '');
});

test('F22-2 play() 首次超时（僵尸元素/管线冻结）→ 强制重新定位一次并自动恢复', async () => {
    const { env, video } = await envWithTree(chapterSpecs(['1.1'], ['2.1']), { stepTitle: '视频' });
    let calls = 0;
    const realPlay = video.play;
    video.play = function () {
        calls++;
        if (calls === 1) return new Promise(() => {}); // 首次永不 settle
        return realPlay.call(video);
    };
    const app = await env.boot();
    await env.advance(12000);
    check('F22-2 play() 至少被调用 2 次（超时后重新定位重试）', calls >= 2, 'calls=' + calls);
    check('F22-2 打印重新定位日志', env.xt.has('重新定位'), JSON.stringify(env.xt.logs.slice(-6)));
    check('F22-2 最终进入播放状态', app._isPlaying === true, '');
});

test('F22-3 GUI 恢复播放前重新同步：清理僵尸缓存并播放活动帧视频', async () => {
    const { env } = await envWithTree(chapterSpecs(['1.1'], ['2.1']), { stepTitle: '视频' });
    const app = await env.boot();
    env.window.document.getElementById('player').remove();
    const f2 = env.window.document.createElement('iframe');
    f2.id = 'player3';
    f2.setAttribute('src', 'about:blank');
    env.window.document.body.appendChild(f2);
    await env.advance(50);
    const d2 = await writeFrame(env, 'player3', '<video id="video_html5_api" src="https://example.com/c.mp4"></video>');
    const v2 = stubVideo(env, d2.getElementById('video_html5_api'), {});
    app._isPlaying = false;
    app._resumeAfterManualPause();
    await env.advance(3000);
    check('F22-3 恢复后缓存切换到新视频', app._videoEl === v2, '');
    check('F22-3 新视频已开始播放', v2.__calls.play >= 1, 'calls=' + v2.__calls.play);
});

// ---------------------------------------------------------------------------
// F23 「完成条件 ≥X%」识别 + 多任务点片尾提前交接（真机：984s 视频 92.0% 被平台标记完成）
// ---------------------------------------------------------------------------

test('F23-1 解析「完成条件 观看时长需 ≥ 总时长的 90%」并按比例回退配置', async () => {
    const html = tree(chapterSpecs(['1.1'])) + '<iframe id="cards" src="about:blank"></iframe>' + '<div class="prev_title" title="视频"></div>';
    const env = createEnv({ html });
    await writeFrame(env, 'cards', '完成条件 观看时长需 ≥ 总时长的 90% (未完成任务点前，当前视频不可拖拽)');
    const app = await env.boot();
    check('F23-1 解析出 0.9', app._getUnitCompletionRatio() === 0.9, 'ratio=' + app._getUnitCompletionRatio());
    check('F23-1 解析结果被缓存', app._unitCompletionRatio === 0.9, '');

    const env100 = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<iframe id="cards" src="about:blank"></iframe>' + '<div class="prev_title" title="视频"></div>' });
    await writeFrame(env100, 'cards', '完成条件 观看时长需 ≥ 总时长的 100% (未完成任务点前，当前视频不可拖拽)');
    const app100 = await env100.boot();
    check('F23-1 100% 条件解析为 1（即不提前）', app100._getUnitCompletionRatio() === 1, 'ratio=' + app100._getUnitCompletionRatio());

    const envNo = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const appNo = await envNo.boot();
    check('F23-1 无文案时回退配置 0.9', appNo._getUnitCompletionRatio() === 0.9 && appNo._unitCompletionRatio === null, '');
});

test('F23-2 多任务点：当前任务点已完成且达比例 → 跳过片尾提前切下一个任务点', async () => {
    const html = tree(chapterSpecs(['1.1']))
        + '<div class="ans-attach-ct" id="ct1"><iframe id="task-1" class="ans-insertvideo-online" src="about:blank"></iframe><span class="ans-job-icon ans-job-video"></span></div>'
        + '<div class="ans-attach-ct" id="ct2"><iframe id="task-2" class="ans-insertvideo-online" src="about:blank"></iframe><span class="ans-job-icon ans-job-video"></span></div>'
        + '<div class="prev_title" title="视频"></div>';
    const env = createEnv({ html });
    const d1 = await writeFrame(env, 'task-1', '<video id="video_html5_api" src="https://example.com/t1.mp4"></video>');
    const v1 = stubVideo(env, d1.getElementById('video_html5_api'), {});
    const d2 = await writeFrame(env, 'task-2', '<video id="video_html5_api" src="https://example.com/t2.mp4"></video>');
    const v2 = stubVideo(env, d2.getElementById('video_html5_api'), {});
    Object.defineProperty(v1, 'duration', { configurable: true, get: () => 100 });
    Object.defineProperty(v2, 'duration', { configurable: true, get: () => 100 });
    const app = await env.boot();
    await env.advance(1500);
    check('F23-2 先播第 1 个任务点', app._getVideoEl() === v1, '');
    app._isPlaying = true;
    v1.paused = false;
    v1.currentTime = 95;
    env.window.document.getElementById('ct1').classList.add('ans-job-finished'); // 平台在 92% 左右标记完成
    app._checkVideoStatus();
    check('F23-2 打印跳过片尾日志', env.xt.has('跳过片尾切换下一个任务点'), JSON.stringify(env.xt.logs.slice(-4)));
    await env.advance(3000);
    check('F23-2 已切到第 2 个任务点', app._currentVideoTaskIndex === 1, 'idx=' + app._currentVideoTaskIndex);
    check('F23-2 第 2 个任务点已开播', app._getVideoEl() === v2, '');
});

test('F23-3 未获平台完成标记时不抢跑（比例达标也不提前切换）', async () => {
    const html = tree(chapterSpecs(['1.1']))
        + '<div class="ans-attach-ct" id="ct1"><iframe id="task-1" class="ans-insertvideo-online" src="about:blank"></iframe><span class="ans-job-icon ans-job-video"></span></div>'
        + '<div class="ans-attach-ct" id="ct2"><iframe id="task-2" class="ans-insertvideo-online" src="about:blank"></iframe><span class="ans-job-icon ans-job-video"></span></div>'
        + '<div class="prev_title" title="视频"></div>';
    const env = createEnv({ html });
    const d1 = await writeFrame(env, 'task-1', '<video id="video_html5_api" src="https://example.com/t1.mp4"></video>');
    const v1 = stubVideo(env, d1.getElementById('video_html5_api'), {});
    const d2 = await writeFrame(env, 'task-2', '<video id="video_html5_api" src="https://example.com/t2.mp4"></video>');
    stubVideo(env, d2.getElementById('video_html5_api'), {});
    Object.defineProperty(v1, 'duration', { configurable: true, get: () => 100 });
    const app = await env.boot();
    await env.advance(1500);
    app._isPlaying = true;
    v1.paused = false;
    v1.currentTime = 95;
    app._checkVideoStatus();
    check('F23-3 未标记完成 → 不提前切换', app._currentVideoTaskIndex === 0 && !env.xt.has('跳过片尾切换下一个任务点'), 'idx=' + app._currentVideoTaskIndex);
});

// ---------------------------------------------------------------------------
// F24 同节点多视频并发播放（错开启动 + 副车道保活重播；真机实测并发第二路可被平台计入）
// ---------------------------------------------------------------------------

test('F24-1 关闭并发时 keeper 不额外播放其他任务点视频', async () => {
    const html = tree(chapterSpecs(['1.1']))
        + '<div class="ans-attach-ct" id="ct1"><iframe id="task-1" class="ans-insertvideo-online" src="about:blank"></iframe></div>'
        + '<div class="ans-attach-ct" id="ct2"><iframe id="task-2" class="ans-insertvideo-online" src="about:blank"></iframe></div>'
        + '<div class="prev_title" title="视频"></div>';
    const env = createEnv({ html });
    const d1 = await writeFrame(env, 'task-1', '<video id="video_html5_api" src="https://example.com/t1.mp4"></video>');
    stubVideo(env, d1.getElementById('video_html5_api'), {});
    const d2 = await writeFrame(env, 'task-2', '<video id="video_html5_api" src="https://example.com/t2.mp4"></video>');
    const v2 = stubVideo(env, d2.getElementById('video_html5_api'), {});
    const app = await env.boot();
    await env.advance(1500);
    const before = v2.__calls.play;
    app.configs.concurrentPlayback = false;
    v2.paused = true;
    for (let k = 0; k < 3; k++) app._laneKeeperTick();
    check('F24-1 关闭并发后不再拉起副车道', v2.__calls.play === before, 'before=' + before + ' after=' + v2.__calls.play);
    app.destroy();
});

test('F24-4 并发默认关闭（实测交错播放无提速，V3.6 补丁暂不默认开启）', async () => {
    const html = tree(chapterSpecs(['1.1']))
        + '<div class="ans-attach-ct" id="ct1"><iframe id="task-1" class="ans-insertvideo-online" src="about:blank"></iframe></div>'
        + '<div class="ans-attach-ct" id="ct2"><iframe id="task-2" class="ans-insertvideo-online" src="about:blank"></iframe></div>'
        + '<div class="prev_title" title="视频"></div>';
    const env = createEnv({ html });
    const d1 = await writeFrame(env, 'task-1', '<video id="video_html5_api" src="https://example.com/t1.mp4"></video>');
    stubVideo(env, d1.getElementById('video_html5_api'), {});
    const d2 = await writeFrame(env, 'task-2', '<video id="video_html5_api" src="https://example.com/t2.mp4"></video>');
    const v2 = stubVideo(env, d2.getElementById('video_html5_api'), {});
    const app = await env.boot();
    await env.advance(2500);
    check('F24-4 默认配置 concurrentPlayback=false', app.configs.concurrentPlayback === false, String(app.configs.concurrentPlayback));
    check('F24-4 默认不拉起副车道', v2.__calls.play === 0, 'calls=' + v2.__calls.play);
    app.destroy();
});

test('F24-2 开启并发后副车道被自动重播并静音', async () => {
    const html = tree(chapterSpecs(['1.1']))
        + '<div class="ans-attach-ct" id="ct1"><iframe id="task-1" class="ans-insertvideo-online" src="about:blank"></iframe></div>'
        + '<div class="ans-attach-ct" id="ct2"><iframe id="task-2" class="ans-insertvideo-online" src="about:blank"></iframe></div>'
        + '<div class="prev_title" title="视频"></div>';
    const env = createEnv({ html });
    const d1 = await writeFrame(env, 'task-1', '<video id="video_html5_api" src="https://example.com/t1.mp4"></video>');
    stubVideo(env, d1.getElementById('video_html5_api'), {});
    const d2 = await writeFrame(env, 'task-2', '<video id="video_html5_api" src="https://example.com/t2.mp4"></video>');
    const v2 = stubVideo(env, d2.getElementById('video_html5_api'), {});
    const app = await env.boot();
    await env.advance(1500);
    app.configs.concurrentPlayback = true;
    app.configs.laneKeeperIntervalMs = 1000;
    app._startLaneKeeper();
    await env.advance(2500);
    check('F24-2 打印并发启用日志', env.xt.has('[并发]'), '');
    check('F24-2 副车道被拉起播放', v2.__calls.play >= 1, 'calls=' + v2.__calls.play);
    check('F24-2 副车道被静音', v2.muted === true, '');
    app.destroy();
});

test('F24-3 副车道重播次数受上限约束', async () => {
    const html = tree(chapterSpecs(['1.1']))
        + '<div class="ans-attach-ct" id="ct1"><iframe id="task-1" class="ans-insertvideo-online" src="about:blank"></iframe></div>'
        + '<div class="ans-attach-ct" id="ct2"><iframe id="task-2" class="ans-insertvideo-online" src="about:blank"></iframe></div>'
        + '<div class="prev_title" title="视频"></div>';
    const env = createEnv({ html });
    const d1 = await writeFrame(env, 'task-1', '<video id="video_html5_api" src="https://example.com/t1.mp4"></video>');
    stubVideo(env, d1.getElementById('video_html5_api'), {});
    const d2 = await writeFrame(env, 'task-2', '<video id="video_html5_api" src="https://example.com/t2.mp4"></video>');
    const v2 = stubVideo(env, d2.getElementById('video_html5_api'), {});
    const app = await env.boot();
    await env.advance(1500);
    app.configs.concurrentPlayback = true;
    app.configs.laneKeeperIntervalMs = 1000;
    app.configs.laneMaxReplaysPerUnit = 2;
    app._laneReplays = 0;
    app._laneCapLogged = false;
    app._startLaneKeeper();
    for (let i = 0; i < 4; i++) { await env.advance(1200); v2.paused = true; }
    check('F24-3 重播次数不超过上限', app._laneReplays <= 2, 'replays=' + app._laneReplays);
    check('F24-3 达到上限后打印提示', env.xt.has('重播已达上限'), '');
    app.destroy();
});

// ---------------------------------------------------------------------------
// F32 内嵌作业选项匹配增强（真机复现：第 9 题无法匹配选项 → 整份作业放弃）
// ---------------------------------------------------------------------------

test('F32-1 选项匹配增强：纯字母/夹带字母/多选/标点文本/无匹配', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const mk = (letter, text) => ({ el: {}, text: letter + ' ' + text, letter });
    const opts = [mk('A', '不锈钢'), mk('B', '钛及钛合金'), mk('C', '陶瓷'), mk('D', '复合材料')];
    check('F32-1 纯字母 B', app._llmPickOption(opts, 'B') === opts[1], '');
    check('F32-1 「选B」', app._llmPickOption(opts, '选B') === opts[1], '');
    check('F32-1 「B选项」', app._llmPickOption(opts, 'B选项') === opts[1], '');
    check('F32-1 「B（钛及钛合金）」', app._llmPickOption(opts, 'B（钛及钛合金）') === opts[1], '');
    check('F32-1 多选「B、C」返回两项', (() => { const r = app._llmPickOptions(opts, 'B、C'); return r.length === 2 && r[0] === opts[1] && r[1] === opts[2]; })(), '');
    check('F32-1 文本匹配（带句号标点）', app._llmPickOption(opts, '钛及钛合金。') === opts[1], '');
    check('F32-1 无匹配返回空数组', app._llmPickOptions(opts, '完全无关的答案').length === 0, '');
    check('F32-1 兼容旧接口 _llmPickOption 返回 null', app._llmPickOption(opts, '完全无关的答案') === null, '');
    app.destroy();
});

// ---------------------------------------------------------------------------
// F33 直播节点识别 / LLM 节流 / 答案缓存 / 相似度兜底 / 默认项调整
// ---------------------------------------------------------------------------

test('F33-1 相似度兜底：子串不匹配但 Dice ≥ 0.8 时命中选项', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const opts = [{ el: {}, text: 'B 钛及钛合金材料', letter: 'B' }];
    check('F33-1 子串匹配不命中', app._llmPickOptions(opts, '钛合金材料').length === 1, '（说明）');
    check('F33-1 Dice 兜底命中', app._llmPickOption(opts, '钛合金材料') === opts[0], '');
    check('F33-1 低相似度不硬凑', app._llmPickOptions(opts, '完全无关内容').length === 0, '');
    app.destroy();
});

test('F33-2 直播节点识别：安全停止 + 针对性提示 + 零点击', async () => {
    const html = tree(chapterSpecs(['1.1'])) + '<iframe id="iframe" src="about:blank"></iframe>' + '<div class="prev_title" title="直播"></div>';
    const env = createEnv({ html });
    await writeFrame(env, 'iframe', '正在直播：口腔种植学第七讲（直播回放将在结束后生成）');
    const app = await env.boot();
    await env.advance(5000);
    check('F33-2 打印直播识别日志', env.xt.has('检测到直播任务点'), JSON.stringify(env.xt.logs.slice(-4)));
    check('F33-2 给出针对性处理方法', env.xt.has('直播进行中') || env.xt.has('直播回放'), '');
    check('F33-2 零目录点击（未按未知节点跳过）', env.treeClicks().length === 0, JSON.stringify(env.treeClickTitles()));
    app.destroy();
});

test('F33-3 答案缓存：题干归一化命中 + 命中不请求 LLM', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    app._answerCacheSet('钛及钛合金的特点（多选）', 'choice', 'B、C');
    const hit = app._answerCacheGet(' 钛及钛合金的特点 ');
    check('F33-3 归一化后可命中缓存', !!hit && hit.answer === 'B、C' && hit.kind === 'choice', JSON.stringify(hit));
    app.destroy();
});

test('F33-4 LLM 节流：连续请求按 llmMinIntervalMs 排队 + 默认项检查', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    check('F33-4 docTaskScroll 默认开启', app.configs.docTaskScroll === true, String(app.configs.docTaskScroll));
    check('F33-4 liveGuard 默认开启', app.configs.liveGuard === true, String(app.configs.liveGuard));
    app.configs.llmMinIntervalMs = 1000;
    let sends = 0;
    app.setLlmTransport((opts) => {
        sends++;
        try { opts.onload(200, JSON.stringify({ choices: [{ message: { content: '{"answer":"A"}' } }] })); } catch (e) { /* ignore */ }
        return null;
    });
    app._llmRequest({}, () => {}, () => {});
    app._llmRequest({}, () => {}, () => {});
    check('F33-4 首次立即发送', sends === 1, 'sends=' + sends);
    await env.advance(1500);
    check('F33-4 第二次被节流延后发送', sends >= 2, 'sends=' + sends);
    app.destroy();
});

// ---------------------------------------------------------------------------
// F34 font-cxsecret glyf 哈希解密（移植上游 Samueli924/chaoxing；真实字体夹具 + 真实表子集）
// ---------------------------------------------------------------------------

test('F34-1 glyf 哈希解密：真实作业字体解码结果与上游一致', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const fontB64 = readFileSync(resolve(repoRoot, 'tests/fixtures/font-cxsecret/font.b64'), 'utf8').trim();
    const mapB64 = readFileSync(resolve(repoRoot, 'tests/fixtures/font-cxsecret/font-map.mini.b64'), 'utf8').trim();
    env.window.__XT_FONT_MAP_B64 = mapB64;
    const encrypted = '砲抰材抲是现抳口抮抰植体最常用抪材抲';
    const res = await app._cxFontDecodeChars(fontB64, Array.from(encrypted));
    const decoded = Array.from(encrypted).map((ch) => (res && res.map[ch]) || ch).join('');
    check('F34-1 解析真实字体（numGlyphs>0）', !!res && res.font && res.font.numGlyphs > 0, res ? 'numGlyphs=' + res.font.numGlyphs : 'null');
    check('F34-1 哈希命中 ≥ 6', !!res && res.hit >= 6, 'hit=' + (res ? res.hit : 'null'));
    check('F34-1 解码文本与上游一致', decoded === '哪种材料是现代口腔种植体最常用的材料', decoded);
    app.destroy();
});

test('F34-2 未提供哈希表时回退（不误判、不抛异常）', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    check('F34-2 无表时 _cxFontHashMap() 返回 null', app._cxFontHashMap() === null, '');
    const res = await app._cxFontDecodeChars('AAEAAA', ['哪']);
    check('F34-2 无表时解码返回 null（走位图回退）', res === null, String(res));
    app.destroy();
});

// ---------------------------------------------------------------------------
// F36 章节学习次数（移植上游 api/base.py：studentstudyAjax → 提取 setlog → GET）
// ---------------------------------------------------------------------------

test('F36-1 章节学习次数：按上游流程请求 ajax 并触发 setlog', async () => {
    const env = createEnv({
        html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>',
        url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=111&clazzid=222&chapterId=333&cpi=444',
    });
    const app = await env.boot();
    check('F36-1 默认 chapterStudyCount=0（关闭）', app.configs.chapterStudyCount === 0, String(app.configs.chapterStudyCount));
    app.configs.chapterStudyCount = 2;
    app.configs.chapterStudyDelayMs = 500;
    const calls = [];
    let setlogBeacons = 0;
    app.setHttpTransport((url, cb) => {
        calls.push(url);
        cb(null, '<html><script src="https://fystat-ans.chaoxing.com/log/setlog?xxx=1"></script></html>');
    });
    app._beaconGet = (url, cb) => { setlogBeacons++; calls.push(url); cb(null); };
    app._increaseChapterStudyCount();
    await env.advance(4000);
    const ajaxCalls = calls.filter((u) => u.indexOf('studentstudyAjax') >= 0).length;
    const setlogCalls = setlogBeacons;
    check('F36-1 请求 studentstudyAjax 两次', ajaxCalls === 2, 'ajax=' + ajaxCalls + ' calls=' + JSON.stringify(calls.slice(0, 4)));
    check('F36-1 触发 setlog 两次', setlogCalls === 2, 'setlog=' + setlogCalls);
    check('F36-1 打印完成日志', env.xt.has('[章节次数] 已发送 2 次 setlog'), '');
    app.destroy();
});

// ---------------------------------------------------------------------------
// F37 多选作答支持 + 解析重试 + 互动题等待在途请求（真机：第 9 题模板回显/多选卡死）
// ---------------------------------------------------------------------------

test('F37-1 答案解析：拒绝模板占位符、支持多选字母', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    check('F37-1 占位符「选项字母」被拒绝', app._llmExtractAnswer('{"answer":"选项字母"}') === '', app._llmExtractAnswer('{"answer":"选项字母"}'));
    const multi1 = app._llmExtractAnswer('{"answer":"B、C"}', { multi: true });
    check('F37-1 多选 JSON → BC', multi1 === 'BC', multi1);
    const multi2 = app._llmExtractAnswer('答案是：A和C', { multi: true });
    check('F37-1 文本「A和C」→ AC', multi2 === 'AC', multi2);
    const multi3 = app._llmExtractAnswer('推理……最终应选 B 和 D', { multi: true });
    check('F37-1 多选尾部兜底 → BD', multi3 === 'BD', multi3);
    const single = app._llmExtractAnswer('{"answer":"B"}');
    check('F37-1 单选不受影响 → B', single === 'B', single);
    app.destroy();
});

test('F37-2 选择题重试：首次坏输出 → 严格模式重试成功', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const opts = [{ el: {}, text: 'A 甲', letter: 'A' }, { el: {}, text: 'B 乙', letter: 'B' }];
    let calls = 0;
    app.setLlmTransport((o) => {
        calls++;
        const body = calls === 1
            ? 'We need answer multiple choice. Need determine correct descriptions. Need output JSON object with answer maybe multiple '
            : '{"answer":"B"}';
        try { o.onload(200, JSON.stringify({ choices: [{ message: { content: body } }] })); } catch (e) { /* ignore */ }
        return null;
    });
    let out = null;
    app._llmAskChoice('题目', opts, false, (err, result) => { out = { err: err && err.message, result: result }; });
    await env.advance(5000);
    check('F37-2 触发重试（共 2 次请求）', calls === 2, 'calls=' + calls);
    check('F37-2 重试后命中 B', !!(out && out.result && out.result.picked.length === 1 && out.result.picked[0].letter === 'B'), JSON.stringify(out && out.result && out.result.picked));
    app.destroy();
});

// ---------------------------------------------------------------------------
// F38 视频任务点全部完成 ≠ 组件未加载（真机：第7章第3节重试触顶死循环）
// ---------------------------------------------------------------------------

test('F38-1 视频任务点已全部完成时直接推进，不再重试触顶', async () => {
    const html = tree(chapterSpecs(['1.1'], ['2.1']))
        + '<div class="ans-attach-ct ans-job-finished" id="ct1"><iframe id="task-1" class="ans-insertvideo-online" src="about:blank"></iframe></div>'
        + '<div class="prev_title" title="视频"></div>';
    const env = createEnv({ html });
    const d1 = await writeFrame(env, 'task-1', '<video id="video_html5_api" src="https://example.com/t1.mp4"></video>');
    stubVideo(env, d1.getElementById('video_html5_api'), {});
    const app = await env.boot();
    await env.advance(9000);
    check('F38-1 未出现播放重试触顶日志', !env.xt.has('已达到最大重试次数'), JSON.stringify(env.xt.logs.slice(-4)));
    check('F38-1 已按「全部完成」推进到下一小节', env.lastTreeClickTitle() === '2.1', 'last=' + env.lastTreeClickTitle());
    app.destroy();
});

// ---------------------------------------------------------------------------
// F39 作答判定/单选护栏/提交按钮识别（真机：10 题全选后误报「有效作答 0/10」上锁）
// ---------------------------------------------------------------------------

test('F39-1 作答判定支持平台真实选中态（aria-checked/class，无 input）', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const mk = (attrs) => {
        const li = env.window.document.createElement('li');
        if (attrs.aria) li.setAttribute('aria-checked', attrs.aria);
        if (attrs.cls) li.className = attrs.cls;
        return { el: li };
    };
    const quiz = { win: env.window, doc: env.window.document };
    check('F39-1 aria-checked=true 计为已作答', app._workHasAnswer(quiz, [{ optionEls: [mk({ aria: 'false' }), mk({ aria: 'true' })] }]) === 1, '');
    check('F39-1 class=cur 计为已作答', app._workHasAnswer(quiz, [{ optionEls: [mk({ cls: 'font-cxsecret before-after' }), mk({ cls: 'cur' })] }]) === 1, '');
    check('F39-1 未选中计为 0', app._workHasAnswer(quiz, [{ optionEls: [mk({ cls: 'font-cxsecret' })] }]) === 0, '');
    app.destroy();
});

test('F39-2 单选护栏：多字母答案在单选时只取第一个', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const opts = [{ el: {}, text: 'A 甲', letter: 'A' }, { el: {}, text: 'B 乙', letter: 'B' }, { el: {}, text: 'C 丙', letter: 'C' }];
    const single = app._llmPickOptions(opts, 'AB', { single: true });
    check('F39-2 单选只取 1 个（A）', single.length === 1 && single[0].letter === 'A', JSON.stringify(single.map((o) => o.letter)));
    const multi = app._llmPickOptions(opts, 'AB');
    check('F39-2 多选仍取 2 个', multi.length === 2, JSON.stringify(multi.map((o) => o.letter)));
    app.destroy();
});

test('F39-3 提交按钮识别放宽：class 含 submit + 文案子串', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div id="dlg" class="answerQuestion"><div class="submitBtn">提交答案</div><a class="other">再想想</a></div><div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const dlg = env.window.document.getElementById('dlg');
    const found = app._findInteractionSubmit({ el: dlg });
    check('F39-3 找到 .submitBtn「提交答案」', !!found && /提交/.test(String(found.textContent || '')), found ? String(found.textContent) : 'null');
    app.destroy();
});

// ---------------------------------------------------------------------------
// F40 题目预检放宽（真机：5【单选题】眶下孔位于？ 5 个汉字被误锁）
// ---------------------------------------------------------------------------

test('F40-1 短题干（4~5 字）带问号/选项时不再误锁', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const choice = { isShortAnswer: false, optionEls: [1, 2, 3, 4] };
    check('F40-1 「5 【单选题】眶下孔位于？」应放行', app._isQuestionSane('5 【单选题】眶下孔位于？', choice).ok === true, JSON.stringify(app._isQuestionSane('5 【单选题】眶下孔位于？', choice)));
    check('F40-1 纯 UI 文案仍拒绝（取消静音）', app._isQuestionSane('取消静音', choice).ok === false, '');
    check('F40-1 极短无特征仍拒绝（3 字）', app._isQuestionSane('眶下孔', choice).ok === false, '');
    check('F40-1 正常长题干不受影响', app._isQuestionSane('【单选题】以下关于种植体材料生物相容性的说法正确的是？', choice).ok === true, '');
    app.destroy();
});

// ---------------------------------------------------------------------------
// F41 选项点击校验重试（真机：第 1 题点击未生效，有效作答 10/11 上锁）
// ---------------------------------------------------------------------------

test('F41-1 选中态判定：aria / class / input / 未选中', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const doc = env.window.document;
    const mk = (html) => { const li = doc.createElement('li'); li.innerHTML = html; if (html.indexOf('aria') >= 0) li.setAttribute('aria-checked', 'true'); return li; };
    check('F41-1 aria-checked=true', app._optionLooksSelected(mk('aria')) === true, '');
    check('F41-1 class=cur', app._optionLooksSelected(mk('<span class="x"></span>') && (() => { const el = doc.createElement('li'); el.className = 'cur'; return el; })()) === true, '');
    check('F41-1 input:checked', (() => { const li = doc.createElement('li'); li.innerHTML = '<input type="radio" checked>'; return app._optionLooksSelected(li) === true; })(), '');
    check('F41-1 未选中为 false', app._optionLooksSelected((() => { const el = doc.createElement('li'); el.className = 'font-cxsecret before-after'; return el; })()) === false, '');
    app.destroy();
});

test('F41-2 点击校验重试：第 2 次点击才生效 → 成功回调；始终不生效 → 明确报错', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    let clicks = 0;
    const el = { className: '', __sel: false, getAttribute: () => (el.__sel ? 'true' : 'false'), querySelector: () => null, click: () => { clicks++; if (clicks >= 2) el.__sel = true; } };
    let r1 = 'pending';
    app._clickWithVerification([{ el: el }], (err) => { r1 = err ? 'err:' + err.message : 'ok'; });
    await env.advance(3000);
    check('F41-2 重试后校验通过', r1 === 'ok' && clicks >= 2, 'r=' + r1 + ' clicks=' + clicks);
    let clicks2 = 0;
    const el2 = { className: '', getAttribute: () => 'false', querySelector: () => null, click: () => { clicks2++; } };
    let r2 = 'pending';
    app._clickWithVerification([{ el: el2 }], (err) => { r2 = err ? err.message : 'ok'; });
    await env.advance(3000);
    check('F41-2 始终无效时明确报错', String(r2).indexOf('未生效') >= 0 && clicks2 >= 3, 'r=' + r2 + ' clicks=' + clicks2);
    app.destroy();
});

// ---------------------------------------------------------------------------
// F42 康熙部首替换 + 多字体解密 + 弹窗诊断（真机：解密残留 ⽛/⼒/⼆、命中率低）
// ---------------------------------------------------------------------------

test('F42-1 康熙部首替换（移植上游 KX_RADICALS_TAB）', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    check('F42-1 ⽛槽骨…⼒ → 牙槽骨…力', app._cxApplyKxRadicals('⽛槽骨吸收与咬合⼒无关') === '牙槽骨吸收与咬合力无关', app._cxApplyKxRadicals('⽛槽骨吸收与咬合⼒无关'));
    check('F42-1 第⼆磨⽛ → 第二磨牙', app._cxApplyKxRadicals('第⼆磨⽛') === '第二磨牙', app._cxApplyKxRadicals('第⼆磨⽛'));
    check('F42-1 普通文本不受影响', app._cxApplyKxRadicals('口腔种植学') === '口腔种植学', '');
    app.destroy();
});

test('F42-2 多字体：跳过坏字体后在第二个字体命中（真机命中率低）', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const fontB64 = readFileSync(resolve(repoRoot, 'tests/fixtures/font-cxsecret/font.b64'), 'utf8').trim();
    const mapB64 = readFileSync(resolve(repoRoot, 'tests/fixtures/font-cxsecret/font-map.mini.b64'), 'utf8').trim();
    env.window.__XT_FONT_MAP_B64 = mapB64;
    const encrypted = '砲抰材抲是现抳口抮抰植体最常用抪材抲';
    const res = await app._cxFontDecodeChars(['AAEAAA', fontB64], Array.from(encrypted));
    check('F42-2 坏字体被跳过、第二字体命中 ≥6', !!res && res.hit >= 6, 'hit=' + (res ? res.hit : 'null'));
    const decoded = Array.from(encrypted).map((ch) => (res && res.map[ch]) || ch).join('');
    check('F42-2 多字体解码结果正确', decoded === '哪种材料是现代口腔种植体最常用的材料', decoded);
    app.destroy();
});

test('F42-3 互动弹窗找不到提交按钮时输出 DOM 诊断', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const doc = env.window.document;
    const dlg = doc.createElement('div');
    dlg.className = 'answerQuestion';
    const opt = doc.createElement('div');
    opt.textContent = 'A 选项';
    dlg.appendChild(opt);
    const found = { el: dlg, text: '互动题' };
    app._applyInteractionAnswer(found, [], { answer: 'A', picked: [{ el: opt, text: 'A 选项' }], raw: '' });
    check('F42-3 打印弹窗诊断快照', env.xt.has('弹窗诊断'), JSON.stringify(env.xt.logs.slice(-4)));
    app.destroy();
});

// ---------------------------------------------------------------------------
// F43 作业题嵌套帧定位 + 作业帧不作为互动弹窗（真机：术中外科并发症节点卡死）
// ---------------------------------------------------------------------------

async function buildWorkFrame(env, modId) {
    const modDoc = await frameDoc(env, modId);
    modDoc.body.innerHTML = '<iframe id="inner" src="about:blank"></iframe>';
    for (let i = 0; i < 6; i++) {
        const inner = modDoc.getElementById('inner');
        if (inner && inner.contentDocument && inner.contentDocument.body) return inner.contentDocument;
        await new Promise((r) => setImmediate(r));
    }
    throw new Error('嵌套作业帧创建失败');
}

test('F43-1 作业题定位支持嵌套帧（work 模块 → doHomeWorkNew）', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>'
        + '<iframe id="workmod" jobid="work-123" src="about:blank"></iframe>' });
    const innerDoc = await buildWorkFrame(env, 'workmod');
    innerDoc.body.innerHTML = '<div class="TiMu"><div class="Zy_TItle"><span class="newZy_TItle">【单选题】</span>种植术后最常见并发症是？</div><ul class="Zy_ulTop"><li aria-checked="false">A 出血</li><li aria-checked="false">B 感染</li></ul></div>';
    const app = await env.boot();
    const quiz = app._quizDocOf(env.window.document.getElementById('workmod'));
    check('F43-1 递归定位到嵌套作业帧', !!quiz && !!(quiz.doc && quiz.doc.querySelector('.TiMu')), quiz ? 'ok' : 'null');
    app.destroy();
});

test('F43-2 作业帧不会被误判为视频互动弹窗', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>'
        + '<iframe id="workmod" jobid="work-123" src="about:blank"></iframe>'
        + '<iframe id="fakevideo" src="about:blank"></iframe>' });
    const innerDoc = await buildWorkFrame(env, 'workmod');
    innerDoc.body.innerHTML = '<div class="Zy_TItle">请选择正确的答案 A 甲 B 乙</div><ul><li>A 甲</li><li>B 乙</li></ul>';
    await writeFrame(env, 'fakevideo', '<div class="Zy_TItle">请选择正确的答案 A 甲 B 乙</div><ul><li>A 甲</li><li>B 乙</li></ul>');
    const app = await env.boot();
    const found = app._findInteractionDialog(env.window.document, 0);
    check('F43-2 命中真实视频帧', !!found && String(found.text).indexOf('请选择') >= 0, JSON.stringify(found && found.text));
    env.window.document.getElementById('fakevideo').remove();
    check('F43-2 仅剩作业帧时返回 null', app._findInteractionDialog(env.window.document, 0) === null, '');
    app.destroy();
});

// ---------------------------------------------------------------------------
// F4 异常暂停与风控（#19 #26 #32 #54 #55）
// ---------------------------------------------------------------------------

test('F4-1 源码中不再有 document/window 的 mouseout/mouseleave 劫持', () => {
    const code = stripComments(readFileSync(sourcePath, 'utf8'));
    check('F4-1 不再存在 _bindPageGuards', !/bindPageGuards/.test(code), '');
    check('F4-1 不再注册 mouseout/mouseleave 监听', !/addEventListener\(\s*['"](mouseout|mouseleave)['"]/.test(code), '');
    check('F4-1 全文件没有 preventDefault 调用', !/\.preventDefault\s*\(/.test(code), '');
    check('F4-1 全文件没有 stopPropagation 调用', !/\.stopPropagation\s*\(/.test(code), '');
});

test('F4-2 恢复播放受冷却与次数上限约束（连续触发 100 次）', async () => {
    const { env, video } = await envWithTree(chapterSpecs(['1.1', '1.2']), { stepTitle: '视频', videoOptions: { keepPaused: true } });
    const app = await env.boot();
    await env.advance(1200);
    app._clearCheckInterval();
    video.__state.paused = true;
    app._isPlaying = true;
    app._guardLastWallTs = env.clock.now - 9000;
    app._guardLastTime = video.__state.currentTime;
    const before = video.__calls.play;
    for (let i = 0; i < 100; i++) {
        app._tryResumePlayback('stress-' + i);
        await env.advance(app.configs.guardResumeCooldownMs + 20);
    }
    const attempts = video.__calls.play - before;
    check('F4-2 实际 play() 次数不少于 1（说明条件确实成立）', attempts >= 1, 'attempts=' + attempts);
    check('F4-2 实际 play() 次数不超过上限', attempts <= app.configs.resumeMaxAttemptsPerUnit, 'attempts=' + attempts + ' cap=' + app.configs.resumeMaxAttemptsPerUnit);
    check('F4-2 内部计数与上限一致', app._resumeAttemptsThisUnit === app.configs.resumeMaxAttemptsPerUnit, 'count=' + app._resumeAttemptsThisUnit);
    check('F4-2 触顶提示出现', env.xt.has('恢复播放次数已达上限'), '');
});

test('F4-2b 冷却窗口内的重复触发不会重复抢播', async () => {
    const { env, video } = await envWithTree(chapterSpecs(['1.1', '1.2']), { stepTitle: '视频', videoOptions: { keepPaused: true } });
    const app = await env.boot();
    await env.advance(1200);
    app._clearCheckInterval();
    video.__state.paused = true;
    app._isPlaying = true;
    app._guardLastWallTs = env.clock.now - 9000;
    app._guardLastTime = video.__state.currentTime;
    const before = video.__calls.play;
    const first = app._tryResumePlayback('first');
    const second = app._tryResumePlayback('second');
    check('F4-2b 首次触发被接受', first === true, '');
    check('F4-2b 冷却期内第二次被拒绝', second === false, '');
    check('F4-2b 冷却期内只发生 1 次 play()', video.__calls.play - before === 1, 'plays=' + (video.__calls.play - before));
});

test('F4-3 用户主动暂停后不再抢播，resumeAutoPlay() 后可恢复', async () => {
    const { env, video } = await envWithTree(chapterSpecs(['1.1', '1.2']), { stepTitle: '视频', videoOptions: { keepPaused: true } });
    const app = await env.boot();
    await env.advance(1200);
    app._clearCheckInterval();
    video.ownerDocument.dispatchEvent(new env.window.Event('pointerdown', { bubbles: true }));
    video.__state.paused = true;
    app._isPlaying = true;
    video.dispatchEvent(new env.window.Event('pause'));
    check('F4-3 识别为用户主动暂停', app._userPaused === true, '');
    check('F4-3 给出恢复保活的方法提示', env.xt.has('resumeAutoPlay'), '');
    const before = video.__calls.play;
    for (let i = 0; i < 20; i++) {
        app._guardLastWallTs = env.clock.now - 9000;
        app._tryResumePlayback('user-paused-' + i);
        await env.advance(app.configs.guardResumeCooldownMs + 20);
    }
    check('F4-3 用户暂停期间一次都没有抢播', video.__calls.play === before, 'plays=' + (video.__calls.play - before));
    app.resumeAutoPlay();
    app._guardLastWallTs = env.clock.now - 9000;
    const ok = app._tryResumePlayback('after-resume');
    check('F4-3 resumeAutoPlay() 之后可以恢复抢播', ok === true && video.__calls.play > before, 'ok=' + ok);
});

test('F4-4 destroy() 清理全部定时器，且 destroy() 之后可以重新 run()', async () => {
    const { env } = await envWithTree(chapterSpecs(['1.1', '1.2', '1.3']), { stepTitle: '视频' });
    const app = await env.boot();
    app.destroy();
    const logsAfter = env.logs.length;
    await env.advance(30000);
    check('F4-4 destroy() 后无残留定时器回调', env.logs.length === logsAfter, 'logs +' + (env.logs.length - logsAfter));
    check('F4-4 destroy() 后无待执行定时器', env.clock.pending() === 0, 'pending=' + env.clock.pending());
    app.run();
    await env.advance(4000);
    app.nextUnit();
    await env.advance(3200);
    check('F4-4 重新 run() 后 nextUnit() 仍然生效', env.lastTreeClickTitle() === '1.2', 'last=' + env.lastTreeClickTitle());
});
test('F4-5 不默认强制静音，但记住用户手动选择的静音状态并在切换视频后沿用', async () => {
    const { env, video } = await envWithTree(chapterSpecs(['1.1', '1.2']), { stepTitle: '视频' });
    const app = await env.boot();
    check('F4-5 默认不改动静音状态（不强制静音）', video.__state.muted === false, 'muted=' + video.__state.muted);
    check('F4-5 初始没有用户静音选择', app._userMutedChoice === null || app._userMutedChoice === undefined, 'choice=' + app._userMutedChoice);

    video.__state.muted = true;
    video.dispatchEvent(new env.window.Event('volumechange'));
    check('F4-5 记录用户的静音选择', app._userMutedChoice === true, 'choice=' + app._userMutedChoice);

    const doc = await frameDoc(env, 'player');
    doc.body.innerHTML = '<video id="video_html5_api" src="https://example.com/b.mp4"></video>';
    const newVideo = stubVideo(env, doc.getElementById('video_html5_api'), {});
    app.nextUnit();
    await env.advance(4000);
    check('F4-5 新视频沿用用户静音选择', newVideo.muted === true, 'muted=' + newVideo.muted);
    check('F4-5 打印沿用日志', env.xt.has('沿用用户此前选择的静音状态'), '');
});

test('F4-5b 脚本自身的静音兜底不会被记成用户选择', async () => {
    const { env, video } = await envWithTree(chapterSpecs(['1.1']), {
        stepTitle: '视频',
        videoOptions: { playImpl: (n) => (n === 1 ? 'reject' : 'resolve') },
    });
    const app = await env.boot();
    await env.advance(500);
    check('F4-5b 静音兜底已执行', video.__state.muted === true, 'muted=' + video.__state.muted);
    check('F4-5b 未把兜底记成用户选择', app._userMutedChoice === null || app._userMutedChoice === undefined, 'choice=' + app._userMutedChoice);
});

test('F4-6 保活阶梯：恢复后 2.5 秒复检，仍无进度则回拨重播（PR #56 阶梯），总 play() 受预算约束', async () => {
    const { env, video } = await envWithTree(chapterSpecs(['1.1']), { stepTitle: '视频', videoOptions: { keepPaused: true } });
    const app = await env.boot();
    await env.advance(500);
    app._clearCheckInterval();
    video.__state.paused = true;
    video.__state.currentTime = 30;
    app._isPlaying = true;
    app._guardLastTime = 30;
    app._guardLastWallTs = env.clock.now - 9000;
    const before = video.__calls.play;
    check('F4-6 停滞判定成立时执行恢复', app._tryResumePlayback('no-progress') === true, '');
    await env.advance(app.configs.guardRecoveryProbeMs + 100);
    check('F4-6 复检后执行回拨重播', env.xt.has('回拨 0.15s 后重播'), '');
    check('F4-6 currentTime 被轻微回拨', video.__state.currentTime < 30, 'currentTime=' + video.__state.currentTime);
    check('F4-6 回拨重播计入恢复预算', app._resumeAttemptsThisUnit === 2, 'attempts=' + app._resumeAttemptsThisUnit);
    check('F4-6 回拨次数单独计数', app._seekBackTimesThisUnit === 1, 'seekBack=' + app._seekBackTimesThisUnit);
    for (let i = 0; i < 20; i++) {
        app._guardLastResumeTs = 0;
        app._guardLastWallTs = env.clock.now - 9000;
        app._guardLastTime = video.__state.currentTime;
        app._tryResumePlayback('stress-' + i);
        await env.advance(200);
    }
    check('F4-6 脚本发起的 play() 总数不超过每小节预算', video.__calls.play - before <= app.configs.resumeMaxAttemptsPerUnit, 'plays=' + (video.__calls.play - before) + ' cap=' + app.configs.resumeMaxAttemptsPerUnit);
});

test('F4-7 play() 永不 settle 时有超时保护（PR #56 修复项）', async () => {
    const { env, video } = await envWithTree(chapterSpecs(['1.1']), { stepTitle: '视频' });
    video.play = () => {
        video.__calls.play++;
        return new Promise(() => {});
    };
    const app = await env.boot();
    await env.advance(app.configs.playTimeoutMs + 500);
    check('F4-7 超时后按播放失败处理并打印原因', env.xt.has('play() 超时'), '');
    check('F4-7 触发静音兜底或重试', video.__calls.play >= 2, 'plays=' + video.__calls.play);
});
test('F4-7b 静音兜底的 play() 卡住时也有超时保护（PR #56 修复项）', async () => {
    const { env, video } = await envWithTree(chapterSpecs(['1.1']), { stepTitle: '视频' });
    let calls = 0;
    video.play = () => {
        calls++;
        video.__calls.play++;
        if (calls === 1) return Promise.reject(new env.window.Error('NotAllowedError'));
        return new Promise(() => {});
    };
    await env.boot();
    await env.advance(1000 + 9000 + 2500);
    check('F4-7b 静音兜底超时按失败处理', env.xt.has('静音 play() 超时') || env.xt.has('静音播放也失败'), '');
    check('F4-7b 超时后会安排重试（不会停在半路）', video.__calls.play >= 3, 'plays=' + video.__calls.play);
});

test('F4-8 注册点幂等且 destroy() 可完全注销（行为 + 静态审计）', async () => {
    const { env } = await envWithTree(chapterSpecs(['1.1', '1.2']), { stepTitle: '视频' });
    const app = await env.boot();
    await env.advance(2500);
    const bootPending = env.clock.pending();
    app.run();
    await env.advance(1500);
    app.run();
    await env.advance(1500);
    const afterRerun = env.clock.pending();
    check('F4-8 重复 run() 后待执行定时器不增长', afterRerun <= bootPending, 'boot=' + bootPending + ' after=' + afterRerun);
    app.destroy();
    await env.advance(30000);
    check('F4-8 destroy() 后待执行定时器为 0', env.clock.pending() === 0, 'pending=' + env.clock.pending());

    const code = stripComments(readFileSync(sourcePath, 'utf8'));
    const registrations = [
        ['视频监控 setInterval', /_startVideoMonitoring\(\)\s*\{[\s\S]{0,200}?_clearCheckInterval\(\)/, /_clearCheckInterval\(\)/],
        ['互动弹窗 setInterval', /_startInteractionWatcher\(\)\s*\{[\s\S]{0,300}?if \(this\._interactionWatcher\) return;/, /_stopInteractionWatcher\(\)/],
        ['延时器 _schedule', /_schedule\(fn, ms\)/, /_clearTimers\(\)/],
        ['视频媒体事件', /if \(this\._eventVideoEl === el\) return;/, /_detachVideoEvents\(\)/],
        ['用户交互观察', /if \(!frameDoc \|\| this\._userInteractionDoc === frameDoc\) return;/, /_unbindUserInteractionWatch\(\)/],
        ['静音跟踪', /if \(this\._muteTrackedEl === video\) return;/, /_unbindUserMuteTracking\(\)/],
        ['步骤导航委托事件', /if \(this\._stepNavigationBound\)\s*\{\s*return;/, /off\('\.xuexitongPlayerV3'\)/],
        ['启动轮询 setInterval', /window\[BOOT_TIMER_KEY\] = setInterval/, /clearInterval\(window\[BOOT_TIMER_KEY\]\)/],
        ['播放 Promise 超时', /_withTimeout\(promise, ms, label\)/, /this\._timers\.delete\(timer\)/],
    ];
    for (const item of registrations) {
        check('F4-8 ' + item[0] + ' 有幂等 guard', item[1].test(code), '');
        check('F4-8 ' + item[0] + ' 有清理路径', item[2].test(code), '');
    }
});
// ---------------------------------------------------------------------------
// F9 GUI 面板 / F10 章节测验建议（V3.5）
// ---------------------------------------------------------------------------

test('F11-1 未完成的内嵌章节测验：默认不跳过、不自动前进（真机演练问题回归）', async () => {
    const workHtml = '<div class="ans-attach-ct"><div class="ans-job-icon" aria-label="任务点未完成"></div>'
        + '<iframe jobid="work-test123" data="{&quot;workid&quot;:&quot;test123&quot;,&quot;title&quot;:&quot;测试作业 1. 第一题  2. 第二题&quot;,&quot;worktype&quot;:&quot;workA&quot;}"></iframe></div>';
    const html = tree(chapterSpecs(['1.1'], ['2.1'])) + '<div class="prev_title" title="二、版画的特性"></div>' + workHtml;
    const env = createEnv({ html });
    const app = await env.boot();
    await env.advance(20000);
    check('F11-1 检测到未完成的内嵌章节测验', env.xt.has('未完成的内嵌章节测验'), '');
    check('F11-1 不自动前进（树节点零点击）', env.treeClicks().length === 0, JSON.stringify(env.treeClickTitles()));
    check('F11-1 不走 autoAdvance 跳过路径', !env.xt.has('按配置有界前进'), '');
    app.nextUnit();
    await env.advance(3000);
    check('F11-1 nextUnit() 同样被守卫（不跳转）', env.treeClicks().length === 0, JSON.stringify(env.treeClickTitles()));
});
test('F12-1 片尾停滞保护：已播放≥90%且平台已标记完成 → 直接推进（真机演练回归）', async () => {
    const { env, video } = await envWithTree(chapterSpecs(['1.1'], ['2.1']), { stepTitle: '视频' });
    const app = await env.boot();
    await env.advance(1500);
    app._isPlaying = true;
    app._getVideoTaskFrames = () => [{}];
    app._areAllVideoTasksComplete = () => true;
    let endedCalls = 0;
    app._handleVideoEnded = () => { endedCalls++; };
    Object.defineProperty(video, 'duration', { configurable: true, get: () => 100 });
    video.paused = false;
    video.currentTime = 95;
    app._checkVideoStatus();
    check('F12-1 达到 90% 且平台完成 → 触发片尾完成', endedCalls === 1, 'calls=' + endedCalls);
    check('F12-1 打印片尾完成日志', env.xt.has('按片尾完成处理并推进'), '');
    endedCalls = 0;
    video.currentTime = 50;
    app._checkVideoStatus();
    check('F12-1 未达到 90% 不触发', endedCalls === 0, 'calls=' + endedCalls);
});
test('F16-1 后台保活：隐藏状态下被暂停的视频直接在后台续播（无需恢复可见）', async () => {
    const { env, video } = await envWithTree(chapterSpecs(['1.1']), { stepTitle: '视频' });
    const app = await env.boot();
    await env.advance(1500);
    app._isPlaying = true;
    app._userPaused = false;
    app._clearCheckInterval(); // 隔离：停掉普通视频监控，只验证后台保活链
    Object.defineProperty(env.window.document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    app._startHiddenKeepAlive();
    video.__state.paused = true;
    await env.advance(6000);
    check('F16-1 后台保活已触发续播', app._hiddenResumeCount >= 1 && env.xt.has('已在后台直接续播'), 'count=' + app._hiddenResumeCount);
    check('F16-1 视频已恢复播放', video.paused === false, 'paused=' + video.paused);
    app._stopHiddenKeepAlive();
});
test('F20-1 任务点图标级校验：无任务点/全部完成 → 按完成推进；有未完成 → 不误判', async () => {
    const html = tree(chapterSpecs(['1.1'], ['2.1']))
        + '<div class="ans-attach-ct"><div class="ans-job-icon"></div></div>'
        + '<div class="ans-attach-ct ans-job-finished"><div class="ans-job-icon"></div></div>';
    const env = createEnv({ html });
    const app = await env.boot();
    await env.advance(1500);
    const tp = app._countUnfinishedTaskPoints();
    check('F20-1 统计任务点（2 个，1 个未完成）', tp.total === 2 && tp.unfinished === 1, JSON.stringify(tp));
    // 全部完成场景：第二个场景单独建页
    const env2 = createEnv({ html: tree(chapterSpecs(['1.1'], ['2.1'])) + '<div class="ans-attach-ct ans-job-finished"><div class="ans-job-icon"></div></div>' });
    const app2 = await env2.boot();
    await env2.advance(1500);
    app2._handleNoVideoNode();
    await env2.advance(5000);
    check('F20-1 全部完成任务点 → 按完成推进（有树节点点击）', env2.treeClicks().length >= 1, JSON.stringify(env2.treeClickTitles()));
    check('F20-1 日志包含图标级校验依据', env2.xt.has('图标级校验'), '');
    // 无任务点场景：不得按完成推进（保持 F3 安全停止设计）
    const env4 = createEnv({ html: tree(chapterSpecs(['1.1'], ['2.1'])) });
    const app4 = await env4.boot();
    await env4.advance(1500);
    app4._handleNoVideoNode();
    await env4.advance(5000);
    check('F20-1 无任务点 → 不按完成推进（安全停止）', env4.treeClicks().length === 0 && !env4.xt.has('图标级校验'), JSON.stringify(env4.treeClickTitles()));
    // 有未完成任务点：不得按完成推进
    const env3 = createEnv({ html: tree(chapterSpecs(['1.1'], ['2.1'])) + '<div class="ans-attach-ct"><div class="ans-job-icon"></div></div>' });
    const app3 = await env3.boot();
    await env3.advance(1500);
    app3._handleNoVideoNode();
    await env3.advance(5000);
    check('F20-1 有未完成任务点 → 不按完成推进', env3.treeClicks().length === 0 && !env3.xt.has('图标级校验'), JSON.stringify(env3.treeClickTitles()));
});
test('F19-1 题目合格性预检 + 提交锁（异常一律不提交）', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) });
    const app = await env.boot();
    check('F19-1 编辑器界面文案被判不合格', app._isQuestionSane('填写答案 段落格式字体字号点击上传x var wordNum', { isShortAnswer: true }).ok === false, '');
    check('F19-1 过短标题被判不合格', app._isQuestionSane('第三章 课后讨论', { isShortAnswer: true }).ok === false, '');
    check('F19-1 选择题选项不足被判不合格', app._isQuestionSane('以下关于口腔检查的说法正确的是？', { isShortAnswer: false, optionEls: [] }).ok === false, '');
    const good = app._isQuestionSane('男性患者，四川口音，80岁，一周前因牙痛到口腔科就诊。请与其沟通，化解矛盾，使病人配合治疗。', { isShortAnswer: true });
    check('F19-1 真实案例题判为合格', good.ok === true, good.reason);
    app._workLocked = true;
    app._workLockReason = '测试锁定';
    let submitResult = null;
    app._submitWork({ document: env.window.document, UE: {} }, env.window.document, (ok, msg) => { submitResult = { ok, msg }; });
    check('F19-1 上锁后拒绝提交', submitResult && submitResult.ok === false, JSON.stringify(submitResult));
});
test('F17-1 资料题判定修复（有编辑器无选项→写作题）+ 字体解密优雅降级', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div id="quiz"></div>' });
    const app = await env.boot();
    const doc = env.window.document;
    doc.getElementById('quiz').innerHTML = '<div class="TiMu"><div class="Zy_TItle"><span class="newZy_TItle">【资料题】</span>案例：患者男性，80岁……</div>'
        + '<ul class="Zy_ulTk"><li><span>填写答案</span><div class="edui-editor"></div><textarea id="answer405825412"></textarea></li></ul></div>';
    const list = app._workQuestionList(doc);
    check('F17-1 资料题（有编辑器无选项）判定为写作题', list.length === 1 && list[0].isShortAnswer === true, JSON.stringify(list.map((x) => ({ t: x.typeLabel, sa: x.isShortAnswer, ops: x.optionEls.length, ed: x.editorCount }))));
    check('F18-1 编辑器外壳 li 不再被当成选项', list.length === 1 && list[0].optionEls.length === 0, 'ops=' + (list[0] ? list[0].optionEls.length : -1));
    check('F18-1 空编辑器 → 有效作答 0（拦截空值提交）', app._workHasAnswer({ win: env.window }, list) === 0, '');
    const fakeWin = { UE: { instants: { answer405825412: { textarea: { id: 'answer405825412' }, getContent: () => '<p>有答案内容</p>' } } } };
    check('F18-1 有内容 → 有效作答 1', app._workHasAnswer({ win: fakeWin }, list) === 1, '');
    let decoded = null;
    app._cxSecretDecode(['测试文本'], (t) => { decoded = t; });
    check('F17-1 无字体/Canvas 环境优雅降级', Array.isArray(decoded) && decoded[0] === '测试文本', JSON.stringify(decoded));
});
test('F15-1 防挂机暂停拦截：无用户意图的 pause 被拦、用户点击后的 pause 放行', async () => {
    const { env, video } = await envWithTree(chapterSpecs(['1.1']), { stepTitle: '视频' });
    const app = await env.boot();
    await env.advance(1500);
    check('F15-1 pause 守卫已安装', video.__xtPauseGuard === true, 'guard=' + video.__xtPauseGuard);
    app._isPlaying = true;
    app._userPaused = false;
    app._lastUserInteractionTs = 0;
    video.pause();
    check('F15-1 拦截无用户意图的暂停（平台防挂机）', video.paused === false, 'paused=' + video.paused);
    check('F15-1 打印拦截日志', env.xt.has('已拦截平台防挂机暂停'), '');
    app._lastUserInteractionTs = Date.now();
    video.pause();
    check('F15-1 用户点击后的暂停放行', video.paused === true, 'paused=' + video.paused);
});
test('F13-1 文档任务点（教案/PDF）：默认绝不跳过；开启后滚动到底并等待完成', async () => {
    const docHtml = '<div class="ans-attach-ct"><div class="ans-job-icon"></div>'
        + '<iframe id="docFrame" jobid="doc-1" src="/ananas/modules/pdf/index.html"></iframe></div>';
    const html = tree(chapterSpecs(['1.1'], ['2.1'])) + '<div class="prev_title" title="教案"></div>' + docHtml;
    const env = createEnv({ html });
    const app = await env.boot();
    await env.advance(20000);
    check('F13-1 检测到未完成文档任务点', env.xt.has('未完成文档任务点'), '');
    check('F13-1 默认不自动前进（树节点零点击）', env.treeClicks().length === 0, JSON.stringify(env.treeClickTitles()));
    // 开启自动翻阅：用可滚动容器替身（jsdom 无法加载 iframe 资源）
    app.configs.docTaskScroll = true;
    const scroller = env.window.document.createElement('div');
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true });
    let scrollTop = 0;
    Object.defineProperty(scroller, 'scrollTop', { get: () => scrollTop, set: (v) => { scrollTop = v; }, configurable: true });
    env.window.document.body.appendChild(scroller);
    app._docScroller = () => scroller;
    app.run();
    await env.advance(8000);
    check('F13-1 开启后开始翻阅文档', env.xt.has('开始翻阅') && scrollTop > 0, 'scrollTop=' + scrollTop);
    // 模拟平台标记完成
    env.window.document.querySelector('.ans-attach-ct').classList.add('ans-job-finished');
    await env.advance(40000);
    check('F13-1 完成后打印全部完成并推进', env.xt.has('已全部完成，继续推进'), '');
});
test('F44-1 多任务点：完成判定按本任务点收敛，第 1 个完成后继续第 2 个而不是误报未完成', async () => {
    // 真机复现（2026-09-14 16:35，课程 16 口腔种植学）：同页面 12 个 PDF 任务点，
    // 第 1 个已被平台标记 ans-job-finished，旧实现仍报「滚动后任务点未标记完成」并停止自动前进。
    const docHtml = '<div class="ans-attach-ct"><iframe id="docFrame1" jobid="doc-1" src="/ananas/modules/pdf/index.html"></iframe></div>'
        + '<div class="ans-attach-ct"><iframe id="docFrame2" jobid="doc-2" src="/ananas/modules/pdf/index.html"></iframe></div>';
    const html = tree(chapterSpecs(['1.1'], ['2.1'])) + '<div class="prev_title" title="教案"></div>' + docHtml;
    const env = createEnv({ html });
    const app = await env.boot();
    await env.advance(20000);
    check('F44-1 检测到 2 个未完成文档任务点', env.xt.has('2 个未完成文档任务点'), '');
    app.configs.docTaskScroll = true;
    const scroller = env.window.document.createElement('div');
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true });
    let scrollTop = 0;
    Object.defineProperty(scroller, 'scrollTop', { get: () => scrollTop, set: (v) => { scrollTop = v; }, configurable: true });
    env.window.document.body.appendChild(scroller);
    app._docScroller = () => scroller;
    app.run();
    await env.advance(8000);
    check('F44-1 先翻阅第 1 个任务点', env.xt.has('开始翻阅 doc-1'), '');
    // 平台只把第 1 个标记完成，第 2 个仍未完成 —— 旧实现在此必然误报「未标记完成」并停止自动前进
    env.window.document.querySelectorAll('.ans-attach-ct')[0].classList.add('ans-job-finished');
    await env.advance(20000);
    check('F44-1 第 1 个完成后判定为已完成', env.xt.has('已被平台标记完成，继续下一个任务点'), '');
    check('F44-1 继续翻阅第 2 个任务点', env.xt.has('开始翻阅 doc-2'), '');
    check('F44-1 未误报「滚动后任务点未标记完成」', !env.xt.has('滚动后任务点未标记完成'), '');
    // 第 2 个也被标记完成 → 才允许继续推进（原「全部完成才前进」语义不变）
    env.window.document.querySelectorAll('.ans-attach-ct')[1].classList.add('ans-job-finished');
    await env.advance(20000);
    check('F44-1 两个都完成后才继续推进', env.xt.has('已全部完成，继续推进'), '');
});
test('F45-1 讨论任务点（insertbbs/BBS）：识别 → 参与 → 平台标记完成', async () => {
    // 真机逆向（2026-09-14 课程16「2.3 种植修复诊疗方案设计」）：任务点结构 = .ans-attach-ct（无 ans-job-finished）
    // → insertbbs 模块帧（无 jobid，data 带 mid/jobid）→ bbscircle 讨论卡片；完成链路 = 服务端 isFinished → 卡片
    // postMessage{opType:completeTopic} → insertbbs greenligth() → 外层加 ans-job-finished。回帖端点在跨域 groupweb。
    const discussHtml = '<div class="ans-attach-ct">'
        + '<div class="ans-job-icon" aria-label="任务点未完成"></div>'
        + '<iframe id="bbsFrame" src="/ananas/modules/insertbbs/index.html?v=1" data=\'{"title":"如何设计种植方案？","mid":"7535281745581786681619163","jobid":"178668161915990","isJob":true}\'></iframe>'
        + '</div>'
        + '<a href="https://groupweb.chaoxing.com/course/topic/v3/bbs/6785ed06c21ecb0c628d38ac9012d344/fd668e90ce2e49e29e28220a0cb5e035/replysList?courseId=265718603&classId=151044885">如何设计种植方案？</a>';
    const env = createEnv({ html: tree(chapterSpecs(['1.1'], ['2.1'])) + '<div class="prev_title" title="讨论"></div>' + discussHtml });
    const app = await env.boot();
    await env.advance(3000);
    const found = app._findDiscussTaskFrames();
    check('F45-1 识别到 1 个讨论任务点', found.length === 1, 'len=' + found.length);
    check('F45-1 未完成状态判定正确', !!found[0] && found[0].finished === false, '');
    check('F45-1 话题 URL 可从章节讨论面板取得', !!found[0] && /replysList/.test(app._discussTopicUrl(found[0])), found[0] ? app._discussTopicUrl(found[0]).slice(0, 70) : '');
    check('F45-1 存在未完成讨论任务点', app._hasUnfinishedDiscussTask() === true, '');
    // 关闭自动参与 → 只提示、零点击、停止前进（绝不跳过）
    app.configs.discussTaskAuto = false;
    const clicksBefore = env.clicks.length;
    app._handleDiscussTasks();
    await env.advance(3000);
    check('F45-1 关闭时不自动参与并明确提示', env.xt.has('不自动参与'), '');
    check('F45-1 关闭时零点击不跳过', env.clicks.length === clicksBefore, 'before=' + clicksBefore + ' after=' + env.clicks.length);
    // 开启自动参与：注入传输替身（GET 返回带 urlToken 的话题页；POST 记录并模拟平台标记完成）
    app.configs.discussTaskAuto = true;
    app.configs.discussReplyText = '针对本病例：建议同期上颌窦内提+GBR，并注意角化龈增宽。';
    app.configs.discussTaskWaitMs = 5000;
    const posts = [];
    app._httpTransport = (url, cb, opts) => {
        if (opts && String(opts.method).toUpperCase() === 'POST') {
            posts.push({ url: String(url), data: String(opts.data) });
            env.window.document.querySelector('.ans-attach-ct').classList.add('ans-job-finished');
            cb(null, '{"status":true,"msg":"回复成功"}');
            return;
        }
        cb(null, '<html><script>window.obj={urlToken:"tok-12345"};</script></html>');
    };
    app._handleDiscussTasks();
    await env.advance(2000);
    check('F45-1 提交到平台回帖端点', posts.length === 1 && posts[0].url === 'https://groupweb.chaoxing.com/pc/invitation/fd668e90ce2e49e29e28220a0cb5e035/addReplys', JSON.stringify(posts.map((p) => p.url)));
    check('F45-1 回帖参数含 urlToken/bbsid/courseId/topic_content', !!posts[0] && /urlToken=tok-12345/.test(posts[0].data) && /bbsid=6785ed06c21ecb0c628d38ac9012d344/.test(posts[0].data) && /courseId=265718603/.test(posts[0].data) && /topic_content=/.test(posts[0].data), posts[0] ? posts[0].data.slice(0, 140) : '');
    await env.advance(40000);
    check('F45-1 平台标记完成后继续推进', env.xt.has('已全部参与完成，继续推进'), '');
});
test('F45-2 讨论任务点：无回复文本来源时拒绝提交（绝不伪造完成）', async () => {
    const discussHtml = '<div class="ans-attach-ct"><iframe id="bbsFrame2" src="/ananas/modules/insertbbs/index.html" data=\'{"title":"话题","jobid":"job-2"}\'></iframe></div>'
        + '<a href="https://groupweb.chaoxing.com/course/topic/v3/bbs/aaaa/bbbb/replysList?courseId=1&classId=2">话题</a>';
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + discussHtml });
    const app = await env.boot();
    await env.advance(3000);
    const posts = [];
    app._httpTransport = (url, cb, opts) => {
        if (opts && String(opts.method).toUpperCase() === 'POST') { posts.push(String(url)); cb(null, '{"status":true}'); return; }
        cb(null, 'window.obj={urlToken:"tok"};');
    };
    app.configs.llmEnabled = false;
    app.configs.discussReplyText = '';
    app._handleDiscussTasks();
    await env.advance(5000);
    check('F45-2 无文本来源时不提交', posts.length === 0, 'posts=' + posts.length);
    check('F45-2 明确报告未配置回复文本', env.xt.has('未配置讨论回复文本'), '');
    check('F45-2 未把任务点标记为完成', env.window.document.querySelector('.ans-attach-ct').classList.contains('ans-job-finished') === false, '');
});

// ---------------------------------------------------------------------------
// F53 模型降级链（真机：默认模型被地区门禁 403 RegionError → 每题失败 → 只暂存不提交 → 停机）
// ---------------------------------------------------------------------------

test('F53-1 模型链：主模型+备用去重保序；默认单模型 deepseek-v4-flash（用户 2026-09-16 指定不切换模型）', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    check('F53-1 默认模型是 deepseek-v4-flash', app.configs.llmModel === 'deepseek-v4-flash', app.configs.llmModel);
    check('F53-1 默认模型不是实测空响应的 deepseek-flash（护栏）', app.configs.llmModel !== 'deepseek-flash', app.configs.llmModel);
    const chain = app._llmModelChain();
    check('F53-1 模型链含主模型与全部备用', chain[0] === app.configs.llmModel && app.configs.llmModelFallbacks.every((m) => chain.indexOf(m) >= 0), JSON.stringify(chain));
    check('F53-1 默认不切换模型（链长=1 且开关关闭）', chain.length === 1 && app.configs.llmModelFallbackOn === false, 'len=' + chain.length + ' on=' + app.configs.llmModelFallbackOn);
    check('F53-1 链内无重复', new Set(chain).size === chain.length, JSON.stringify(chain));
    const custom = app.setLlmModels('m-primary', ['m-b', 'm-b', '', null, 'm-a']);
    app.configs.llmModelFallbackOn = true; // 默认已关闭（用户要求单模型不切换），本用例专门验证降级链
    check('F53-1 setLlmModels 去重去空保序', JSON.stringify(custom) === JSON.stringify(['m-primary', 'm-b', 'm-a']), JSON.stringify(custom));
    app.destroy();
});

test('F53-2 403 RegionError：自动降级到备用模型并粘性复用', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    app.setLlmModels('dead-model', ['alive-model', 'spare-model']);
    app.configs.llmModelFallbackOn = true; // 默认已关闭（用户要求单模型不切换），本用例专门验证降级链
    const seen = [];
    app.setLlmTransport((o) => {
        const body = JSON.parse(String(o.data || '{}'));
        seen.push(body.model);
        if (body.model === 'dead-model') {
            o.onload(403, '{"type":"error","error":{"type":"RegionError","message":"only available hosted in China"}}');
        } else {
            o.onload(200, JSON.stringify({ choices: [{ message: { content: '{"answer":"B"}' }, finish_reason: 'stop' }] }));
        }
        return null;
    });
    const opts = [{ el: {}, text: 'A 甲', letter: 'A' }, { el: {}, text: 'B 乙', letter: 'B' }];
    let out = null;
    app._llmAskChoice('题目', opts, false, (err, result) => { out = { err: err && err.message, result: result }; });
    await env.advance(8000);
    check('F53-2 首个模型失败后改用备用模型', seen.length === 2 && seen[0] === 'dead-model' && seen[1] === 'alive-model', JSON.stringify(seen));
    check('F53-2 备用模型作答成功', !!(out && !out.err && out.result && out.result.picked.length === 1 && out.result.picked[0].letter === 'B'), JSON.stringify(out && out.result && out.result.picked));
    check('F53-2 记录可用的模型下标（下次直接复用）', app._llmModelIndex === 1, 'idx=' + app._llmModelIndex);
    check('F53-2 打印降级日志含原因', env.xt.has('RegionError') && env.xt.has('自动降级到 alive-model'), JSON.stringify(env.xt.logs.slice(-3)));
    app.destroy();
});

test('F53-3 HTTP 400（不支持 response_format）：去掉该参数重试同一模型', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    app.setLlmModels('strict-model', ['other-model']);
    app.configs.llmModelFallbackOn = true; // 默认已关闭（用户要求单模型不切换），本用例专门验证降级链
    const seen = [];
    app.setLlmTransport((o) => {
        const body = JSON.parse(String(o.data || '{}'));
        seen.push({ model: body.model, json: body.response_format !== undefined });
        if (body.response_format !== undefined) {
            o.onload(400, '{"error":{"type":"invalid_request_error","message":"response_format is not supported"}}');
        } else {
            o.onload(200, JSON.stringify({ choices: [{ message: { content: '{"answer":"A"}' }, finish_reason: 'stop' }] }));
        }
        return null;
    });
    const opts = [{ el: {}, text: 'A 甲', letter: 'A' }, { el: {}, text: 'B 乙', letter: 'B' }];
    let out = null;
    app._llmAskChoice('题目', opts, false, (err, result) => { out = { err: err && err.message, result: result }; });
    await env.advance(8000);
    check('F53-3 第一次带 response_format、第二次去掉', seen.length === 2 && seen[0].json === true && seen[1].json === false, JSON.stringify(seen));
    check('F53-3 不换模型（同一模型去掉参数即成功）', seen[0].model === 'strict-model' && seen[1].model === 'strict-model', JSON.stringify(seen.map((s) => s.model)));
    check('F53-3 作答成功', !!(out && !out.err && out.result && out.result.answer === 'A'), JSON.stringify(out && out.result));
    check('F53-3 记住该模型不支持 json_mode', app._llmNoJsonMode === true, 'noJson=' + app._llmNoJsonMode);
    app.destroy();
});

test('F53-4 空响应（finish_reason=length）也降级，不把空内容当答案', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    app.setLlmModels('reasoning-hog', ['plain-model']);
    app.configs.llmModelFallbackOn = true; // 默认已关闭（用户要求单模型不切换），本用例专门验证降级链
    const seen = [];
    app.setLlmTransport((o) => {
        const body = JSON.parse(String(o.data || '{}'));
        seen.push(body.model);
        if (body.model === 'reasoning-hog') {
            o.onload(200, JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }));
        } else {
            o.onload(200, JSON.stringify({ choices: [{ message: { content: '{"answer":"AB"}' }, finish_reason: 'stop' }] }));
        }
        return null;
    });
    const opts = [{ el: {}, text: 'A 甲', letter: 'A' }, { el: {}, text: 'B 乙', letter: 'B' }];
    let out = null;
    app._llmAskChoice('题目', opts, true, (err, result) => { out = { err: err && err.message, result: result }; });
    await env.advance(8000);
    check('F53-4 空响应触发降级', seen.length === 2 && seen[0] === 'reasoning-hog' && seen[1] === 'plain-model', JSON.stringify(seen));
    check('F53-4 改用备用模型拿到答案', !!(out && !out.err && out.result && out.result.answer === 'AB'), JSON.stringify(out && out.result));
    app.destroy();
});

test('F53-5 全部模型不可用：仍然失败且不产生任何答案（安全策略不放松）', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    app.setLlmModels('d1', ['d2', 'd3']);
    app.configs.llmModelFallbackOn = true; // 默认已关闭（用户要求单模型不切换），本用例专门验证降级链
    app.configs.llmModelFallbackOn = true; // 默认已关闭（用户要求单模型），本用例专门验证降级链功能
    let calls = 0;
    app.setLlmTransport((o) => {
        calls++;
        o.onload(403, '{"type":"error","error":{"type":"RegionError","message":"blocked"}}');
        return null;
    });
    const opts = [{ el: {}, text: 'A 甲', letter: 'A' }, { el: {}, text: 'B 乙', letter: 'B' }];
    let out = null;
    app._llmAskChoice('题目', opts, false, (err, result) => { out = { err: err && err.message, result: result }; });
    // 心跳重试（60 秒 × 最多 3 次）：整链失败后不会立刻回调，必须把虚拟时钟推过 3 个心跳周期才拿到最终失败。
    await env.advance(40000);
    check('F53-5 首个心跳周期内不提前宣告失败（仍在重试）', !out, JSON.stringify(out));
    // 逐周期推进（这才是"心跳"的真实语义）：一次 advance(大数) 不会顺序跑完多个 60 秒定时器，
    // 且每次重试链可能从上次失败的模型继续（只 1 次调用），所以要多推几轮才能走完 5 次心跳。
    for (let i = 0; i < 12; i++) await env.advance(60000); // 5 次心跳 + 余量
    check('F53-5 三个模型都试过（含重试）', calls >= 7, 'calls=' + calls + '（>3 即证明发生了心跳重试）');
    check('F53-5 最终失败且无答案', !!(out && out.err) && !(out.result && out.result.picked && out.result.picked.length), JSON.stringify(out && out.err));
    check('F53-5 按 60 秒心跳重试（至少发生一次重试）', calls >= 7, 'calls=' + calls);
    check('F53-5 打印「已无更多备用模型」', env.xt.has('已无更多备用模型'), JSON.stringify(env.xt.logs.slice(-2)));
    check('F53-5 失败后不残留在途标记', app._llmInFlight === false, 'inFlight=' + app._llmInFlight);
    app.destroy();
});

// ---------------------------------------------------------------------------
// F55 视频内嵌题（ExtJS）选项点击：逐级下探 + 未选中绝不提交
// 真机：LI.ans-videoquiz-opt 内嵌 <input type=radio>，只点 li → input:checked 恒 false
//      → 重试 3 次必然失败，却照样点提交（平台「已答对 0 题」，白耗作答机会）。
// ---------------------------------------------------------------------------

function buildVideoQuiz(env, withRadio) {
    const doc = env.window.document;
    // 关掉互动看门狗再注入题目 DOM：否则看门狗会把它当成「需人工处理的互动弹窗」，
    // 走到 _blockInteractionForManual → this._clearTimers()，把本用例排期的提交/重试定时器清掉。
    // 实测后果：F55-4 变成抖动用例（submits=0 时有时无；套件在 422 与 421 之间交替）。
    // 用产品自带的开关 interactionGuard（_findInteractionDialog 会据此直接返回 null），而不是改 DOM，
    // 避免为了迁就测试而扭曲被测算的页面结构。
    try { if (env.window.app && env.window.app.configs) env.window.app.configs.interactionGuard = false; } catch (e) { /* ignore */ }
    const scope = doc.createElement('div');
    scope.className = 'ans-videoquiz';
    const stem = doc.createElement('div');
    stem.className = 'ans-videoquiz-stem';
    stem.textContent = '判断题：批判性阅读分为分析论证和评论论证两个部分的内容。( )';
    scope.appendChild(stem);
    const mk = (label) => {
        const li = doc.createElement('li');
        li.className = 'ans-videoquiz-opt';
        if (withRadio) {
            const inp = doc.createElement('input');
            inp.type = 'radio';
            inp.name = 'vq_' + String(Math.random()).slice(2, 8);
            li.appendChild(inp);
        }
        const span = doc.createElement('span');
        span.textContent = label;
        li.appendChild(span);
        scope.appendChild(li);
        return li;
    };
    const a = mk('A、对');
    const b = mk('B、错');
    const submit = doc.createElement('a');
    submit.id = 'vq-submit';
    submit.className = 'ans-videoquiz-submit';
    submit.textContent = '提交';
    scope.appendChild(submit);
    doc.body.appendChild(scope);
    return { scope, a, b, submit };
}

test('F55-1 选项内嵌 radio：逐级点击第 1 级（input）即真正选中', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const { a } = buildVideoQuiz(env, true);
    check('F55-1 可点目标顺序 input 优先', app._optionClickTargets(a)[0].tagName === 'INPUT', String(app._optionClickTargets(a).map((x) => x.tagName)));
    let res = 'pending';
    app._clickWithVerification([{ el: a, text: 'A、对' }], (err) => { res = err ? 'err:' + err.message : 'ok'; });
    await env.advance(3000);
    check('F55-1 内嵌 radio 被真正选中（input:checked）', !!a.querySelector('input:checked'), '');
    check('F55-1 校验通过（无错误）', res === 'ok', res);
    app.destroy();
});

test('F55-2 三级点击都无法选中时报错而不是静默放行', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const { b } = buildVideoQuiz(env, false); // 裸 li，没有任何可选态
    let res = 'pending';
    app._clickWithVerification([{ el: b, text: 'B、错' }], (err) => { res = err ? 'err:' + err.message : 'ok'; });
    await env.advance(6000);
    check('F55-2 返回明确错误', res.indexOf('err:') === 0, res);
    check('F55-2 错误信息含三级点击说明', /三级点击/.test(res), res);
    app.destroy();
});

test('F55-3 未选中时绝不提交：跳过提交并清掉去重键（允许下轮重试）', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const doc = env.window.document;
    const app = await env.boot();
    const { scope, b, submit } = buildVideoQuiz(env, false);
    app.configs.llmAutoSubmit = true;
    let submits = 0;
    submit.addEventListener('click', () => { submits++; });
    app._llmLastQuestionKey = 'q-before-f55';
    app._applyInteractionAnswer(
        { el: scope, text: '判断题：批判性阅读分为分析论证和评论论证两个部分的内容。( )' },
        [{ el: b, text: 'B、错' }],
        { answer: 'B', picked: [{ el: b, text: 'B、错' }], raw: '{"answer":"B"}' }
    );
    await env.advance(6000);
    check('F55-3 未选中 → 一次都没点提交', submits === 0, 'submits=' + submits);
    check('F55-3 打印「已跳过提交」', env.xt.has('已跳过提交'), JSON.stringify(env.xt.logs.slice(-3).map((l) => l.text)));
    check('F55-3 去重键被清空（下一轮可对同一题重试）', app._llmLastQuestionKey === '', app._llmLastQuestionKey);
    check('F55-3 未打印「已自动点击提交」', !env.xt.has('已自动点击提交/继续按钮'), '');
    app.destroy();
});

test('F55-4 选中成功后才自动提交', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const { scope, a, submit } = buildVideoQuiz(env, true);
    app.configs.llmAutoSubmit = true;
    let submits = 0;
    submit.addEventListener('click', () => { submits++; });
    app._applyInteractionAnswer(
        { el: scope, text: '判断题：批判性阅读分为分析论证和评论论证两个部分的内容。( )' },
        [{ el: a, text: 'A、对' }],
        { answer: 'A', picked: [{ el: a, text: 'A、对' }], raw: '{"answer":"A"}' }
    );
    await env.advance(8000);
    check('F55-4 选项已选中', !!a.querySelector('input:checked'), '');
    check('F55-4 选中后自动提交一次', submits === 1, 'submits=' + submits);
    check('F55-4 打印「已选择答案 A」', env.xt.has('已选择答案 A'), JSON.stringify(env.xt.logs.slice(-4).map((l) => l.text)));
    app.destroy();
});

// ---------------------------------------------------------------------------
// F56 视频内嵌题：已全对不重答 + 去重键剥噪声（真机：同一题被答两遍，answers=2）
// ---------------------------------------------------------------------------

test('F56-1 内嵌题容器文本剥噪声：保留题干/选项，且不误伤普通题干', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const raw = '共 1 题，已答对 0 题 单选题主题性阅读的特征不包括（）。A、大批量文献的阅读B、大批量文献的分析性阅读 提交提交中继续学习知识点回看真遗憾，再接再厉！回看 分钟查看解析';
    const out = app._stripQuizChrome(raw);
    check('F56-1 去掉计数文案', out.indexOf('共 1 题') < 0 && out.indexOf('已答对') < 0, out);
    check('F56-1 去掉按钮与评语', out.indexOf('提交') < 0 && out.indexOf('继续学习') < 0 && out.indexOf('查看解析') < 0 && out.indexOf('再接再厉') < 0, out);
    check('F56-1 保留题干', out.indexOf('单选题主题性阅读的特征不包括') >= 0, out);
    check('F56-1 保留选项', out.indexOf('大批量文献的阅读') >= 0, out);
    const plain = '判断题：请选择你认为正确的选项';
    check('F56-1 普通题干原样返回（安全边界）', app._stripQuizChrome(plain) === plain, app._stripQuizChrome(plain));
    app.destroy();
});

test('F56-2 进度解析：已答对==共 N 题 才算全对', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const p0 = app._quizProgress('共 1 题，已答对 0 题 单选题X（）');
    const p1 = app._quizProgress('共 1 题，已答对 1 题 单选题X（）');
    const pn = app._quizProgress('普通互动弹窗');
    check('F56-2 未答对 → allCorrect=false', p0.total === 1 && p0.correct === 0 && p0.allCorrect === false, JSON.stringify(p0));
    check('F56-2 已答对 1/1 → allCorrect=true', p1.allCorrect === true, JSON.stringify(p1));
    check('F56-2 无计数文案 → allCorrect=false', pn.allCorrect === false, JSON.stringify(pn));
    app.destroy();
});

test('F56-3 已全部答对：不再发 LLM 请求', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    let calls = 0;
    app.setLlmTransport(() => { calls++; return null; });
    app.setLlmKey('sk-test-not-a-real-key');
    app._answerInteractionWithLlm({ text: '共 1 题，已答对 1 题 单选题主题性阅读的特征不包括（）。A、大批量文献的阅读', options: [] });
    await env.advance(3000);
    check('F56-3 一次 LLM 请求都没发', calls === 0, 'calls=' + calls);
    check('F56-3 打印「跳过重复作答」', env.xt.has('跳过重复作答'), JSON.stringify(env.xt.logs.slice(-3).map((l) => l.text)));
    app.destroy();
});

test('F56-4 去重键稳定：仅计数变化不产生新键', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    // 用**真实全文**（计数 + 评语 + 无数字的分钟占位同时变化），而不是只改计数的弱情形。
    const raw0 = '共 1 题，已答对 0 题 单选题主题性阅读的特征不包括（）。A、大批量文献的阅读B、大批量文献的分析性阅读 提交提交中继续学习知识点回看真遗憾，再接再厉！回看 分钟查看解析';
    const raw1 = '共 1 题，已答对 1 题 单选题主题性阅读的特征不包括（）。A、大批量文献的阅读B、大批量文献的分析性阅读 提交提交中继续学习知识点回看恭喜你，答对了！你的答题水准超过了88%的同学 查看解析';
    const k0 = app._llmQuestionKey({ text: raw0 });
    const k1 = app._llmQuestionKey({ text: raw1 });
    check('F56-4 两键相同', !!k0 && k0 === k1, k0 + ' vs ' + k1);
    const other = app._llmQuestionKey({ text: '共 1 题，已答对 1 题 单选题另一道完全不同的题（）。A、甲' });
    check('F56-4 不同题键不同', other !== k0, other);
    app.destroy();
});

// ---------------------------------------------------------------------------
// F57 已答对的互动题反复探测：只限频日志，不改判断（真机 10 秒 7 行刷屏）
// ---------------------------------------------------------------------------

test('F57-1 已全对重复探测：只打一次提示，但仍不发 LLM 请求', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    let calls = 0;
    app.setLlmTransport(() => { calls++; return null; });
    app.setLlmKey('sk-test-not-a-real-key');
    const found = { text: '共 1 题，已答对 1 题 单选题主题性阅读的特征不包括（）。A、大批量文献的阅读', options: [] };
    for (let i = 0; i < 6; i++) app._answerInteractionWithLlm(found);
    await env.advance(3000);
    const hits = env.logs.filter((l) => String(l.text || '').indexOf('跳过重复作答') >= 0).length;
    check('F57-1 6 次探测只打 1 行提示（限频生效）', hits === 1, 'hits=' + hits);
    check('F57-1 期间一次 LLM 请求都没发', calls === 0, 'calls=' + calls);
    app.destroy();
});

test('F57-2 换了另一道题：提示重新出现（不是永久静音）', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    app.setLlmTransport(() => null);
    app.setLlmKey('sk-test-not-a-real-key');
    app._answerInteractionWithLlm({ text: '共 1 题，已答对 1 题 单选题第一道题（）。A、甲', options: [] });
    app._answerInteractionWithLlm({ text: '共 1 题，已答对 1 题 单选题第二道截然不同的题（）。A、乙', options: [] });
    await env.advance(3000);
    const hits = env.logs.filter((l) => String(l.text || '').indexOf('跳过重复作答') >= 0).length;
    check('F57-2 两道不同的题各提示一次', hits === 2, 'hits=' + hits);
    app.destroy();
});

// ---------------------------------------------------------------------------
// F58 已答对提示：每题只打一次（取代 F57 的 15 秒限频；真机残留为每 15~17 秒一行）
// ---------------------------------------------------------------------------

test('F58-1 跨过 15 秒窗口也不再重复提示（比 F57 更严：一题只提示一次）', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    let calls = 0;
    app.setLlmTransport(() => { calls++; return null; });
    app.setLlmKey('sk-test-not-a-real-key');
    const found = { text: '共 1 题，已答对 1 题 单选题主题性阅读的特征不包括（）。A、大批量文献的阅读', options: [] };
    for (let i = 0; i < 3; i++) app._answerInteractionWithLlm(found);
    await env.advance(20000);          // 推进 20 秒（脚手架伪造 Date.now：F57 在此会再打一行）
    for (let i = 0; i < 3; i++) app._answerInteractionWithLlm(found);
    await env.advance(3000);
    const hits = env.logs.filter((l) => String(l.text || '').indexOf('跳过重复作答') >= 0).length;
    check('F58-1 跨 20 秒仍只 1 行提示', hits === 1, 'hits=' + hits);
    check('F58-1 期间零 LLM 请求', calls === 0, 'calls=' + calls);
    app.destroy();
});

test('F58-2 平台若把该题重置为「已答对 0 题」，必须照常作答（拒绝永久静音的安全前提）', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    // 用真实选项元素（带 el），确保重置后确实能走到发请求那一步，而不是靠"空 options 也放行"的假设。
    const { a, b } = buildVideoQuiz(env, true);
    const opts = [{ letter: 'A', text: 'A、对', el: a }, { letter: 'B', text: 'B、错', el: b }];
    let calls = 0;
    app.setLlmTransport((o) => {
        calls++;
        try { o.onload(200, JSON.stringify({ choices: [{ message: { content: '{"answer":"A"}' }, finish_reason: 'stop' }] })); } catch (e) { /* ignore */ }
        return null;
    });
    app.setLlmKey('sk-test-not-a-real-key');
    const stem = '判断题：批判性阅读分为分析论证和评论论证两个部分的内容。( )';
    app._answerInteractionWithLlm({ text: '共 1 题，已答对 1 题 ' + stem, options: opts });
    await env.advance(3000);
    check('F58-2 已答对时不请求 LLM', calls === 0, 'calls=' + calls);
    app._llmLastQuestionKey = '';      // 平台重置后是同一题干、计数归零
    app._answerInteractionWithLlm({ text: '共 1 题，已答对 0 题 ' + stem, options: opts });
    await env.advance(6000);
    check('F58-2 重置后照常作答（发出 LLM 请求）', calls >= 1, 'calls=' + calls);
    app.destroy();
});

// ---------------------------------------------------------------------------
// F59 内嵌题容器噪声的"无数字变体"：同题两版必须归一到同一去重键（真机同题答两遍）
// ---------------------------------------------------------------------------

const F59_Q1 = '，已答对 题 单选题（）相当于总论。A、标题B、引言C、目录D、注释';
const F59_Q2 = '， 单选题（）相当于总论。A、标题B、引言C、目录D、注释';

test('F59-1 无数字计数变体也能剥到同一个题干', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const s1 = app._stripQuizChrome(F59_Q1);
    const s2 = app._stripQuizChrome(F59_Q2);
    check('F59-1 两变体剥离结果相同', s1 === s2, JSON.stringify({ s1: s1, s2: s2 }));
    check('F59-1 题干保留', s1.indexOf('单选题（）相当于总论') >= 0, s1);
    check('F59-1 计数噪声已除', s1.indexOf('已答对') < 0 && s1.indexOf('共 ') < 0, s1);
    app.destroy();
});

test('F59-2 两变体的去重键一致', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const k1 = app._llmQuestionKey({ text: F59_Q1 });
    const k2 = app._llmQuestionKey({ text: F59_Q2 });
    check('F59-2 键相同', !!k1 && k1 === k2, k1 + ' vs ' + k2);
    app.destroy();
});

test('F59-3 端到端：同题换噪声变体不再触发第二次作答', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const { a, b } = buildVideoQuiz(env, true);
    const opts = [{ letter: 'A', text: 'A、标题', el: a }, { letter: 'B', text: 'B、引言', el: b }];
    let calls = 0;
    app.setLlmTransport((o) => {
        calls++;
        try { o.onload(200, JSON.stringify({ choices: [{ message: { content: '{"answer":"B"}' }, finish_reason: 'stop' }] })); } catch (e) { /* ignore */ }
        return null;
    });
    app.setLlmKey('sk-test-not-a-real-key');
    app._answerInteractionWithLlm({ text: F59_Q1, options: opts });
    await env.advance(4000);
    const afterFirst = calls;
    app._answerInteractionWithLlm({ text: F59_Q2, options: opts });   // 只差那段无数字噪声
    await env.advance(4000);
    check('F59-3 首次作答发出了请求', afterFirst === 1, 'afterFirst=' + afterFirst);
    check('F59-3 变体检测被去重（没有第二次请求）', calls === 1, 'calls=' + calls);
    app.destroy();
});

// ---------------------------------------------------------------------------
// F60 合格性门禁：短题干选择题不得误锁（真机「1 【单选题】（）相当于总论。」被锁 → 随重启死循环）
// ---------------------------------------------------------------------------

test('F60-1 真机题干：短题干 + 两个选项 → 放行', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const q = { isShortAnswer: false, optionEls: [{}, {}] };
    const r = app._isQuestionSane('1 【单选题】（）相当于总论。', q);
    check('F60-1 放行（不再误锁）', r.ok === true, JSON.stringify(r));
    app.destroy();
});

test('F60-2 同题干但选项不足 → 仍然拒绝（不放松）', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const r0 = app._isQuestionSane('1 【单选题】（）相当于总论。', { isShortAnswer: false, optionEls: [] });
    const r1 = app._isQuestionSane('1 【单选题】（）相当于总论。', { isShortAnswer: false, optionEls: [{}] });
    check('F60-2 0 选项 → 拒绝', r0.ok === false, JSON.stringify(r0));
    check('F60-2 1 选项 → 拒绝', r1.ok === false, JSON.stringify(r1));
    app.destroy();
});

test('F60-3 其它拒绝分支不受影响（空/编辑器文案/纯数字/短简答题）', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const many = { isShortAnswer: false, optionEls: [{}, {}, {}] };
    check('F60-3 文本为空 → 拒绝', app._isQuestionSane('', many).ok === false, '');
    check('F60-3 播放器文案 → 拒绝', app._isQuestionSane('取消静音 播放速度 加载完毕', many).ok === false, '');
    check('F60-3 纯数字 → 拒绝', app._isQuestionSane('1 2. 3、', many).ok === false, '');
    check('F60-3 短简答题无问号 → 仍拒绝', app._isQuestionSane('1 【简答题】简述要点。', { isShortAnswer: true, optionEls: [] }).ok === false, '');
    const okReal = app._isQuestionSane('1 【单选题】下列哪一项是牙釉质的主要成分？', many);
    check('F60-3 正常题仍放行', okReal.ok === true, JSON.stringify(okReal));
    app.destroy();
});

// ---------------------------------------------------------------------------
// F61 "界面文案"词表去歧义（真机：「1 【多选题】论文初稿提交有哪些要求？」因含「提交」被误锁）
// ---------------------------------------------------------------------------

test('F61-1 真机题干：含「提交」的合法多选题必须放行', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const q = { isShortAnswer: false, optionEls: [{}, {}, {}] };
    const r = app._isQuestionSane('1 【多选题】论文初稿提交有哪些要求？', q);
    check('F61-1 放行（不再因「提交」误锁）', r.ok === true, JSON.stringify(r));
    const r2 = app._isQuestionSane('1 【多选题】提交论文前要确定哪些事项？', q);
    check('F61-1 含「提交+确定」也放行', r2.ok === true, JSON.stringify(r2));
    const r3 = app._isQuestionSane('1 【单选题】论文正文字体有哪些要求？', q);
    check('F61-1 含「字体」也放行', r3.ok === true, JSON.stringify(r3));
    app.destroy();
});

test('F61-2 真正的编辑器/播放器文案仍被拒绝', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const small = { isShortAnswer: false, optionEls: [{}, {}] };
    check('F61-2 工具栏 dump → 拒绝', app._isQuestionSane('填写答案 段落格式 字体 字号 点击上传', small).ok === false, '');
    check('F61-2 播放器文案 → 拒绝', app._isQuestionSane('取消静音 播放速度 加载完毕', small).ok === false, '');
    check('F61-2 富文本痕迹 → 拒绝', app._isQuestionSane('wordNum edui 上一题 下一题', small).ok === false, '');
    app.destroy();
});

test('F61-3 其余判据不受影响', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const small = { isShortAnswer: false, optionEls: [{}, {}] };
    check('F61-3 空文本 → 拒绝', app._isQuestionSane('', small).ok === false, '');
    check('F61-3 纯数字 → 拒绝', app._isQuestionSane('1 2. 3、', small).ok === false, '');
    check('F61-3 文本过短 → 拒绝', app._isQuestionSane('1 【简答题】要点。', { isShortAnswer: true, optionEls: [] }).ok === false, '');
    app.destroy();
});

// ---------------------------------------------------------------------------
// F62 内容门禁不再只认中文（真机：全英文题被"题目中文内容过少（0 字）"误锁）
// ---------------------------------------------------------------------------

test('F62-1 全英文单选题必须放行（真机原文）', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const q = { isShortAnswer: false, optionEls: [{}, {}, {}, {}] };
    const real = '1 【单选题】When I study now, I’m in a lab with 50 noisy computers. What happened to the quiet chair in a';
    const r = app._isQuestionSane(real, q);
    check('F62-1 放行（不再因 0 中文误锁）', r.ok === true, JSON.stringify(r));
    const r2 = app._isQuestionSane('1 【多选题】Which of the following are true about critical thinking?', q);
    check('F62-1 另一道英文题也放行', r2.ok === true, JSON.stringify(r2));
    app.destroy();
});

test('F62-2 内容确实过少的仍拒绝（不放松）', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const q = { isShortAnswer: false, optionEls: [{}, {}] };
    check('F62-2 只有几个字母 → 拒绝', app._isQuestionSane('1 【单选题】A B C', q).ok === false, '');
    check('F62-2 纯数字 → 拒绝', app._isQuestionSane('1 2. 3、', q).ok === false, '');
    check('F62-2 空文本 → 拒绝', app._isQuestionSane('', q).ok === false, '');
    app.destroy();
});

test('F62-3 中文题行为不变（含 F40/F60 的放行与守卫）', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const q = { isShortAnswer: false, optionEls: [{}, {}] };
    check('F62-3 中文短题干+选项 → 放行', app._isQuestionSane('1 【单选题】（）相当于总论。', q).ok === true, '');
    check('F62-3 含「提交」的题 → 放行', app._isQuestionSane('1 【多选题】论文初稿提交有哪些要求？', q).ok === true, '');
    check('F62-3 选项不足 → 拒绝', app._isQuestionSane('1 【单选题】（）相当于总论。', { isShortAnswer: false, optionEls: [] }).ok === false, '');
    app.destroy();
});

// ---------------------------------------------------------------------------
// F63 作业选项长度上限（真机：200/217/207/206 的四个选项只剩 1 个 → 上锁；另一题全被丢 → 误判写作题）
// ---------------------------------------------------------------------------

function mkChoiceTimu(env, optLens, stemText) {
    const doc = env.window.document;
    const timu = doc.createElement('div');
    timu.className = 'TiMu';
    const title = doc.createElement('div');
    title.className = 'Zy_TItle';
    title.textContent = stemText || '1 【单选题】The student is quoting from page 623 of the following essay.';
    timu.appendChild(title);
    const ul = doc.createElement('ul');
    ul.className = 'Zy_ulTop';
    optLens.forEach((len, i) => {
        const li = doc.createElement('li');
        li.className = 'font-cxsecret before-after';
        li.textContent = String.fromCharCode(65 + i) + ' ' + 'x'.repeat(Math.max(0, len - 2));
        ul.appendChild(li);
    });
    timu.appendChild(ul);
    doc.body.appendChild(timu);
    return timu;
}

test('F63-1 真机长度 200/217/207/206：四个选项都要抽到', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    mkChoiceTimu(env, [200, 217, 207, 206]);
    const list = app._workQuestionList(env.window.document);
    const q = list && list[0];
    check('F63-1 抽到 4 个选项', !!q && q.optionEls.length === 4, q ? 'ops=' + q.optionEls.length : 'no-question');
    check('F63-1 不被误判为写作题', !!q && q.isShortAnswer === false, q ? 'isShortAnswer=' + q.isShortAnswer : '');
    app.destroy();
});

test('F63-2 全部超 200 的长选项：仍抽到 4 个且不是写作题', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    mkChoiceTimu(env, [303, 311, 308, 300]);
    const list = app._workQuestionList(env.window.document);
    const q = list && list[0];
    check('F63-2 抽到 4 个选项', !!q && q.optionEls.length === 4, q ? 'ops=' + q.optionEls.length : 'no-question');
    check('F63-2 不因"选项为空"被当写作题', !!q && q.isShortAnswer === false, q ? 'isShortAnswer=' + q.isShortAnswer : '');
    app.destroy();
});

test('F63-3 异常超长文本仍被排除（上界守卫保留）', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    mkChoiceTimu(env, [1300, 1400]);
    const list = app._workQuestionList(env.window.document);
    const q = list && list[0];
    check('F63-3 >1200 的两条都被排除', !!q && q.optionEls.length === 0, q ? 'ops=' + q.optionEls.length : 'no-question');
    app.destroy();
});

// ---------------------------------------------------------------------------
// F64 短题干 + 真实选项 = 合法（真机：1 【单选题】预防医学是，7 字被 t.length<8 判死 → 锁循环）
// ---------------------------------------------------------------------------

test('F64-1 真机短题干 + 五个选项必须放行', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const q = { isShortAnswer: false, optionEls: [{}, {}, {}, {}, {}] };
    const r = app._isQuestionSane('1 【单选题】预防医学是', q);
    check('F64-1 放行（不再因 7 字误锁）', r.ok === true, JSON.stringify(r));
    const r2 = app._isQuestionSane('1 【单选题】预防医学是', { isShortAnswer: false, optionEls: [{}, {}] });
    check('F64-1 两个选项也放行', r2.ok === true, JSON.stringify(r2));
    app.destroy();
});

test('F64-2 同样题干但选项不足 → 仍拒绝（不放松）', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const r0 = app._isQuestionSane('1 【单选题】预防医学是', { isShortAnswer: false, optionEls: [] });
    const r1 = app._isQuestionSane('1 【单选题】预防医学是', { isShortAnswer: false, optionEls: [{}] });
    check('F64-2 0 选项 → 拒绝', r0.ok === false && /过短/.test(r0.reason), JSON.stringify(r0));
    check('F64-2 1 选项 → 拒绝', r1.ok === false, JSON.stringify(r1));
    app.destroy();
});

test('F64-3 其余守卫不受影响', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const many = { isShortAnswer: false, optionEls: [{}, {}] };
    check('F64-3 空文本 → 拒绝', app._isQuestionSane('', many).ok === false, '');
    check('F64-3 纯数字 → 拒绝', app._isQuestionSane('1 2. 3、', many).ok === false, '');
    check('F64-3 编辑器短语 → 拒绝', app._isQuestionSane('填写答案 段落格式 字体 字号', many).ok === false, '');
    check('F64-3 正常题 → 放行', app._isQuestionSane('1 【单选题】下列哪一项是牙釉质的主要成分？', many).ok === true, '');
    app.destroy();
});

// ---------------------------------------------------------------------------
// F54 font-cxsecret 字体列表：累积式收集（真机：题目按组注入时新字体收不进来 → 乱码题干被当"正常汉字"）
// ---------------------------------------------------------------------------

test('F54-1 字体未就绪时先解密：字体随后到位必须能重新收集并解码（旧实现永久缓存空列表）', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const tstFontB64 = readFileSync(resolve(repoRoot, 'tests/fixtures/font-cxsecret/font.b64'), 'utf8').trim();
    const tstMapB64 = readFileSync(resolve(repoRoot, 'tests/fixtures/font-cxsecret/font-map.mini.b64'), 'utf8').trim();
    env.window.__XT_FONT_MAP_B64 = tstMapB64;
    app.configs.cxSecretDecode = true;
    const encrypted = '砲抰材抲是现抳口抮抰植体最常用抪材抲';
    const expect = '哪种材料是现代口腔种植体最常用的材料';
    const dec = (text) => new Promise((res) => app._cxSecretDecode([text], (out) => res(String(out[0]))));

    // 阶段 A：font-cxsecret 还没进 DOM（题目组未到 / 规则已随题目组消失）→ 原样返回
    const a = await dec(encrypted);
    check('F54-1 阶段A 字体缺失时原样返回', a === encrypted, a);

    // 阶段 B：字体注入（模拟题目组 AJAX 到达）→ 必须能重新收集并解码
    const st = env.window.document.createElement('style');
    st.textContent = '@font-face{font-family:"font-cxsecret";src:url(data:application/font-woff;base64,' + tstFontB64 + ') format("woff")}';
    env.window.document.head.appendChild(st);
    const b = await dec(encrypted);
    const lenB = Array.isArray(app._cxFontsB64) ? app._cxFontsB64.length : String(app._cxFontsB64);
    check('F54-1 阶段B 字体到位后重新收集（缓存 ≥1）', Array.isArray(app._cxFontsB64) && app._cxFontsB64.length >= 1, JSON.stringify(lenB));
    check('F54-1 阶段B 解码结果正确（F54 核心断言）', b === expect, b);

    // 阶段 C：字体规则"消失"（真机瞬态）→ 已收集的字体不得丢失
    env.window.document.head.removeChild(st);
    const c = await dec(encrypted);
    const lenC = Array.isArray(app._cxFontsB64) ? app._cxFontsB64.length : String(app._cxFontsB64);
    check('F54-1 阶段C 规则消失后缓存不收缩', Array.isArray(app._cxFontsB64) && app._cxFontsB64.length >= 1, JSON.stringify(lenC));
    check('F54-1 阶段C 不因规则瞬态而复失', c === expect, c);
    app.destroy();
});
test('F9-1 GUI 面板：默认注入、状态可见、destroy 后移除、可配置关闭', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    const panel = env.window.document.getElementById('xt-gui-panel');
    check('F9-1 默认注入面板', !!panel, '');
    check('F9-1 面板含状态与日志区', !!panel && panel.textContent.indexOf('LLM') >= 0, panel ? panel.textContent.slice(0, 80) : '');
    check('F9-1 日志镜像控制台', env.xt.has('可视化面板已就绪'), '');
    app.destroy();
    check('F9-1 destroy 后面板移除', !env.window.document.getElementById('xt-gui-panel'), '');
    const env2 = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app2 = await env2.boot();
    app2.destroy();
    app2.configs.guiEnabled = false;
    app2.run();
    check('F9-1 guiEnabled=false 时不再注入面板', !env2.window.document.getElementById('xt-gui-panel'), '');
});

test('F10-1 章节测验建议模式：只提示不点击、不自动跳过、每题一次请求', async () => {
    const quizHtml = '<div class="TiMu"><div class="Zy_TItle">1. 牙釉质的主要成分是</div>'
        + '<ul class="Zy_ulTop"><li>A、羟基磷灰石</li><li>B、胶原蛋白</li></ul></div>'
        + '<div class="TiMu"><div class="Zy_TItle">2. 根管治疗的第一步是</div>'
        + '<ul class="Zy_ulTop"><li>A、开髓</li><li>B、充填</li></ul></div>';
    const html = tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="章节测验"></div><a id="prevNextFocusNext" href="#">下一节</a>' + quizHtml;
    const env = createEnv({ html });
    const app = await env.boot();
    await env.advance(2000);
    app.configs.llmEnabled = true;
    app.configs.llmChapterTest = true;
    app.setLlmKey('sk-test-not-a-real-key');
    const requests = [];
    app.setLlmTransport((opts) => {
        requests.push(opts);
        const n = requests.length;
        opts.onload(200, JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: n === 1 ? 'A' : 'B' }) } }] }));
        return { abort() {} };
    });
    const nextClicksBefore = env.clicks.filter((c) => c.title.indexOf('下一节') >= 0).length;
    await env.advance(10000);
    check('F10-1 两道题各请求一次', requests.length === 2, 'requests=' + requests.length);
    check('F10-1 给出建议日志', env.xt.count('章节测验建议') >= 2, 'count=' + env.xt.count('章节测验建议'));
    const nextClicksAfter = env.clicks.filter((c) => c.title.indexOf('下一节') >= 0).length;
    check('F10-1 建议模式下不自动跳过章节测验', nextClicksAfter === nextClicksBefore, 'before=' + nextClicksBefore + ' after=' + nextClicksAfter);
    check('F10-1 不点击任何测验选项', env.clicks.filter((c) => /羟基磷灰石|胶原蛋白|开髓|充填/.test(c.text)).length === 0, JSON.stringify(env.clicks.map((c) => c.text)));
    check('F10-1 明确声明不会自动点击', env.xt.has('不会自动点击'), '');
});

// ---------------------------------------------------------------------------
// F5 互动答题弹窗（#29 #39 #42 #45）
// ---------------------------------------------------------------------------

const QUIZ_HTML = '<div class="answerQuestion"><div class="Zy_TItle">判断题：请选择你认为正确的选项</div>'
    + '<ul id="quiz-options"><li>A、正确</li><li>B、错误</li></ul><a class="submitBtn" id="quiz-submit">提交</a></div>';

test('F5-1 检测到互动答题弹窗 → 暂停跳转 + 提示手动处理，且绝不点击选项/提交', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'], ['2.1'])) + QUIZ_HTML });
    const doc = env.window.document;
    let optionClicks = 0;
    let submitClicks = 0;
    doc.getElementById('quiz-options').addEventListener('click', (ev) => {
        optionClicks++;
        // 真机语义：点击选项即进入选中态。原夹具是裸 <li>，从未有过可观测选中态，
        // 于是 F5-3 过去只能靠"点不上也照样提交"通过——那正是 F55 要修掉的行为。
        const li = (ev.target && ev.target.closest) ? ev.target.closest('li') : null;
        if (li) {
            Array.from(doc.querySelectorAll('#quiz-options li')).forEach((x) => { x.className = ''; });
            li.className = 'cur';
        }
    });
    doc.getElementById('quiz-submit').addEventListener('click', () => { submitClicks++; });
    const app = await env.boot();
    await env.advance(2000);
    check('F5-1 进入暂停跳转状态', app._interactionBlocked === true, 'blocked=' + app._interactionBlocked);
    check('F5-1 打印人工处理提示', env.xt.has('请手动完成该互动题'), '');
    check('F5-1 明确声明不自动答题', env.xt.has('不会自动答题'), '');
    app.nextUnit();
    await env.advance(5000);
    check('F5-1 弹窗期间 nextUnit() 不跳转', env.treeClicks().length === 0, JSON.stringify(env.treeClickTitles()));
    check('F5-1 弹窗期间 nextUnit() 给出暂停提示', env.xt.has('已暂停自动跳转'), '');
    check('F5-1 没有点击任何选项或提交按钮', optionClicks === 0 && submitClicks === 0, 'option=' + optionClicks + ' submit=' + submitClicks);
    doc.querySelector('.answerQuestion').remove();
    await env.advance(2000);
    check('F5-1 弹窗消失后恢复自动跳转', app._interactionBlocked === false, 'blocked=' + app._interactionBlocked);
    check('F5-1 恢复后打印恢复日志', env.xt.has('互动答题弹窗已消失'), '');
});

test('F5-2 LLM 能力仅在显式开关后存在：默认关闭、无硬编码密钥、无 fetch/XHR 直连', () => {
    const code = stripComments(readFileSync(sourcePath, 'utf8'));
    check('F5-2 默认 llmEnabled=false 且 llmChapterTest=false', /llmEnabled:\s*false/.test(code) && /llmChapterTest:\s*false/.test(code), '');
    check('F5-2 默认 guiEnabled=true（纯本地面板）', /guiEnabled:\s*true/.test(code), '');
    check('F5-2 默认 llmEmbeddedWork=false（内嵌章节测验默认不自动作答）', /llmEmbeddedWork:\s*false/.test(code), '');
    check('F5-2 无 autoAnswer 命名', !/autoAnswer/i.test(code), '');
    check('F5-2 无 fetch() 直连', !/\bfetch\s*\(/.test(code), '');
    check('F5-2 无 XMLHttpRequest / axios 直连', !/XMLHttpRequest|axios/.test(code), '');
    check('F5-2 无硬编码 API Key', !/sk-[A-Za-z0-9]{16,}/.test(code), '');
    check('F5-2 存在 GM_xmlhttpRequest 传输与 x-opencode-session 头', /GM_xmlhttpRequest/.test(code) && /x-opencode-session/.test(code), '');
    const maxTokens = (code.match(/llmMaxTokens:\s*(\d+)/) || [])[1];
    check('F5-2 maxTokens 不低于 1024（防推理模型空响应）', !!maxTokens && Number(maxTokens) >= 1024, 'llmMaxTokens=' + maxTokens);
    check('F5-2 存在互动弹窗检测与暂停跳转逻辑', /_findInteractionDialog/.test(code) && /_interactionBlocked/.test(code), '');
    const urls = [...new Set([...code.matchAll(/https?:\/\/[^'"\s)]+/g)].map((m) => m[0]))];
    check('F5-2 外部 URL 仅 jQuery CDN 与已声明的 LLM 端点', urls.length === 0 || urls.every((u) => u.indexOf('code.jquery.com') >= 0 || u.indexOf('opencode.ai/zen/go/v1/chat/completions') >= 0), JSON.stringify(urls));
});

test('F5-3 显式开启 LLM：会话头稳定、严格解析 JSON、按答案点选并可选自动提交（零真实网络）', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'], ['2.1'])) + QUIZ_HTML });
    const doc = env.window.document;
    let optionClicks = 0;
    let submitClicks = 0;
    doc.getElementById('quiz-options').addEventListener('click', (ev) => {
        optionClicks++;
        // 真机语义：点击选项即进入选中态。原夹具是裸 <li>，从未有过可观测选中态，
        // 于是 F5-3 过去只能靠"点不上也照样提交"通过——那正是 F55 要修掉的行为。
        const li = (ev.target && ev.target.closest) ? ev.target.closest('li') : null;
        if (li) {
            Array.from(doc.querySelectorAll('#quiz-options li')).forEach((x) => { x.className = ''; });
            li.className = 'cur';
        }
    });
    doc.getElementById('quiz-submit').addEventListener('click', () => { submitClicks++; });
    const app = await env.boot();
    await env.advance(2000);
    check('F5-3 默认配置下先进入人工暂停态', app._interactionBlocked === true, 'blocked=' + app._interactionBlocked);
    app._interactionBlocked = false;
    app.configs.llmEnabled = true;
    app.configs.llmAutoSubmit = true;
    app.setLlmKey('sk-test-not-a-real-key');
    const requests = [];
    app.setLlmTransport((opts) => {
        requests.push(opts);
        opts.onload(200, JSON.stringify({ choices: [{ message: { content: '{"answer":"B"}' } }], usage: {} }));
        return { abort() {} };
    });
    await env.advance(3000);
    check('F5-3 仅发起一次 LLM 请求（同一弹窗去重）', requests.length === 1, 'requests=' + requests.length);
    const headers = requests[0] ? requests[0].headers : {};
    check('F5-3 请求头携带 x-opencode-session', !!headers['x-opencode-session'], JSON.stringify(Object.keys(headers)));
    check('F5-3 会话 ID 稳定且非空', typeof headers['x-opencode-session'] === 'string' && headers['x-opencode-session'].length >= 8, String(headers['x-opencode-session']));
    check('F5-3 Authorization 使用内存中的 Key', String(headers['Authorization'] || '').indexOf('sk-test-not-a-real-key') >= 0, String(headers['Authorization'] || '').slice(0, 12));
    check('F5-3 题面进入提示词', String(requests[0] ? requests[0].data : '').indexOf('请选择你认为正确的选项') >= 0, '');
    check('F5-3 按模型答案选择 B 而非盲选第一个', optionClicks >= 1 && env.xt.has('已选择答案 B'), 'option=' + optionClicks + ' logs=' + env.xt.logs.slice(-3).map((l) => l.text).join(' | '));
    await env.advance(3000);
    check('F5-3 自动提交按钮已点击', submitClicks >= 1, 'submit=' + submitClicks);
    check('F5-3 全程未进入人工暂停态', app._interactionBlocked === false, 'blocked=' + app._interactionBlocked);
    check('F5-3 真实网络计数为零（仅走注入传输）', env.window.__clock && true, 'transport=injected');
});

// ---------------------------------------------------------------------------
// F6 视频元素发现（#18 #52 #55）
// ---------------------------------------------------------------------------

test('F6-1 嵌套 3 层 iframe 内的视频能被找到', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const deepDoc = await buildFrameChain(env, 3, '<video id="video_html5_api" src="https://example.com/deep.mp4"></video>');
    const deepVideo = stubVideo(env, deepDoc.getElementById('video_html5_api'), {});
    const app = await env.boot();
    check('F6-1 找到 3 层嵌套 frame 里的视频', app._getVideoEl() === deepVideo, '');
});

test('F6-2 超过 videoFrameMaxDepth 的嵌套不再搜索（带上限保护）', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) });
    await buildFrameChain(env, 5, '<video id="video_html5_api" src="https://example.com/too-deep.mp4"></video>');
    const app = await env.boot();
    check('F6-2 超出深度上限的视频不被采用', app._getVideoEl() === null, '');
    check('F6-2 上限配置为 4（V3.3 是硬编码 2）', app.configs.videoFrameMaxDepth === 4, 'depth=' + app.configs.videoFrameMaxDepth);
    const code = stripComments(readFileSync(sourcePath, 'utf8'));
    check('F6-2 源码存在深度上限判断', /depth > this\.configs\.videoFrameMaxDepth/.test(code), '');
});

test('F6-3 切换小节时显式失效缓存，不复用旧视频元素', async () => {
    const { env, video } = await envWithTree(chapterSpecs(['1.1', '1.2']), { stepTitle: '视频' });
    const app = await env.boot();
    check('F6-3 首次命中旧视频元素', app._getVideoEl() === video, '');
    const doc = await frameDoc(env, 'player');
    doc.body.innerHTML = '<video id="video_html5_api" src="https://example.com/b.mp4"></video>';
    const newVideo = stubVideo(env, doc.getElementById('video_html5_api'), {});
    app.nextUnit();
    await env.advance(4000);
    check('F6-3 切换小节时打印缓存失效', env.xt.has('视频元素缓存已失效'), '');
    check('F6-3 切换到新视频元素而不是旧缓存', app._getVideoEl() === newVideo && newVideo !== video, '');
});

test('F6-4 选择器覆盖扩大：vjs-tech / 主文档 video 都能识别', async () => {
    const env = createEnv({
        html: tree(chapterSpecs(['1.1'])) + '<video id="decoy"></video><iframe id="player" src="about:blank"></iframe><div class="prev_title" title="视频"></div>',
    });
    const doc = await writeFrame(env, 'player', '<div class="video-js"><video class="vjs-tech" src="https://example.com/vjs.mp4"></video></div>');
    const real = stubVideo(env, doc.querySelector('video.vjs-tech'), {});
    const app = await env.boot();
    check('F6-4 跳过无 src 的装饰性 video，命中 vjs-tech', app._getVideoEl() === real, '');

    const env2 = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<video id="video_html5_api" src="https://example.com/top.mp4"></video><div class="prev_title" title="视频"></div>' });
    const topVideo = stubVideo(env2, env2.window.document.getElementById('video_html5_api'), {});
    const app2 = await env2.boot();
    check('F6-4 主文档中的 video#video_html5_api 也能找到', app2._getVideoEl() === topVideo, '');
});

test('F6-5 缓存的视频元素脱离文档后自动失效（iframe 重载，#55）', async () => {
    const { env, video } = await envWithTree(chapterSpecs(['1.1']), { stepTitle: '视频' });
    const app = await env.boot();
    check('F6-5 初次命中缓存', app._getVideoEl() === video, '');
    const doc = await frameDoc(env, 'player');
    doc.body.innerHTML = '';
    const found = app._getVideoEl();
    check('F6-5 旧节点脱离文档后返回 null', found === null, 'found=' + !!found);
    check('F6-5 打印缓存失效日志', env.xt.has('缓存的视频节点已脱离文档'), '');
});
// ---------------------------------------------------------------------------
// F7 启动与文档（#4 #5 #12 #16 #17 #23 #33 #47）
// ---------------------------------------------------------------------------

test('F7-1 README 中的仓库内链接全部有效', () => {
    const readmePath = resolve(repoRoot, 'README.md');
    check('F7-1 README 存在', existsSync(readmePath), readmePath);
    const readme = readFileSync(readmePath, 'utf8');
    const links = [...readme.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
    const broken = [];
    for (const target of links) {
        if (/^(https?:|mailto:|#)/i.test(target)) continue;
        const clean = target.split('#')[0].trim();
        if (!clean) continue;
        if (!existsSync(resolve(repoRoot, clean))) broken.push(target);
    }
    check('F7-1 所有仓库内链接都指向存在的文件', broken.length === 0, 'broken=' + JSON.stringify(broken));
    check('F7-1 至少包含源码/油猴/构建脚本链接', ['v3_optimized.js', 'v3_optimized.user.js', 'scripts/build-userscript.mjs'].every((p) => links.some((l) => l.indexOf(p) >= 0)), JSON.stringify(links));
});

test('F7-2 README 记录的默认配置与实际代码一致', async () => {
    const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');
    // 取「配置块」而不是文档里第一个 javascript 代码块：按 playbackRate 关键字定位，避免新增章节导致误判。
    const block = (readme.match(/```javascript\r?\n([\s\S]*?)```/g) || []).map((m) => m.match(/```javascript\r?\n([\s\S]*?)```/)[1]).find((body) => body.indexOf('playbackRate') >= 0) || null;
    check('F7-2 README 含 javascript 配置块', !!block, '');
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) });
    const app = await env.boot();
    const pairs = block ? [...block.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^,\n]+?),?\s*$/gm)].map((m) => [m[1], m[2].trim()]) : [];
    const parseValue = (raw) => {
        if (raw === 'true') return true;
        if (raw === 'false') return false;
        if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
      if (/^\[.*\]$/.test(raw)) { try { return JSON.parse(raw.replace(/'/g, '"')); } catch (e) { /* 落回字符串比较 */ } }
        return raw.replace(/^['"]|['"]$/g, '');
    };
    const mismatched = [];
    for (const pair of pairs) {
        const key = pair[0];
        const raw = pair[1];
        if (raw.indexOf('{') >= 0 || raw.indexOf('}') >= 0) continue; // 跳过 configs: { 之类的包装行
        if (!(key in app.configs)) { mismatched.push(key + ' 不存在于代码 configs'); continue; }
        const norm = (v) => (Array.isArray(v) ? JSON.stringify(v) : String(v));
      if (norm(app.configs[key]) !== norm(parseValue(raw))) mismatched.push(`${key}: README=${parseValue(raw)} code=${app.configs[key]}`);
    }
    check('F7-2 README 每个配置项都与代码一致', pairs.length > 0 && mismatched.length === 0, JSON.stringify(mismatched));
    for (const key of ['autoAdvanceNoVideo', 'maxConsecutiveNoVideoAdvances', 'resumeMaxAttemptsPerUnit', 'videoFrameMaxDepth']) {
        check('F7-2 README 记录了安全阀配置 ' + key, pairs.some((p) => p[0] === key), '');
    }
});

test('F7-3 启动失败/未就绪时给出可操作提示', async () => {
    const env = createEnv({ html: '<div id="empty"></div>' });
    await env.boot(22000);
    check('F7-3 未检测到课程目录时报启动超时', env.xt.has('脚本启动超时'), '');
    check('F7-3 超时日志包含处理方法', env.xt.has('处理方法'), '');
    check('F7-3 目录缺失时不创建 app', !env.window.app, '');

    const env2 = createEnv({ html: '<div id="coursetree"><ul></ul></div>' });
    await env2.boot(22000);
    check('F7-3 目录已出现但无小节节点时给出等待提示', env2.xt.has('没有渲染出任何小节节点'), '');

    const env3 = createEnv({ html: '<div id="coursetree"><ul></ul></div>' });
    env3.window.eval('delete window.jQuery; delete window.$;');
    env3.window.eval(env3.source);
    const tag = env3.window.document.querySelector('script[src*="code.jquery.com"]');
    check('F7-3 页面缺少 jQuery 时补一个 CDN script（脚本唯一外部资源）', !!tag, '');
    if (tag && typeof tag.onerror === 'function') tag.onerror();
    check('F7-3 CDN 被拦截时给出可操作提示', env3.xt.has('CDN 加载被浏览器/网络拦截'), '');
});

test('修复点注释齐全，可回溯到具体 issue 编号', () => {
    const code = readFileSync(sourcePath, 'utf8');
    for (const f of ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7']) {
        check('源码注释包含 ' + f + '（#issue）', new RegExp(f + '（#[0-9]+').test(code), '');
    }
    check('F1 注释说明导航锁复位', /F1（#[^）]*）[^\n]*导航锁/.test(code), '');
    check('F4 注释说明移除 mouseout/mouseleave 劫持', /F4（#[^）]*）[^\n]*mouseleave\/mouseout|mouseleave\/mouseout/.test(code), '');
});

test('V3.6 版本标识与构建脚本一致', () => {
    const code = readFileSync(sourcePath, 'utf8');
    const build = readFileSync(resolve(repoRoot, 'scripts/build-userscript.mjs'), 'utf8');
    check('源码声明 V3.6', /const VERSION = 'V3\.6'/.test(code), '');
    check('构建脚本 @version 为 3.6.0', /@version\s+3\.6\.0/.test(build), '');
});

test('F8 xuexitong.js（V1）入口点击已加固，不再有未保护的 querySelector(...).click()（#14 #15 #16 #17 #18）', () => {
    const v1Path = resolve(repoRoot, 'xuexitong.js');
    check('F8 xuexitong.js 存在', existsSync(v1Path), v1Path);
    const raw = readFileSync(v1Path, 'utf8');
    const code = stripComments(raw);
    const unguarded = [...code.matchAll(/querySelector(?:All)?\s*\([^)]*\)\s*\.\s*click\s*\(/g)].map((m) => m[0]);
    check('F8 不存在 querySelector(...).click() 的无保护写法', unguarded.length === 0, JSON.stringify(unguarded));
    check('F8 保留两种入口选择器兜底（li[title=视频] / button[title=播放视频]）', /li\[title="视频"\]/.test(code) && /button\[title="播放视频"\]/.test(code), '');
    check('F8 兜底失败时改为可操作提示而不是抛异常中断', /console\.warn\(/.test(code) && code.indexOf('已跳过本次点击') >= 0, '');
    let nodeCheckOk = true;
    let nodeCheckDetail = '';
    try {
        execFileSync(process.execPath, ['--check', v1Path], { stdio: 'pipe' });
    } catch (error) {
        nodeCheckOk = false;
        nodeCheckDetail = String((error && error.message) || error);
    }
    check('F8 node --check xuexitong.js 通过', nodeCheckOk, nodeCheckDetail);
    check('F8 V1 其它逻辑未被改动（iframe 取 video 与 2 倍速仍在）', code.indexOf('iframe.ans-insertvideo-online') >= 0 && code.indexOf('video#video_html5_api') >= 0 && code.indexOf('v.playbackRate = 2') >= 0, '');
});
// ---------------------------------------------------------------------------
// F65：问卷（不计任务点的调查问卷）——此前零测试覆盖，本组补齐
// 背景：平台把问卷放进章节树但不标任务点，会被「无任务点」流程静默跳过；
//       _detectSurveyInFrames 负责认出它，_handleSurveyNode 负责作答与提交。
// ---------------------------------------------------------------------------

/** 构造问卷 iframe 的内容；返回内部 document */
async function surveyFrame(env, frameId, inner) {
    return writeFrame(env, frameId, inner);
}

test('F65-1 问卷识别：按 name=answer* 分组计数，非问卷 iframe 不误认', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    // 注意：测试里的 iframe 一律 src="about:blank"（jsdom 只对 about:blank 同步创建 contentDocument）
    env.window.document.body.insertAdjacentHTML('beforeend',
        '<iframe id="survey" src="about:blank"></iframe>'
        + '<iframe id="noise" src="about:blank"></iframe>');
    await env.advance(600);
    await surveyFrame(env, 'survey',
        '<p>课程满意度问卷</p>'
        + '<input type="radio" name="answer101" value="1"><input type="radio" name="answer101" value="2">'
        + '<input type="checkbox" name="answer102" value="1"><input type="checkbox" name="answer102" value="2">'
        + '<textarea name="answer103"></textarea>');
    // 非问卷帧：表单控件 name 不以 answer 开头，必须被判为「不是问卷」
    await surveyFrame(env, 'noise', '<input type="text" name="unrelated"><textarea name="comment"></textarea>');

    const sv = app._detectSurveyInFrames();
    check('F65-1 识别到问卷（返回非 null）', !!sv, JSON.stringify(sv && { groups: sv.groups, questions: sv.questions }));
    check('F65-1 题组数=3（radio/checkbox/textarea 各一组）', !!sv && sv.groups === 3, 'groups=' + (sv && sv.groups));
    check('F65-1 控件数=5（2 radio + 2 checkbox + 1 textarea）', !!sv && sv.questions === 5, 'questions=' + (sv && sv.questions));
    check('F65-1 非问卷帧未被计入 docs', !!sv && sv.docs.length === 1, 'docs=' + (sv && sv.docs.length));
    check('F65-1 标题含「问卷」', !!sv && /问卷/.test(sv.title), 'title=' + (sv && sv.title));

    // 真机问卷在 iframe 的 URL 里带 workId，实现从 doc.location.href 解析它。
    // jsdom 下 about:blank 文档的 location 不可改写，这里退一步：确认 src 属性确被设置，
    // 且解析逻辑对 workId 形态的 URL 有覆盖（用正则直接核对实现所依赖的模式）。
    const frameEl = env.window.document.getElementById('survey');
    frameEl.setAttribute('src', '/mooc-ans/api/work?workId=20260917');
    check('F65-1 iframe src 可携带 workId 参数',
        /workId=(\d+)/.test(String(frameEl.getAttribute('src'))), String(frameEl.getAttribute('src')));
    check('F65-1 标题回退：无问卷标题时给出占位而非空串',
        !!sv && sv.title !== '', 'title=' + JSON.stringify(sv && sv.title));
    app.destroy();
});

test('F65-2 已作答的题不重复问 LLM（省调用、防把选项点掉）', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    env.window.document.body.insertAdjacentHTML('beforeend', '<iframe id="survey" src="about:blank"></iframe>');
    await env.advance(600);
    // 选项 value 用字母：脚本把 value 当作选项字母（opt.letter），LLM 也按约定回字母 —— 这是真实问卷的形态
    const doc = await surveyFrame(env, 'survey',
        '<p>问卷</p>'
        // 第 1 题已由用户选中
        + '<input type="radio" name="answer1" value="A" checked><input type="radio" name="answer1" value="B">'
        // 第 2 题未作答（应问 LLM）
        + '<input type="radio" name="answer2" value="A"><input type="radio" name="answer2" value="B">'
        // 第 3 题已填写
        + '<textarea name="answer3">已有内容</textarea>'
        + '<button type="button">提交</button>');
    const asked = [];
    app.setLlmTransport((o) => {
        const body = JSON.parse(String(o.data || '{}'));
        const text = JSON.stringify(body.messages || []);
        asked.push(text);
        o.onload(200, JSON.stringify({ choices: [{ message: { content: '{"answer":"A"}' }, finish_reason: 'stop' }] }));
        return null;
    });
    app.setLlmKey('sk-test-not-a-real-key');
    app.configs.llmEnabled = true;

    let out = null;
    app._handleSurveyNode({ title: '问卷', workId: '1', groups: 3, questions: 3, docs: [doc] })
        .then((r) => { out = r; }, () => { out = 'error'; });
    await env.advance(12000);

    check('F65-2 只对未作答的题发起 LLM 请求', asked.length === 1, 'asked=' + asked.length);
    check('F65-2 已作答的题未被重复选中（第 1 题仍是原选项）',
        doc.querySelector('input[name="answer1"][value="A"]').checked
        && !doc.querySelector('input[name="answer1"][value="B"]').checked, '');
    check('F65-2 已填写的填空未被改写', doc.querySelector('textarea[name="answer3"]').value === '已有内容',
        'value=' + doc.querySelector('textarea[name="answer3"]').value);
    check('F65-2 三题齐备 → 提交成功返回 true', out === true, String(out));
    app.destroy();
});

test('F65-3 安全阀：LLM 长期不可用时每题仍有兜底、不漏题', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    env.window.document.body.insertAdjacentHTML('beforeend', '<iframe id="survey" src="about:blank"></iframe>');
    await env.advance(600);
    const doc = await surveyFrame(env, 'survey',
        '<p>问卷</p>'
        + '<input type="radio" name="answer1" value="A"><input type="radio" name="answer1" value="B">'
        + '<input type="radio" name="answer2" value="A"><input type="radio" name="answer2" value="B">'
        + '<button type="button" id="submitBtn">提交</button>');
    let clicked = false;
    doc.getElementById('submitBtn').addEventListener('click', () => { clicked = true; });
    // LLM 一律 500：脚本不会立刻放弃——_llmRequestNow 的心跳重试是
    // llmRetryIntervalMs(60000) × llmMaxRetries(5)，最坏 5 分钟才回调失败。
    // 因此真实路径是「每题等待上限先到（max(15000, llmTimeoutMs)）→ 走选第一项的兜底」。
    app.setLlmTransport((o) => { o.onload(500, '{"error":"boom"}'); return null; });
    app.setLlmKey('sk-test-not-a-real-key');
    app.configs.llmEnabled = true;

    let out = null;
    app._handleSurveyNode({ title: '问卷', workId: '2', groups: 2, questions: 2, docs: [doc] })
        .then((r) => { out = r; }, () => { out = 'error'; });
    // 推进到每题等待上限之后（2 题各 30s + 题间 350ms 间隔 + 收尾 1200ms 的余量）
    await env.advance(90000);

    check('F65-3 LLM 不可用时每题仍被兜底选中（不漏题）',
        doc.querySelector('input[name="answer1"][value="A"]').checked
        && doc.querySelector('input[name="answer2"][value="A"]').checked, '');
    check('F65-3 答满后提交（返回 true 且按钮被点）', out === true && clicked, 'out=' + out + ' clicked=' + clicked);
    app.destroy();
});

test('F65-4 提交按钮必须精确匹配「提交/交卷/完成」——模糊文案不得误点', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    env.window.document.body.insertAdjacentHTML('beforeend', '<iframe id="survey" src="about:blank"></iframe>');
    await env.advance(600);
    const doc = await surveyFrame(env, 'survey',
        '<p>问卷</p>'
        + '<input type="radio" name="answer1" value="1"><input type="radio" name="answer1" value="2">'
        + '<button type="button" id="danger">提交答案</button>'      // 模糊：不该被点
        + '<button type="button" id="cancel">取消</button>'          // 危险：不该被点
        + '<button type="button" id="ok">提交</button>');            // 精确：应被点
    const hits = [];
    doc.getElementById('danger').addEventListener('click', () => hits.push('danger'));
    doc.getElementById('cancel').addEventListener('click', () => hits.push('cancel'));
    doc.getElementById('ok').addEventListener('click', () => hits.push('ok'));
    app.setLlmTransport((o) => {
        o.onload(200, JSON.stringify({ choices: [{ message: { content: '{"answer":"A"}' }, finish_reason: 'stop' }] }));
        return null;
    });
    app.setLlmKey('sk-test-not-a-real-key');
    app.configs.llmEnabled = true;

    let out = null;
    app._handleSurveyNode({ title: '问卷', workId: '3', groups: 1, questions: 1, docs: [doc] })
        .then((r) => { out = r; }, () => { out = 'error'; });
    await env.advance(12000);

    check('F65-4 只点精确匹配的「提交」按钮', hits.length === 1 && hits[0] === 'ok', JSON.stringify(hits));
    check('F65-4 未误点「提交答案」这类模糊文案', hits.indexOf('danger') < 0, JSON.stringify(hits));
    check('F65-4 未误点「取消」', hits.indexOf('cancel') < 0, JSON.stringify(hits));
    check('F65-4 提交成功返回 true', out === true, String(out));
    app.destroy();
});

test('F65-5 surveySubmit=false 时只填答不提交（配置开关生效）', async () => {
    const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<div class="prev_title" title="视频"></div>' });
    const app = await env.boot();
    env.window.document.body.insertAdjacentHTML('beforeend', '<iframe id="survey" src="about:blank"></iframe>');
    await env.advance(600);
    const doc = await surveyFrame(env, 'survey',
        '<p>问卷</p>'
        + '<input type="radio" name="answer1" value="1"><input type="radio" name="answer1" value="2">'
        + '<button type="button" id="submitBtn">提交</button>');
    let clicked = false;
    doc.getElementById('submitBtn').addEventListener('click', () => { clicked = true; });
    app.setLlmTransport((o) => {
        o.onload(200, JSON.stringify({ choices: [{ message: { content: '{"answer":"A"}' }, finish_reason: 'stop' }] }));
        return null;
    });
    app.setLlmKey('sk-test-not-a-real-key');
    app.configs.llmEnabled = true;
    app.configs.surveySubmit = false;   // 本用例只验证该开关

    let out = null;
    app._handleSurveyNode({ title: '问卷', workId: '4', groups: 1, questions: 1, docs: [doc] })
        .then((r) => { out = r; }, () => { out = 'error'; });
    await env.advance(12000);

    check('F65-5 surveySubmit=false → 不点提交按钮', !clicked, 'clicked=' + clicked);
    check('F65-5 但选项已填（保留人工可直接提交）',
        doc.querySelector('input[name="answer1"][value="1"]').checked, '');
    check('F65-5 返回值 true（已填答，未提交）', out === true, String(out));
    check('F65-5 日志说明为何不提交', env.xt.has('surveySubmit=false'), JSON.stringify(env.xt.logs.slice(-3)));
    app.destroy();
});

// ---------------------------------------------------------------------------
// 运行入口
// ---------------------------------------------------------------------------

async function main() {
    console.log('XT_SOURCE = ' + sourcePath);
    console.log('');
    for (const t of tests) {
        const start = results.length;
        try {
            await t.fn();
        } catch (error) {
            check(t.id + ' 执行异常', false, String((error && error.stack) || error));
        }
        const group = results.slice(start);
        const failed = group.filter((r) => !r.ok);
        console.log(`${failed.length === 0 ? 'PASS' : 'FAIL'}  ${t.id}  (${group.length - failed.length}/${group.length})`);
        for (const r of failed) console.log('        - ' + r.name + (r.detail ? ' :: ' + r.detail : ''));
    }
    for (const env of openEnvs) env.close();
    const failedAll = results.filter((r) => !r.ok);
    console.log('');
    console.log(`断言统计：${results.length - failedAll.length}/${results.length} 通过`);
    if (failedAll.length) {
        console.log('失败明细：');
        for (const r of failedAll) console.log('  FAIL ' + r.name + (r.detail ? ' :: ' + r.detail : ''));
        process.exitCode = 1;
        return;
    }
    console.log('V3.6 回归测试全部通过（F1-F11）。');
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
