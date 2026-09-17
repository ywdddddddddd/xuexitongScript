// 临时探测（验证后删除）：确认 F79-2 失败根因是否与「顶层 window 的 Event 跨 iframe 派发」有关。
import { createEnv, tree, chapterSpecs } from './tests/regression.mjs';

const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<iframe id="work" src="about:blank"></iframe>' });
const f = env.window.document.getElementById('work');
let doc = null;
for (let i = 0; i < 6; i++) {
    if (f.contentDocument && f.contentDocument.body) { doc = f.contentDocument; break; }
    await new Promise((r) => setImmediate(r));
}
doc.body.innerHTML = '<select class="dept_select_sel"><option value="0">请选择</option><option value="1">甲</option></select>';
const sel = doc.querySelector('select');
sel.value = '1';
console.log('1) 直接设置 sel.value 生效：', String(sel.value));
console.log('2) 顶层 window 的 Event 是否等于 iframe window 的 Event：', env.window.Event === f.contentWindow.Event);
try {
    sel.dispatchEvent(new env.window.Event('change', { bubbles: true }));
    console.log('3) 用顶层 Event 跨 iframe 派发：成功（未抛错）');
} catch (e) {
    console.log('3) 用顶层 Event 跨 iframe 派发：抛错 ->', String(e && e.message));
}
try {
    sel.dispatchEvent(new f.contentWindow.Event('change', { bubbles: true }));
    console.log('4) 用同窗口 Event 派发：成功');
} catch (e) {
    console.log('4) 用同窗口 Event 派发：抛错 ->', String(e && e.message));
}
env.close();
