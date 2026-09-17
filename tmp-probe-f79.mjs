// 临时探测（验证后删除）：用与队友一致的连线题结构，确认 F72 改动对 F79 链路零影响。
import { createEnv, tree, chapterSpecs, check, results } from './tests/regression.mjs';

const env = createEnv({ html: tree(chapterSpecs(['1.1'])) + '<iframe id="work" src="about:blank"></iframe>' });
const app = await env.boot();
const f = env.window.document.getElementById('work');
let doc = null;
for (let i = 0; i < 6; i++) {
    if (f.contentDocument && f.contentDocument.body) { doc = f.contentDocument; break; }
    await new Promise((r) => setImmediate(r));
}
const mkSelect = (list) => '<select class="dept_select_sel">'
    + '<option value="0">请选择</option>'
    + list.map((t, i) => '<option value="' + (i + 1) + '">' + t + '</option>').join('')
    + '</select>';
doc.body.innerHTML = '<div class="TiMu">'
    + '<div class="newZy_TItle">连线题</div>'
    + '<div class="Zy_TItle">请将左栏与右栏配对</div>'
    + '<div class="thirdUlList"><div class="dept_select">' + mkSelect(['甲', '乙', '丙']) + mkSelect(['一', '二', '三']) + '</div></div>'
    + '</div>';
const q = app._workQuestionList(doc)[0];
check('F72 不改连线题选项判定（optionEls=0）', !!q && q.optionEls.length === 0, String(q && q.optionEls.length));
check('F72 不影响连线题下拉框提取（lineSelects=2）', !!q && Array.isArray(q.lineSelects) && q.lineSelects.length === 2,
    JSON.stringify(q && q.lineSelects ? q.lineSelects.length : null));
check('F72 不影响连线题的写作题豁免', !!q && q.isShortAnswer === false, String(q && q.isShortAnswer));
app.destroy();
const failed = results.filter((r) => !r.ok);
console.log('');
for (const r of results) console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? ' :: ' + r.detail : ''));
console.log('探测：' + (results.length - failed.length) + '/' + results.length + ' 通过');
if (failed.length) process.exitCode = 1;
