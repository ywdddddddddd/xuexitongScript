import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 单一源码约定：repo/v3_optimized.js 是唯一实现，本脚本只负责拼接油猴元数据块。
const root = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(root, 'v3_optimized.js'), 'utf8').replace(/^\uFEFF/, '');
// F34：font-cxsecret glyf 哈希表（由 scripts/... 生成，见 resource/font-map-data.js）随油猴版一起分发
const fontData = readFileSync(resolve(root, 'resource/font-map-data.js'), 'utf8').replace(/^\uFEFF/, '');
const metadata = `// ==UserScript==
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

`;

writeFileSync(resolve(root, 'v3_optimized.user.js'), `${metadata}${fontData}\n${source}`, 'utf8');
console.log('generated v3_optimized.user.js from v3_optimized.js');