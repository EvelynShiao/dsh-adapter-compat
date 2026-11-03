// A线+F线测试：slim keepTurns/digest、自动瘦身选项、子代理判据（2026-10-24）
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { slimSession, digestOf, SLIM_PLACEHOLDER } from '../slim.js'
import { scanSubagentSessions } from '../index.js'
import { writeSession, verify } from '../true-delete.js'

const tmp = mkdtempSync(join(tmpdir(), 'slim-turns-'))

/** 造一个 3 轮会话：每轮 1 条长工具结果。 */
function makeEvents() {
  const events = []
  let seq = 0
  const push = (e) => { events.push({ seq: seq++, time: 1792600000000 + seq, ...e }) }
  push({ type: 'session/end-seed', data: { inherited: true } })
  for (let turn = 1; turn <= 3; turn++) {
    push({ type: 'turn/start', data: { turn } })
    push({ type: 'step/start', data: { turn, step: 1 } })
    push({ type: 'user/message', surfaceOp: 'append', data: { turn, step: 1, message: { id: 'u' + turn, role: 'user', content: [{ type: 'text', text: '问 ' + turn }], source: { kind: 'user' } } } })
    push({ type: 'assistant/message', surfaceOp: 'append', data: { turn, step: 1, message: { id: 'a' + turn, role: 'assistant', content: [{ type: 'tool-call', id: 'c' + turn, name: 'read', arguments: '{}' }], source: { kind: 'model', provider: 'p', model: 'm' } } } })
    push({ type: 'tool/call', data: { turn, step: 1, callId: 'c' + turn, name: 'read', arguments: '{}' } })
    push({ type: 'tool/result', surfaceOp: 'append', data: { turn, step: 1, message: { id: 't' + turn, role: 'tool', toolCallId: 'c' + turn, source: { kind: 'tool', callId: 'c' + turn }, content: [{ type: 'text', text: '第一行输出\n第二行输出\n第三行输出' + 'x'.repeat(200) }], isError: false } } })
    push({ type: 'step/end', data: { turn, step: 1 } })
    push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  return events
}

const header = { id: 'session-slim-test', version: 4, createdAt: 1792600000000, cwd: 'C:\\t', isSeeded: false, delegationDepth: 0 }
const file = join(tmp, 'session.v4.jsonl.zstd')
writeSession(file, header, makeEvents())

test('slimSession 原行为：无参全量瘦，tool 结果变占位', () => {
  const r = slimSession(file)
  assert.equal(r.ok, true)
  assert.ok(r.saved > 0)
  const toolResult = r.slimmed.find((e) => e.type === 'tool/result')
  assert.equal(toolResult.data.message.content[0].text, SLIM_PLACEHOLDER)
})

test('A线 keepTurns=1：最近一轮原文保留，更早的瘦身', () => {
  const r = slimSession(file, { keepTurns: 1 })
  assert.equal(r.ok, true)
  /* turn 3 的 tool 结果保留原文 */
  const last = r.slimmed.filter((e) => e.type === 'tool/result').at(-1)
  assert.ok(last.data.message.content[0].text.includes('第三行输出'))
  /* turn 1 的被瘦身 */
  const first = r.slimmed.filter((e) => e.type === 'tool/result')[0]
  assert.ok(!first.data.message.content[0].text.includes('第一行输出'))
  assert.ok(r.saved > 0)
  /* keptTurns 回显 */
  assert.equal(r.keptTurns, 1)
})

test('A线 keepTurns 大于总轮数：一条都不瘦', () => {
  const r = slimSession(file, { keepTurns: 99 })
  assert.equal(r.ok, true)
  assert.equal(r.saved, 0)
})

test('A线 digest：占位带前两行摘要与字数', () => {
  const r = slimSession(file, { digest: true })
  assert.equal(r.ok, true)
  const first = r.slimmed.filter((e) => e.type === 'tool/result')[0]
  const text = first.data.message.content[0].text
  assert.ok(text.includes('内容已清除'), '应带清除标记')
  assert.ok(text.includes('第一行输出'), '应带原文首行')
  assert.ok(text.includes('第二行输出'), '应带原文次行')
  assert.ok(!text.includes('第三行输出'), '只保留前两行')
})

test('A线 digest 与 keepTurns 组合：保留轮原文、其余带摘要', () => {
  const r = slimSession(file, { keepTurns: 1, digest: true })
  assert.equal(r.ok, true)
  const results = r.slimmed.filter((e) => e.type === 'tool/result')
  assert.ok(results[0].data.message.content[0].text.includes('第一行输出'))
  assert.ok(results.at(-1).data.message.content[0].text.includes('第三行输出'))
  /* verify 依然全绿（占位结构合法） */
  assert.equal(verify(header, r.slimmed).ok, true)
})

test('digestOf：空文返回纯占位；两行内取全', () => {
  assert.equal(digestOf(''), SLIM_PLACEHOLDER)
  const one = digestOf('单行')
  assert.ok(one.includes('单行'))
  const two = digestOf('行一\n行二\n行三')
  assert.ok(two.includes('行一') && two.includes('行二') && !two.includes('行三'))
})
