/**
 * 空正文块守卫单测（2026-10-30 实战 400 根因）。
 *
 * 现场：会话 session-fe050e0a「2026·成都七中十月月考」turn 19 切到
 * tiantian/deepseek-v4.1-flash 后整轮 400 invalid_request_error，
 * usage.inputTokens = 0（校验阶段被拒，没进推理）。
 *
 * 根因：egress 层把「整块正文被判为思考泄漏」的 text 块原样透传成空串，
 * 宿主持久化成 content:[{type:'text',text:''}]，严格上游对空 content 直接 400。
 * 直打 /v1/chat/completions 实测（同一 payload）：
 *   - 含一条 content:"" 的 user 消息 → 400 invalid_request_error
 *   - 把该条换成任意非空占位        → 200
 *   - content:"   "（纯空格）       → 200（只拒空串，不拒空白）
 *
 * 本测试锁死修复后的契约：被剥空的 text 块**不得发射**，
 * 正常正文与工具调用照常，reasoning / finish 结构不被破坏。
 *
 * 测试走的是真实挂载路径（installEgressNormalizer 注册的 llm/stream 瀑布），
 * 不是内部私有函数——这样能抓到「接线断了但单测还是绿」的假象。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { installEgressNormalizer, egressStats } from '../egress.js'

/**
 * 装一个最小 ctx：能挂 effect/on，把 llm/stream handler 暴露出来。
 * @param {object} opts - readOptions 返回的开关对象
 */
function mount(opts) {
  let handler
  const ctx = {
    llm: {},
    effect(fn) {
      /* cordis effect：传入生成器，yield 出来的都是清理函数。
         这里直接迭代一遍把 ctx.on 的注册副作用跑出来。 */
      const it = fn()
      for (const step of it) {
        if (typeof step === 'function') continue
      }
    },
    on(event, fn) {
      if (event === 'llm/stream') handler = fn
      return () => {}
    }
  }
  const ok = installEgressNormalizer(ctx, {}, { readOptions: () => opts })
  assert.equal(ok, true, 'egress normalizer 应安装成功')
  assert.equal(typeof handler, 'function', 'llm/stream handler 应已注册')
  return handler
}

/** 把一个 chunk 数组包成 async generator。 */
function scripted(chunks) {
  return async function* () {
    for (const chunk of chunks) yield chunk
  }
}

/** 跑一次 llm/stream：next() 返回底层流，收集 handler 处理后实际吐出的 chunk。 */
async function run(handler, chunks, options = {}) {
  const next = () => scripted(chunks)(options)
  const out = []
  for await (const chunk of handler(options, next)) out.push(chunk)
  return out
}

test('整块正文被判为思考泄漏时，空 text 块不得发射（防上游 400）', async () => {
  const handler = mount({ egressThinking: true, egressScope: 'all' })
  const t = '我要先数一遍字数，再按四川考生标准打分，注意不能太刁钻。'
  const out = await run(handler, [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: t },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: t } },
    { type: 'block-start', index: 1, blockType: 'text' },
    /* 正文与 reasoning 完全相同 ⇒ 判为泄漏 ⇒ dedupe 返回 '' */
    { type: 'text-delta', index: 1, text: t },
    { type: 'block-end', index: 1, block: { type: 'text', text: t } },
    { type: 'finish', reason: { kind: 'stop' } }
  ])

  const textEnds = out.filter((c) => c.type === 'block-end' && c.block?.type === 'text')
  assert.equal(textEnds.length, 0, '被判泄漏的空 text 块必须不发射')

  /* 空串绝不能出现在任何会落成消息正文的通道上 */
  for (const c of out) {
    if (c.type === 'text-delta') assert.notEqual(String(c.text ?? ''), '', 'text-delta 不得为空串')
    if (c.type === 'block-end' && c.block?.type === 'text') {
      assert.notEqual(String(c.block.text ?? '').trim(), '', 'block-end 不得携带空正文')
    }
  }

  /* reasoning 与 finish 照常，流结构不破 */
  assert.ok(out.some((c) => c.type === 'block-end' && c.block?.type === 'reasoning'))
  assert.ok(out.some((c) => c.type === 'finish'))
})

test('正常正文不受影响（不被误伤）', async () => {
  const handler = mount({ egressThinking: true, egressScope: 'all' })
  const out = await run(handler, [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '我在心里琢磨一些事情。' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '这是真正的回答正文。' },
    { type: 'block-end', index: 1, block: { type: 'text', text: '这是真正的回答正文。' } },
    { type: 'finish', reason: { kind: 'stop' } }
  ])
  const texts = out.filter((c) => c.type === 'block-end' && c.block?.type === 'text').map((c) => c.block.text)
  assert.deepEqual(texts, ['这是真正的回答正文。'])
})

test('丢弃是可观测的：emptyTextDropped 递增，不静默', async () => {
  const handler = mount({ egressThinking: true, egressScope: 'all' })
  const before = egressStats.emptyTextDropped
  const t = '同一段思考被写进正文。'
  await run(handler, [
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: t } },
    { type: 'block-end', index: 1, block: { type: 'text', text: t } },
    { type: 'finish', reason: { kind: 'stop' } }
  ])
  assert.ok(egressStats.emptyTextDropped > before, 'emptyTextDropped 应递增')
})

/* ───────────────────────── 请求侧：空正文 user 消息过滤 ─────────────────────────
 * 这是针对「已落盘历史」的防线：修复流层只能防新的空块，
 * 但 session-fe050e0a 那条 seq=91 的空消息已经在文件里了，
 * 不改会话文件也要能让该会话恢复可用。
 */

/** 收集 handler 实际传给下游的 options（用于断言 messages 被改成什么）。 */
async function runCapturing(handler, chunks, options) {
  let captured
  const next = () => { captured = options; return scripted(chunks)(options) }
  for await (const _ of handler(options, next)) { /* drain */ }
  return captured
}

test('空正文 user 消息在发请求前被剔除（已落盘历史同样生效）', async () => {
  const handler = mount({ egressScope: 'all' })
  const options = {
    messages: [
      { role: 'user', content: '第一条真实提问' },
      { role: 'assistant', content: '回答' },
      /* 现场原样复刻：记忆召回快照在无命中时写入的空消息 */
      { role: 'user', content: [{ type: 'text', text: '' }] },
      { role: 'user', content: '我要继续问' }
    ]
  }
  const after = await runCapturing(handler, [{ type: 'finish', reason: { kind: 'stop' } }], options)
  const roles = after.messages.map((m) => m.role)
  assert.deepEqual(roles, ['user', 'assistant', 'user'], '空 user 消息应被剔除')
  assert.equal(after.messages.at(-1).content, '我要继续问', '真实提问必须保留')
})

test('content 为空字符串的 user 消息也被剔除', async () => {
  const handler = mount({ egressScope: 'all' })
  const options = {
    messages: [
      { role: 'user', content: '' },
      { role: 'user', content: '真问题' }
    ]
  }
  const after = await runCapturing(handler, [{ type: 'finish', reason: { kind: 'stop' } }], options)
  assert.equal(after.messages.length, 1)
  assert.equal(after.messages[0].content, '真问题')
})

test('不误伤：纯空格历史、带非 text 块、assistant 空消息一律保留', async () => {
  const handler = mount({ egressScope: 'all' })
  const options = {
    messages: [
      /* 纯空格：上游接受（实测 200），不是 400 源，保持原样 */
      { role: 'user', content: '   ' },
      /* 带附件/图片块：不是空消息 */
      { role: 'user', content: [{ type: 'file', receiptId: 'r1' }] },
      /* assistant 的空结构另有语义，不在本次过滤范围 */
      { role: 'assistant', content: '' },
      { role: 'user', content: '收尾提问' }
    ]
  }
  const after = await runCapturing(handler, [{ type: 'finish', reason: { kind: 'stop' } }], options)
  assert.equal(after.messages.length, 4, '四类边界消息都不应被删')
})

test('全是空消息时不清空（fail-open，避免发出空请求）', async () => {
  const handler = mount({ egressScope: 'all' })
  const options = { messages: [{ role: 'user', content: '' }] }
  const after = await runCapturing(handler, [{ type: 'finish', reason: { kind: 'stop' } }], options)
  assert.equal(after.messages.length, 1, '剔完为空则保留原样，绝不发空请求')
})
