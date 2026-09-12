import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 单一源码约定：repo/v3_optimized.js 是唯一实现，本脚本只负责拼接油猴元数据块。
const root = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(root, 'v3_optimized.js'), 'utf8').replace(/^\uFEFF/, '');
const metadata = `// ==UserScript==
// @name         学习通自动刷课脚本 V3.5
// @namespace    local.codex.xuexitong
// @version      3.5.0
// @description  自动播放、自动切换下一小节；V3.5 新增 GUI 监控面板与可选 LLM 互动题应答（默认关闭）；沿用 V3.4 的导航/播放/风控修复（详见 README）
// @author       Codex
// @match        *://mooc1.chaoxing.com/mycourse/studentstudy*
// @match        *://*.chaoxing.com/mycourse/studentstudy*
// @match        *://*.chaoxing.com/mooc2-ans/mycourse/studentstudy*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      opencode.ai
// ==/UserScript==

`;

writeFileSync(resolve(root, 'v3_optimized.user.js'), `${metadata}${source}`, 'utf8');
console.log('generated v3_optimized.user.js from v3_optimized.js');