import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WIRE_PLACEHOLDER, repairWireRequest, healBlankToolResults, repairToolCallBlock } from '../wire-tap.js'
import { SLIM_PLACEHOLDER, slimEvent } from '../slim.js'
import { redactEventPayload } from '../purge.js'

const cleared = '[内容已清除]'
const event = (content) => ({ seq: 12, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content }, meta: { callId: 'c1' } } })

test('统一有意义的清除标记：瘦身、墓碑清除、盘上修复和请求修复', () => {
  assert.equal(WIRE_PLACEHOLDER, cleared)
  assert.equal(SLIM_PLACEHOLDER, cleared)
  const original = event([{ type: 'text', text: 'original output' }])
  const before = structuredClone(original)
  for (const fix of [slimEvent, redactEventPayload]) {
    const out = fix(original)
    assert.equal(out.data.message.content[0].text, cleared)
    assert.equal(out.data.message.toolCallId, 'c1')
    assert.deepEqual(out.data.meta, original.data.meta)
    assert.equal(fix(out).data.message.content[0].text, cleared, '重复清除仍保留占位')
  }
  assert.deepEqual(original, before, '不改输入')
  const healed = healBlankToolResults([event([])])
  assert.equal(healed.events[0].data.message.content[0].text, cleared)
  assert.equal(healBlankToolResults(healed.events).alreadyHealthy, true)
  const options = { messages: [Object.freeze({ role: 'tool', toolCallId: 'c1', content: [] })] }
  assert.equal(repairWireRequest(options), 1)
  assert.equal(options.messages[0].content[0].text, cleared)
  assert.equal(repairWireRequest(options), 0)
})

test('非空真实工具输出不被修复器当占位覆盖（包括旧版 NaN）', () => {
  for (const text of ['actual result', '[NaN]', cleared]) {
    const original = event([{ type: 'text', text }])
    assert.equal(healBlankToolResults([original]).events[0], original)
    const options = { messages: [original.data.message] }
    assert.equal(repairWireRequest(options), 0)
    assert.equal(options.messages[0].content[0].text, text)
  }
})

test('缺失工具名使用协议标识符而不是正文清除标记', () => {
  const fixed = repairToolCallBlock({ type: 'tool-call', id: 'c1', arguments: '{}' })
  assert.equal(fixed.name, 'unknown_tool')
  assert.match(fixed.name, /^[a-zA-Z0-9_-]+$/)
  assert.equal(fixed.id, 'c1')
  assert.equal(fixed.arguments, '{}')
})
