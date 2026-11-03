// 工具孤儿修复测试（2026-10-23，session-f3bc4fd2 实证伤型）
// 伤型：真删除把 assistant/message 的 content 清空、stream 幸存 → tool/call 变
//       「无宣告孤儿」→ 宿主拒载 "has no advertised tool lifecycle"。
// 修法：content === BlockAssembler(stream).blocks()，零编造重组。
import test from 'node:test'
import assert from 'node:assert/strict'
import { scanToolOrphans, healToolOrphans, __repairDebug } from '../repair.js'
import { verify } from '../true-delete.js'

const { expandStreamRecords, assembleBlocks } = __repairDebug

/* ── 测试夹具：一条最小合法会话 ─────────────────────────────── */
const header = { id: 'session-test-orphan', version: 4, createdAt: 1792600000000, cwd: 'C:\\t', isSeeded: false, delegationDepth: 0 }

/** 健康的 assistant/message 事件（带完整流）。 */
function healthyAssistant(seq, turn, step, callId) {
  return {
    type: 'assistant/message', seq, time: 1792600000000 + seq, surfaceOp: 'append',
    data: {
      turn, step,
      message: {
        id: 'msg-' + seq, role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{"file_path":"C:\\a"}' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      stream: [
        { type: 'chunk', time: 1, chunk: { type: 'block-start', index: 0, blockType: 'tool-call' } },
        { type: 'tool-call-chunks', time0: 1, index: 0, dt: [0], id: callId, name: 'read', args: ['{"file_path":"C:\\a"}'] },
        { type: 'chunk', time: 2, chunk: { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'read', arguments: '{"file_path":"C:\\a"}' } } },
        { type: 'chunk', time: 3, chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } },
        { type: 'chunk', time: 4, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } },
      ],
    },
  }
}

/** 伤型：content 被清空（真删除干的好事）。 */
function orphanedAssistant(seq, turn, step, callId) {
  const ev = healthyAssistant(seq, turn, step, callId)
  ev.data.message.content = []
  return ev
}

function toolCall(seq, turn, step, callId) {
  return { type: 'tool/call', seq, time: 1792600000000 + seq, data: { turn, step, callId, name: 'read', arguments: '{"file_path":"C:\\a"}' } }
}

function toolResult(seq, turn, step, callId) {
  return {
    type: 'tool/result', seq, time: 1792600000000 + seq, surfaceOp: 'append',
    data: {
      turn, step,
      message: {
        id: 'tr-' + seq, role: 'tool', toolCallId: callId,
        source: { kind: 'tool', callId },
        content: [{ type: 'text', text: 'ok' }], isError: false,
      },
    },
  }
}

test('scanToolOrphans：健康会话 → 0 孤儿 0 空 content', () => {
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
    healthyAssistant(2, 1, 1, 'call_01'),
    toolCall(3, 1, 1, 'call_01'),
    toolResult(4, 1, 1, 'call_01'),
    { type: 'step/end', seq: 5, time: 1, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 6, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const scan = scanToolOrphans(events)
  assert.equal(scan.orphans, 0)
  assert.equal(scan.emptyAssistant, 0)
})

test('scanToolOrphans：content 被清空 → 孤儿 + 空 content 各计数', () => {
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
    orphanedAssistant(2, 1, 1, 'call_01'),
    toolCall(3, 1, 1, 'call_01'),
    toolResult(4, 1, 1, 'call_01'),
    { type: 'step/end', seq: 5, time: 1, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 6, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const scan = scanToolOrphans(events)
  assert.equal(scan.orphans, 1)
  assert.equal(scan.emptyAssistant, 1)
  assert.equal(scan.callIds[0], 'call_01')
})

test('healToolOrphans：从幸存 stream 重组 content，孤儿归零，verify 过', () => {
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
    orphanedAssistant(2, 1, 1, 'call_01'),
    toolCall(3, 1, 1, 'call_01'),
    toolResult(4, 1, 1, 'call_01'),
    { type: 'step/end', seq: 5, time: 1, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 6, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const fix = healToolOrphans(events)
  assert.notEqual(fix.events, null)
  assert.equal(fix.healed.length, 1)
  assert.equal(fix.healed[0].seq, 2)
  assert.equal(fix.healed[0].blocks, 1)
  /* 重组出的 content 与原事件的块完全一致（零编造）。 */
  const restored = fix.events[2].data.message.content
  assert.equal(restored.length, 1)
  assert.equal(restored[0].type, 'tool-call')
  assert.equal(restored[0].id, 'call_01')
  assert.equal(restored[0].name, 'read')
  /* 孤儿归零 + 宿主级 verify 全绿。 */
  assert.equal(scanToolOrphans(fix.events).orphans, 0)
  assert.equal(verify(header, fix.events).ok, true)
})

test('healToolOrphans：content 与 stream 双空 → 不动手，如实报告', () => {
  const ev = orphanedAssistant(2, 1, 1, 'call_01')
  ev.data.stream = []
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
    ev,
    { type: 'step/end', seq: 5, time: 1, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 6, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const fix = healToolOrphans(events)
  assert.equal(fix.events, null)
  assert.equal(fix.unrepairable.length, 1)
  assert.match(fix.unrepairable[0].why, /双空/)
})

test('healToolOrphans：健康行一律不碰（原对象引用保持）', () => {
  const healthy = healthyAssistant(2, 1, 1, 'call_01')
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
    healthy,
    toolCall(3, 1, 1, 'call_01'),
    toolResult(4, 1, 1, 'call_01'),
    { type: 'step/end', seq: 5, time: 1, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 6, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const fix = healToolOrphans(events)
  /* 没有要修的 → events 为 null（调用方按原样处理），健康数组原封不动。 */
  assert.equal(fix.events, null)
  assert.equal(fix.healed.length, 0)
  assert.equal(healthy.data.message.content.length, 1)
})

test('expandStreamRecords / assembleBlocks：block-end 成品块优先', () => {
  const stream = [
    { type: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
    { type: 'reasoning-chunks', time0: 1, index: 0, dt: [0], texts: ['思考'] },
    { type: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: '思考完整' } } },
    { type: 'chunk', chunk: { type: 'block-start', index: 1, blockType: 'tool-call' } },
    { type: 'tool-call-chunks', time0: 2, index: 1, dt: [0], id: 'c9', name: 'pwsh', args: ['{}'] },
    { type: 'chunk', chunk: { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'c9', name: 'pwsh', arguments: '{}' } } },
    { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'tool-calls' } } },
  ]
  const chunks = expandStreamRecords(stream)
  assert.notEqual(chunks, null)
  const blocks = assembleBlocks(chunks)
  assert.notEqual(blocks, null)
  assert.equal(blocks.length, 2)
  /* block-end 的成品块原样胜出（宿主同款语义）。 */
  assert.deepEqual(blocks[0], { type: 'reasoning', text: '思考完整' })
  assert.deepEqual(blocks[1], { type: 'tool-call', id: 'c9', name: 'pwsh', arguments: '{}' })
})

test('assembleBlocks：没有 block-end 时退回 delta 累加', () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '你好' },
    { type: 'text-delta', index: 0, text: '世界' },
  ]
  const blocks = assembleBlocks(chunks)
  assert.deepEqual(blocks, [{ type: 'text', text: '你好世界' }])
})

test('assembleBlocks：块外的孤儿 delta → 放弃（返回 null）', () => {
  assert.equal(assembleBlocks([{ type: 'text-delta', index: 0, text: 'x' }]), null)
})
