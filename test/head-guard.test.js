/**
 * head-guard 测试：受保护系统头的诊断 / 补齐 / 落盘复核。
 *
 * 背景：宿主 foldSurface 只认「首个 append 到空表层的 system/message」；缺了它，
 * 日志当下还能读，但下一轮提示词一变就会被写成永久打不开的文件。
 * 这里用最小合成会话（能过 true-delete.verify）复现「无头但合法」与
 * 「迟到 system → 宿主拒载」两种状态，验证补齐后的结构。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readSession, writeSession, verify, lateSystemAppends, excise } from '../true-delete.js'
import { diagnoseProtectedHead, insertProtectedHead, guardSessionFile, probeProtectedHead } from '../head-guard.js'

const header = () => ({
  type: 'session',
  version: 4,
  id: 'session-headguard-test',
  createdAt: 1790000000000,
  isSeeded: false,
  delegationDepth: 0,
})

const userMessage = (id, text) => ({
  content: [{ type: 'text', text }],
  source: { kind: 'user', rpcId: id, clientTimeZone: 'Asia/Shanghai' },
  role: 'user',
  id,
})

const systemMessage = (id, text) => ({
  role: 'system',
  content: text === '' ? [] : [{ type: 'text', text }],
  source: { kind: 'system-prompt' },
  id,
})

/** 无头但合法的最小会话：首个表面节点是 user/message。 */
function headlessEvents() {
  return [
    { type: 'permission/preset', seq: 0, time: 1, data: { preset: 'danger-full-access' } },
    { type: 'sandbox/mode', seq: 1, time: 2, data: { mode: 'workspace-write' } },
    { type: 'turn/start', seq: 2, time: 3, data: { turn: 1 } },
    { type: 'step/start', seq: 3, time: 4, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 4, time: 5, data: userMessage('msg-1', '你好'), surfaceOp: 'append' },
    { type: 'request/header', seq: 5, time: 6, data: { header: { config: { provider: 'deepseek-web', model: 'deepseek-flash' } }, reason: 'initial' } },
    { type: 'assistant/message', seq: 6, time: 7, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '你好' }], source: { kind: 'model' }, id: 'asst-1' } }, surfaceOp: 'append' },
    { type: 'step/end', seq: 7, time: 8, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 8, time: 9, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/** 有头（首个表面节点就是 system/message）。 */
function headedEvents() {
  const events = headlessEvents()
  events.splice(4, 0, { type: 'system/message', seq: 4, time: 5, data: { turn: 1, step: 1, message: systemMessage('sys-1', 'You are…') }, surfaceOp: 'append' })
  return events.map((e, i) => ({ ...e, seq: i }))
}

test('无头会话能被诊断出来（含宿主的拒绝点）', () => {
  const d = diagnoseProtectedHead(headlessEvents())
  assert.equal(d.ok, false)
  assert.equal(d.reason, 'head-missing')
  assert.equal(d.insertAt, 4)
  assert.equal(d.firstSurface.type, 'user/message')
  // 有头会话不该被误判
  assert.equal(diagnoseProtectedHead(headedEvents()).ok, true)
})

test('迟到 system（宿主硬拒）也能被诊断出来', () => {
  const events = headlessEvents()
  events.splice(5, 0, { type: 'system/message', seq: 5, time: 6, data: { turn: 1, step: 1, message: systemMessage('sys-late', 'late') }, surfaceOp: 'append' })
  const slotted = events.map((e, i) => ({ ...e, seq: i }))
  const v = verify(header(), slotted)
  assert.equal(v.ok, false, '宿主规则移植版应当拒收迟到 system')
  assert.ok(v.problems.some((p) => p.includes('受保护系统头')), v.problems.join(';'))
  const d = diagnoseProtectedHead(slotted)
  assert.equal(d.ok, false)
  assert.equal(d.reason, 'head-missing+illegal-append')
  assert.equal(d.illegalSeq, 5)
})

test('补头后 seq 密集、头是空 system、被拒日志变合法（且不删任何事件）', () => {
  const events = headlessEvents()
  events.splice(5, 0, { type: 'system/message', seq: 5, time: 6, data: { turn: 1, step: 1, message: systemMessage('sys-late', 'late') }, surfaceOp: 'append' })
  const slotted = events.map((e, i) => ({ ...e, seq: i }))
  const fixed = insertProtectedHead(slotted)
  assert.equal(fixed.length, slotted.length + 1, '只插一条，不删任何事件')
  assert.ok(fixed.every((e, i) => e.seq === i), 'seq 必须自 0 密集')
  assert.equal(fixed[4].type, 'system/message')
  assert.equal(fixed[4].surfaceOp, 'append')
  assert.equal(fixed[4].data.message.role, 'system')
  assert.deepEqual(fixed[4].data.message.content, [], '占位头用空 content（宿主下一轮会替换）')
  assert.equal(fixed[4].data.turn, 1)
  assert.equal(fixed[4].data.step, 1)
  // 迟到的 system 仍在原位（被保留，只是后移一位）
  assert.equal(fixed[6].data.message.id, 'sys-late')
  const v = verify(header(), fixed)
  assert.equal(v.ok, true, v.problems?.join('; '))
  assert.equal(v.stats.systemHead, 4)
})

test('已有受保护头时是空操作（不重编号、不新增）', () => {
  const events = headedEvents()
  const d = diagnoseProtectedHead(events)
  assert.equal(d.ok, true)
  assert.equal(insertProtectedHead(events, d), events, '应原样返回同一个数组')
})

test('seq 引用按 SEQ_REF_RULES 整体 +1（不碰 data.start / schema 同名字段）', () => {
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    { type: 'agent/inbox/spliced', seq: 2, time: 3, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    { type: 'user/message', seq: 3, time: 4, data: userMessage('msg-1', 'hi'), surfaceOp: 'append' },
    {
      type: 'user/message',
      seq: 4,
      time: 5,
      data: { ...userMessage('msg-2', 'compact checkpoint'), source: { kind: 'compact-checkpoint' }, shadowedRange: { start: 3, end: 3 }, shadowedSeqs: [3], sourceEventSeq: 3, headerSeq: 3, messageSeqs: [3], throughSeq: 0 },
      surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 },
      sourceEventSeqs: [3, [3, 4]],
    },
  ]
  const fixed = insertProtectedHead(events)
  const moved = fixed[5]
  assert.deepEqual(moved.surfaceOp, { op: 'replace', startSeq: 4, endSeq: 4 })
  assert.deepEqual(moved.sourceEventSeqs, [4, [4, 5]])
  assert.deepEqual(moved.data.shadowedRange, { start: 4, end: 4 })
  assert.deepEqual(moved.data.shadowedSeqs, [4])
  assert.equal(moved.data.sourceEventSeq, 4)
  assert.equal(moved.data.headerSeq, 4)
  assert.deepEqual(moved.data.messageSeqs, [4])
  assert.equal(moved.data.throughSeq, 0, '水位线比插入点小 → 不动')
  // inbox splice 的 start 是队列下标，不是 seq —— 绝不能被改
  assert.equal(fixed[2].data.start, 0)
  assert.equal(fixed[2].type, 'agent/inbox/spliced')
})

test('probeProtectedHead：只读文件前缀就能判定（不用整文件读）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'headguard-probe-'))
  const headless = join(dir, 'headless.zstd')
  const headed = join(dir, 'headed.zstd')
  writeSession(headless, header(), headlessEvents())
  writeSession(headed, header(), headedEvents())
  const a = probeProtectedHead(headless)
  assert.equal(a.ok, false)
  assert.equal(a.insertAt, 4)
  assert.equal(probeProtectedHead(headed).ok, true)
  assert.equal(probeProtectedHead(join(dir, 'nope.zstd')), undefined)
})

test('lateSystemAppends：只认「表层非空且还没有受保护头」时的 append', () => {
  const late = headlessEvents()
  late.splice(5, 0, { type: 'system/message', seq: 5, time: 6, data: { turn: 1, step: 1, message: systemMessage('sys-late', 'late') }, surfaceOp: 'append' })
  assert.deepEqual(lateSystemAppends(late.map((e, i) => ({ ...e, seq: i }))), [5])
  // 有受保护头时，后置 system append 完全合法 —— 不许误报
  const headed = headedEvents()
  headed.splice(6, 0, { type: 'system/message', seq: 6, time: 7, data: { turn: 1, step: 1, message: systemMessage('sys-2', 'later') }, surfaceOp: 'append' })
  assert.deepEqual(lateSystemAppends(headed.map((e, i) => ({ ...e, seq: i }))), [])
})

test('excise 的系统头级联不再「删光全部 system」：受保护头与合法 append 都留下', () => {
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    { type: 'system/message', seq: 2, time: 3, data: { turn: 1, step: 1, message: systemMessage('sys-head', 'head') }, surfaceOp: 'append' },
    { type: 'user/message', seq: 3, time: 4, data: userMessage('msg-1', 'hi'), surfaceOp: 'append' },
    { type: 'system/message', seq: 4, time: 5, data: { turn: 1, step: 1, message: systemMessage('sys-2', 'later') }, surfaceOp: 'append' },
    { type: 'system/message', seq: 5, time: 6, data: { turn: 1, step: 1, message: systemMessage('sys-3', 'rewrite') }, surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 }, sourceEventSeqs: [4] },
    { type: 'step/end', seq: 6, time: 7, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 7, time: 8, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  assert.equal(verify(header(), events).ok, true, '输入本身必须合法')
  // 只摘掉那条替换载体：旧版会把 2/4/5 全删（头没了、替身也没了）
  const result = excise(header(), events, [5])
  const types = result.events.filter((e) => e.type === 'system/message').map((e) => e.data.message.id)
  assert.deepEqual(types, ['sys-head', 'sys-2'], '受保护头与合法 append 必须留下')
  const v = verify(result.header, result.events)
  assert.equal(v.ok, true, v.problems?.join('; '))
  assert.equal(v.stats.systemHead, 2)
})

test('guardSessionFile：写盘前复核，写盘后回读，二次运行是 clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'headguard-'))
  const file = join(dir, 'session.v4.jsonl.zstd')
  const backupDir = join(dir, 'backup')
  writeSession(file, header(), headlessEvents())

  const dry = guardSessionFile(file)
  assert.equal(dry.status, 'planned', JSON.stringify(dry))
  assert.equal(readSession(file).events.length, 9, '干跑不得动文件')

  const done = guardSessionFile(file, { write: true, backupDir })
  assert.equal(done.status, 'written', JSON.stringify(done))
  assert.ok(existsSync(join(backupDir, 'session-headguard-test.headless.zstd')), '必须先留备份')

  const back = readSession(file)
  const v = verify(back.header, back.events)
  assert.equal(v.ok, true, v.problems?.join('; '))
  assert.equal(v.stats.systemHead, 4)
  assert.ok(readFileSync(file).length > 0)

  const again = guardSessionFile(file, { write: true, backupDir })
  assert.equal(again.status, 'clean')
})
