import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slimEvent, SLIM_TYPES, scrubTexts, slimSession } from '../slim.js'

test('slimEvent: assistant/message 清 reasoning 块、保留 text 回复与 tool-call 块', () => {
  const ev = {
    seq: 18, type: 'assistant/message',
    data: {
      turn: 1, step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'x'.repeat(400) },
          { type: 'text', text: '这是回复' },
          { type: 'tool-call', callId: 'call_1', name: 'bash' },
        ],
      },
      stream: [{ type: 'chunk', texts: { 0: '推理文本', 1: '回复文本' } }],
    },
  }
  const out = slimEvent(ev)
  const blocks = out.data.message.content
  assert.equal(blocks[0].type, 'reasoning')
  assert.equal(blocks[0].text, '', 'reasoning 块正文应清空')
  assert.equal(blocks[1].text, '这是回复', 'text 回复块应保留')
  assert.equal(blocks[2].callId, 'call_1', 'tool-call 块结构应保留')
  assert.equal(out.data.stream[0].texts[0], '', 'stream 推理文本应清空')
  assert.equal(out.data.stream[0].texts[1], '', 'stream 回复文本也清（content 里保留即可）')
  // 入参不被改
  assert.ok(ev.data.message.content[0].text.length === 400, '原事件不应被改（纯函数）')
})

test('slimEvent: tool/result 清空 content/result/output', () => {
  const ev = { seq: 20, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', content: [{ type: 'text', text: 'y'.repeat(900) }] }, result: 'zzz', output: 'ooo' } }
  const out = slimEvent(ev)
  assert.equal(out.data.message.content[0].text, '', 'tool 输出应清空')
  assert.equal(out.data.result, '')
  assert.equal(out.data.output, '')
})

test('slimEvent: tool/call 不碰（arguments 必须与宣告一致）', () => {
  const ev = { seq: 19, type: 'tool/call', data: { turn: 1, step: 1, callId: 'call_1', name: 'bash', arguments: '{"command":"ls"}' } }
  const out = slimEvent(ev)
  assert.equal(out.data.arguments, '{"command":"ls"}', 'tool/call arguments 应原样保留')
  assert.ok(!SLIM_TYPES.has('tool/call'), 'tool/call 不在瘦身类型里')
})

test('slimEvent: user/message 原样不动', () => {
  const ev = { seq: 5, type: 'user/message', data: { content: [{ type: 'text', text: '你的话' }] } }
  const out = slimEvent(ev)
  assert.equal(out.data.content[0].text, '你的话')
})

test('scrubTexts: 按 key 递归擦字符串、保结构', () => {
  const node = { stream: [{ texts: { 0: 'a', 1: 'b' } }, { chunk: 'c' }], keep: { id: 'id_1', role: 'assistant' } }
  scrubTexts(node)
  assert.equal(node.stream[0].texts[0], '')
  assert.equal(node.stream[0].texts[1], '')
  assert.equal(node.stream[1].chunk, 'c', 'chunk 不是文本键，应保留（真实结构里推理/回复在 texts）')
  assert.equal(node.keep.id, 'id_1', '结构性字符串(id/role)不碰')
  assert.equal(node.keep.role, 'assistant')
})
