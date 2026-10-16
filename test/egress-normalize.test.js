/**
 * 出口规范化单测（2026-10-17）。
 *
 * 覆盖两类症状（都有真实素材）：
 *   ① 思考链被当正文：正文里出现字面 `<thinking>…</thinking>`
 *   ② XML 式工具调用漏成正文：解析失败被原样吐出来（实测一次压缩摘要 500 字全是这个）
 *
 * 关注点：
 *   1. 只剥**正文开头**的 thinking，中间/后面的标签不碰（避免误伤引用与讨论）；
 *   2. 流式切分（标记被切在两个 delta 之间）不能吞正文、不能重复吐前缀；
 *   3. **默认绝不伪造工具调用**（strip 模式）——把模型"说的话"变成"执行的命令"太危险；
 *   4. 只有 convert 模式 + 工具名在白名单里才转，且 finish reason 要跟着改；
 *   5. 压缩请求永不转换（纯摘要任务）；
 *   6. 作用域判定（web/all/off）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  stripLeadingThinkingPure,
  parseXmlToolCalls,
  stripXmlToolMarkers,
  pushEgressDelta,
  finalizeEgressText,
  createEgressState,
  isWebRoute,
} from '../index.js'
import { installEgressNormalizer, egressStats } from '../egress.js'

/* ==================== ① 思考标签 ==================== */

test('整段开头 <thinking> 被剥掉，后面的真正正文保留', () => {
  const r = stripLeadingThinkingPure('<thinking>我在想事情</thinking>真正的回答')
  assert.equal(r.text, '真正的回答')
  assert.equal(r.inTag, false)
  assert.equal(r.changed, true)
})

test('正文就是整段思考（无正文）⇒ 清空', () => {
  assert.equal(stripLeadingThinkingPure('<thinking>只有思考，没有回答</thinking>').text, '')
})

test('前导空白/大小写/属性都不影响识别', () => {
  assert.equal(stripLeadingThinkingPure('\n  <THINKING>  想  </THINKING>答案').text, '答案')
  assert.equal(stripLeadingThinkingPure('<thinking type="reasoning">想</thinking>答案').text, '答案')
})

test('正文中间/后面的标签**不**被剥（避免误伤引用与讨论）', () => {
  const text = '这是普通回答，里面引用了 <thinking>别人的思考</thinking> 这个标签。'
  const r = stripLeadingThinkingPure(text)
  assert.equal(r.text, text)
  assert.equal(r.changed, false)
})

test('流式：闭合标签被切开时留 pending，下一段拼得回来', () => {
  const a = stripLeadingThinkingPure('<thinking>思考')
  const b = stripLeadingThinkingPure(a.pending + '思考</thin', a.inTag)
  assert.equal(b.text, '')
  assert.equal(b.inTag, true)
  assert.equal(b.pending, '</thin')
  const c = stripLeadingThinkingPure(b.pending + 'king>回答', b.inTag)
  assert.equal(c.text, '回答')
  assert.equal(c.inTag, false)
})

test('流式：连续两段思考都剥掉', () => {
  assert.equal(stripLeadingThinkingPure('<thinking>一</thinking><thinking>二</thinking>答案').text, '答案')
})

/* ==================== ② XML 工具调用（真实素材） ==================== */

/** 实测泄漏原文（session-72185b36 那次 500 字压缩摘要）。 */
const REAL_LEAK = [
  '继续推进，先看两块关键接口：`/config` 的读写和 `slotFromPath`，确定账号配置怎么落盘：',
  '[调用工具 read><parameter name="file_path">C:\\Users\\Evelyn\\AppData\\Local\\DeepSeekHarness\\.dsh\\profiles\\web\\node_modules\\dsh-webin\\lib\\index.js</parameter><parameter=limit>90</parameter><parameter=offset>4068</parameter>',
  '[调用工具 grep><parameter name="path">C:\\x\\index.js</parameter><parameter=pattern>function slotFromPath|slotFromPath\\(</parameter></function></tool_call>',
].join('\n')

test('真实泄漏：两个调用都被认出来，参数逐字保住（含反斜杠与正则括号）', () => {
  const r = parseXmlToolCalls(REAL_LEAK)
  assert.equal(r.calls.length, 2)
  assert.equal(r.calls[0].name, 'read')
  const args0 = JSON.parse(r.calls[0].arguments)
  assert.equal(args0.file_path, 'C:\\Users\\Evelyn\\AppData\\Local\\DeepSeekHarness\\.dsh\\profiles\\web\\node_modules\\dsh-webin\\lib\\index.js')
  assert.equal(args0.limit, '90')
  assert.equal(args0.offset, '4068')
  assert.equal(r.calls[1].name, 'grep')
  assert.equal(JSON.parse(r.calls[1].arguments).pattern, 'function slotFromPath|slotFromPath\\(')
})

test('真实泄漏：剥完不留任何标记残渣（含尾部 </function></tool_call>）', () => {
  const clean = stripXmlToolMarkers(REAL_LEAK)
  assert.ok(!clean.includes('调用工具'), '不该残留 [调用工具')
  assert.ok(!clean.includes('<parameter'), '不该残留 parameter 标签')
  assert.ok(!clean.includes('</tool_call>'), '不该残留尾部闭合标签')
  assert.ok(clean.includes('继续推进'), '真正的正文要留下')
})

test('参数写法变体：name= / 无引号 / 自闭合 / 单引号 都能读', () => {
  const variants = [
    '[调用工具 read><parameter name=path>C:\\a.js</parameter>',
    "[调用工具 read><parameter name='path'>C:\\a.js</parameter>",
    '[调用工具 read><parameter name="path" value="C:\\a.js"/>',
    '[调用工具 read>\n<parameter name="path">C:\\a.js</parameter>',
  ]
  for (const v of variants) {
    const r = parseXmlToolCalls(v)
    assert.equal(r.calls.length, 1, `应认出 1 个调用：${v}`)
    assert.equal(JSON.parse(r.calls[0].arguments).path, 'C:\\a.js', `参数值要逐字保住：${v}`)
  }
})

test('<tool_calls> / <function_call> 成对包裹形态也能认', () => {
  const a = '<tool_calls><tool_call><name>read</name><parameter name="file_path">/x.js</parameter></tool_call></tool_calls>'
  assert.equal(parseXmlToolCalls(a).calls[0].name, 'read')
  const b = '<function_call name="grep"><parameter name="pattern">foo</parameter></function_call>'
  assert.equal(parseXmlToolCalls(b).calls[0].name, 'grep')
  assert.equal(stripXmlToolMarkers(b), '')
})

test('普通正文里的尖括号/方括号**不**被误伤', () => {
  for (const text of [
    '这个条件是 a < b 而且 b > c。',
    '数组写成 arr[0] 和 obj["k"]。',
    '标签 <div> 和 </div> 是成对的。',
    'HTML 里 <parameter> 这个词只是普通名词。',
  ]) {
    const r = parseXmlToolCalls(text)
    assert.equal(r.calls.length, 0, `不该认出调用：${text}`)
    assert.equal(r.clean, text, `正文必须原样保留：${text}`)
  }
})

test('半个标记（流还没吐完）⇒ complete=false，不急着当正文吐', () => {
  assert.equal(parseXmlToolCalls('[调用工具 read><parameter name="a">1</para').complete, false)
  assert.equal(parseXmlToolCalls('[调用').complete, false)
  assert.equal(parseXmlToolCalls('正常一句话').complete, true)
})

/* ==================== ③ 流式状态机 ==================== */

test('流式：标记被切在两个 delta 之间 ⇒ 不吐半个标记，也不吞正文', () => {
  const st = createEgressState()
  const out = []
  for (const d of ['先看两块接口：', '[调用工', '具 read><paramet', 'er name="path">/x.js</parameter>', '好了']) {
    out.push(pushEgressDelta(st, d).text)
  }
  const joined = out.join('')
  assert.ok(!joined.includes('调用工'), '不该把半个标记吐出去')
  assert.ok(!joined.includes('parameter'), '不该残留参数标签')
  assert.ok(joined.startsWith('先看两块接口：'), '正文前缀要留下')
  assert.ok(joined.endsWith('好了'), '标记之后的正文要留下')
})

test('流式：思考标签跨 delta 也剥得掉', () => {
  const st = createEgressState()
  const out = []
  for (const d of ['<thin', 'king>想事情</thin', 'king>答案']) out.push(pushEgressDelta(st, d).text)
  assert.equal(out.join(''), '答案')
})

test('流式：普通正文逐字不漏（无标记时零改动）', () => {
  const st = createEgressState()
  const out = ['你好，', '这是', '一段普通', '回答。'].map((d) => pushEgressDelta(st, d).text).join('')
  assert.equal(out, '你好，这是一段普通回答。')
})

test('块结束：finalize 从完整文本重算，不重复前缀（上一轮的坑）', () => {
  /* delta 层已经把前缀吐出去了，block-end 又给完整文本 —— 若拼接就会「先看先看」 */
  const st = createEgressState()
  pushEgressDelta(st, '先看两块接口：')
  const full = '先看两块接口：\n[调用工具 read><parameter name="path">/x.js</parameter>'
  const f = finalizeEgressText(full)
  assert.equal(f.text, '先看两块接口：\n')
  assert.deepEqual(f.parts, ['xml-markers'])
  assert.equal(f.calls.length, 0, 'strip 模式不产出调用')
})

/* ==================== ④ 安装与作用域 ==================== */

/** 最小 cordis 假上下文：记录 waterfall 监听器，手动驱动。 */
function fakeCtx() {
  const hooks = []
  return {
    hooks,
    llm: {},
    /* cordis 的 effect 会**迭代** generator 回调（用 yield 挂 disposer），
       所以这里必须真的把 generator 跑完 —— 直接 fn() 只会拿到没执行的生成器。 */
    effect(fn) {
      const g = fn()
      if (g !== null && typeof g === 'object' && typeof g.next === 'function') {
        let step = g.next()
        while (step.done !== true) step = g.next()
      }
    },
    on(name, cb) { hooks.push({ name, cb }) },
  }
}

/** 造一条流：text 一整段，带 block-start/end 与 finish。 */
async function* makeStream(text, extra = {}) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
  for (const c of extra.tail ?? []) yield c
}

/** 走一遍安装好的瀑布。 */
async function runThrough(hook, options, text, extra) {
  const cb = hook.cb
  return cb(options, () => makeStream(text, extra))
}

test('装的是 llm/stream 瀑布（不是 llm.stream —— 主循环根本不走那条路）', () => {
  const ctx = fakeCtx()
  const ok = installEgressNormalizer(ctx, {}, { log: () => {}, readOptions: () => ({}) })
  assert.equal(ok, true)
  assert.equal(ctx.hooks.length, 1)
  assert.equal(ctx.hooks[0].name, 'llm/stream')
  /* llm.stream 不该被包装（上一轮就是这么错的） */
  assert.equal(typeof ctx.llm.stream, 'undefined')
})

test('scope=off ⇒ 原样透传', async () => {
  const ctx = fakeCtx()
  installEgressNormalizer(ctx, {}, { log: () => {}, readOptions: () => ({ egressScope: 'off' }) })
  const out = []
  for await (const c of await runThrough(ctx.hooks[0], { provider: 'webin-deepseek' }, '<thinking>x</thinking>答案')) out.push(c)
  const text = out.filter((c) => c.type === 'block-end')[0].block.text
  assert.equal(text, '<thinking>x</thinking>答案', 'off 就该什么都不做')
})

test('scope=web ⇒ 只对网页端路由生效，别的 provider 原样透传', async () => {
  const ctx = fakeCtx()
  installEgressNormalizer(ctx, {}, { log: () => {}, readOptions: () => ({ egressScope: 'web' }) })
  const hook = ctx.hooks[0]
  const before = egressStats.skippedByScope
  const webOut = []
  for await (const c of await runThrough(hook, { provider: 'webin-deepseek' }, '<thinking>x</thinking>网页答案')) webOut.push(c)
  assert.equal(webOut.filter((c) => c.type === 'block-end')[0].block.text, '网页答案')
  const apiOut = []
  for await (const c of await runThrough(hook, { provider: 'dsh' }, '<thinking>x</thinking>API 答案')) apiOut.push(c)
  assert.equal(apiOut.filter((c) => c.type === 'block-end')[0].block.text, '<thinking>x</thinking>API 答案')
  assert.equal(egressStats.skippedByScope, before + 1, '跳过要计数')
})

test('scope=all ⇒ 任何 provider 都规范化', async () => {
  const ctx = fakeCtx()
  installEgressNormalizer(ctx, {}, { log: () => {}, readOptions: () => ({ egressScope: 'all' }) })
  const out = []
  for await (const c of await runThrough(ctx.hooks[0], { provider: 'dsh' }, '<thinking>x</thinking>答案')) out.push(c)
  assert.equal(out.filter((c) => c.type === 'block-end')[0].block.text, '答案')
})

test('默认（strip）绝不伪造工具调用 —— 光剥标记，finish 仍是 stop', async () => {
  const ctx = fakeCtx()
  installEgressNormalizer(ctx, {}, { log: () => {}, readOptions: () => ({ egressXmlTools: 'strip' }) })
  const out = []
  for await (const c of await runThrough(ctx.hooks[0], { provider: 'webin-deepseek', tools: [{ name: 'read' }] }, REAL_LEAK)) out.push(c)
  assert.equal(out.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call').length, 0, 'strip 模式不能产出 tool-call')
  assert.equal(out.filter((c) => c.type === 'finish')[0].reason.kind, 'stop', '终止原因不能变')
  assert.ok(!out.filter((c) => c.type === 'block-end')[0].block.text.includes('parameter'), '标记要剥干净')
})

test('convert 模式：工具名在白名单里才转，且 finish 改成 tool-calls', async () => {
  const ctx = fakeCtx()
  installEgressNormalizer(ctx, {}, { log: () => {}, readOptions: () => ({ egressXmlTools: 'convert' }) })
  const out = []
  const opts = { provider: 'webin-deepseek', tools: [{ name: 'read' }, { name: 'grep' }] }
  for await (const c of await runThrough(ctx.hooks[0], opts, REAL_LEAK)) out.push(c)
  const calls = out.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].block.name, 'read')
  assert.equal(out.filter((c) => c.type === 'finish')[0].reason.kind, 'tool-calls', '不改 reason 主循环不会执行')
  /* 流协议要求：每个 tool-call 块要有 block-start + delta 打头 */
  const starts = out.filter((c) => c.type === 'block-start' && c.blockType === 'tool-call')
  assert.equal(starts.length, 2)
  assert.equal(out.filter((c) => c.type === 'tool-call-delta').length, 2)
})

test('convert 模式：工具名不在白名单 ⇒ 不转（防幻觉工具名）', async () => {
  const ctx = fakeCtx()
  installEgressNormalizer(ctx, {}, { log: () => {}, readOptions: () => ({ egressXmlTools: 'convert' }) })
  const out = []
  for await (const c of await runThrough(ctx.hooks[0], { provider: 'webin-deepseek', tools: [{ name: 'pwsh' }] }, REAL_LEAK)) out.push(c)
  assert.equal(out.filter((c) => c.block?.type === 'tool-call').length, 0)
  assert.equal(out.filter((c) => c.type === 'finish')[0].reason.kind, 'stop')
})

test('压缩请求（purpose=compaction）永不转换 —— 那是纯摘要任务', async () => {
  const ctx = fakeCtx()
  installEgressNormalizer(ctx, {}, { log: () => {}, readOptions: () => ({ egressXmlTools: 'convert' }) })
  const out = []
  const opts = { provider: 'webin-deepseek', purpose: 'compaction', tools: [{ name: 'read' }] }
  for await (const c of await runThrough(ctx.hooks[0], opts, REAL_LEAK)) out.push(c)
  assert.equal(out.filter((c) => c.block?.type === 'tool-call').length, 0, '压缩时绝不能产生工具调用')
})

test('egressNormalize: false ⇒ 整体不装', () => {
  const ctx = fakeCtx()
  assert.equal(installEgressNormalizer(ctx, { egressNormalize: false }, { log: () => {}, readOptions: () => ({}) }), false)
  assert.equal(ctx.hooks.length, 0)
})

test('重复安装不叠加（标记判重）', () => {
  const ctx = fakeCtx()
  installEgressNormalizer(ctx, {}, { log: () => {}, readOptions: () => ({}) })
  installEgressNormalizer(ctx, {}, { log: () => {}, readOptions: () => ({}) })
  assert.equal(ctx.hooks.length, 1, '第二次应被标记挡下')
})

test('流协议合规：规范化后的块序列仍能过 BlockAssembler 的语法（start→delta→end 配对）', async () => {
  const ctx = fakeCtx()
  installEgressNormalizer(ctx, {}, { log: () => {}, readOptions: () => ({ egressXmlTools: 'convert' }) })
  const out = []
  for await (const c of await runThrough(ctx.hooks[0], { provider: 'w', tools: [{ name: 'read' }, { name: 'grep' }] }, REAL_LEAK)) out.push(c)
  const open = new Map()
  for (const c of out) {
    if (c.type === 'block-start') { assert.ok(!open.has(c.index), `index ${c.index} 重复 start`); open.set(c.index, c.blockType) }
    if (c.type === 'block-end') { assert.equal(open.get(c.index), c.block.type, `index ${c.index} 的 end 与 start 类型不符`); open.delete(c.index) }
  }
  assert.equal(open.size, 0, '结束时不该有未闭合的块')
})

/* ==================== ⑤ 作用域判定 ==================== */

test('isWebRoute：webin-<平台> 算网页端；自定义名单按前缀匹配', () => {
  assert.equal(isWebRoute('webin-deepseek'), true)
  assert.equal(isWebRoute('webin-yuanbao'), true)
  assert.equal(isWebRoute('webin'), true)
  assert.equal(isWebRoute('dsh'), false)
  assert.equal(isWebRoute('our-free-model'), false)
  assert.equal(isWebRoute(''), false)
  assert.equal(isWebRoute(undefined), false)
  assert.equal(isWebRoute('my-webin-x', ['my-webin']), true)
  assert.equal(isWebRoute('my-webin-x'), false)
})
