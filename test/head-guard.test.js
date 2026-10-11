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
import { mkdtempSync, existsSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readSession, writeSession, verify, lateSystemAppends, excise } from '../true-delete.js'
import { diagnoseProtectedHead, insertProtectedHead, guardSessionFile, probeProtectedHead, repairToolResultRewrites } from '../head-guard.js'
import { redactEventPayload } from '../purge.js'
import { guardProtectedHeads, installHeadGuard } from '../index.js'

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

/** 造一份含「tool/result 替换」的会话：原事件带 meta.lines，替换体只该改 content。 */
function rewriteFixture({ scrubReplacementMeta = false } = {}) {
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: 2, time: 3, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'read', arguments: '{}' }], source: { kind: 'model' }, id: 'asst-1' } }, surfaceOp: 'append' },
    { type: 'tool/call', seq: 3, time: 4, data: { turn: 1, step: 1, callId: 'call_1', name: 'read', arguments: '{}' } },
    {
      type: 'tool/result',
      seq: 4,
      time: 5,
      data: {
        turn: 1,
        step: 1,
        message: { role: 'tool', source: { kind: 'tool', callId: 'call_1' }, toolCallId: 'call_1', content: [{ type: 'text', text: '原始 40 行文件内容' }], isError: false, id: 'res-1' },
        meta: { path: 'C:/x/y.jsonl', offset: 1, lines: [{ number: 1, text: '{"type":"session"}' }, { number: 2, text: '{"type":"turn/start"}' }] },
      },
      surfaceOp: 'append',
    },
    { type: 'step/end', seq: 5, time: 6, data: { turn: 1, step: 1 } },
  ]
  // 剪枝替换体：只改 content（合法）
  const replacement = {
    type: 'tool/result',
    seq: 6,
    time: 7,
    data: {
      ...events[4].data,
      message: { ...events[4].data.message, content: [{ type: 'text', text: '[已剪枝]' }] },
    },
    surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 },
    sourceEventSeqs: [4],
  }
  // 复现「历史遗留伤」：替换体的 meta 被旧版深度擦文本器清空（与 prevention 测试分开写，
  // 免得哪天 redact 修好了这条用例就失去意义）
  if (scrubReplacementMeta) {
    replacement.data = {
      ...replacement.data,
      meta: { ...replacement.data.meta, lines: replacement.data.meta.lines.map((l) => ({ ...l, text: '' })) },
    }
  }
  events.push(replacement)
  events.push({ type: 'turn/end', seq: 7, time: 8, data: { turn: 1, reason: { kind: 'completed' } } })
  return events
}

test('根因回归：redactEventPayload 不许碰 meta（它只该擦正文）', () => {
  const events = rewriteFixture()
  const before = structuredClone(events[6])
  const after = redactEventPayload(before)
  assert.deepEqual(after.data.meta, events[6].data.meta, 'meta 必须原样保留（宿主拿它比对替换体）')
  assert.notDeepEqual(after.data.message.content, events[6].data.message.content, '正文该擦还是要擦')
  assert.ok(before.data.meta.lines[0].text.length > 0, '擦除不得原地改坏入参的 meta')
})

test('tool/result 替换改到 content 之外的字段：verify 必须拒收，guard 必须能修', () => {
  const broken = rewriteFixture({ scrubReplacementMeta: true })
  const v = verify(header(), broken)
  assert.equal(v.ok, false, '宿主规则移植版必须拒收（这正是重开时那句 invalid seed event）')
  assert.ok(v.problems.some((p) => p.includes('surface replacement may change only content')), v.problems.join('; '))

  const { events: fixed, repaired } = repairToolResultRewrites(broken)
  assert.equal(repaired, 1)
  const v2 = verify(header(), fixed)
  assert.equal(v2.ok, true, v2.problems?.join('; '))
  assert.deepEqual(fixed[6].data.meta, broken[4].data.meta, '替换体 meta 对齐到被遮蔽原事件')
  assert.deepEqual(fixed[6].data.message.content, broken[6].data.message.content, '替换体的剪枝正文保留（省上下文收益不变）')
})

test('guardSessionFile：这一整类伤能自动治好并写盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'headguard-rewrite-'))
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeSession(file, header(), rewriteFixture({ scrubReplacementMeta: true }))
  const r = guardSessionFile(file, { write: true, backupDir: join(dir, 'backup'), deep: true })
  assert.equal(r.status, 'written', JSON.stringify(r))
  assert.equal(r.rewritesAligned, 1)
  const back = readSession(file)
  assert.equal(verify(back.header, back.events).ok, true)
  assert.deepEqual(back.events[6].data.meta, back.events[4].data.meta)
})

test('guardSessionFile：同段写了两遍（seq 断口）也能自动去重修好', () => {
  const dir = mkdtempSync(join(tmpdir(), 'headguard-dup-'))
  const file = join(dir, 'session.v4.jsonl.zstd')
  const base = headedEvents()
  // 把 [4,5] 两行原地重复一遍（下载/写盘重试的痕迹）：seq 回跳 → 宿主判 seq gap
  const dup = [...base.slice(0, 6), ...base.slice(4, 6), ...base.slice(6)]
  writeSession(file, header(), dup)
  assert.equal(verify(header(), dup).ok, false, '重复块必须让宿主校验失败（seq 断口）')
  const r = guardSessionFile(file, { write: true, backupDir: join(dir, 'backup'), deep: true })
  assert.equal(r.status, 'written', JSON.stringify(r))
  assert.ok(r.deduped, '应报告去过重复块')
  const back = readSession(file)
  assert.ok(back.events.every((e, i) => e.seq === i), 'seq 必须重新密集')
  assert.equal(back.events.length, base.length, '只应丢掉重复的那一份')
  const v = verify(back.header, back.events)
  assert.equal(v.ok, true, v.problems?.join('; '))
})

test('guardSessionFile：不是「重复块 / 缺头」的坏文件一律不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'headguard-other-'))
  const file = join(dir, 'session.v4.jsonl.zstd')
  const events = headedEvents()
  events[4].data.message.content = 'not-an-array' // 结构坏，但不是本层能治的病
  writeSession(file, header(), events)
  const before = readFileSync(file)
  const r = guardSessionFile(file, { write: true, backupDir: join(dir, 'backup'), deep: true })
  assert.notEqual(r.status, 'written')
  assert.deepEqual(readFileSync(file), before, '不认识的病必须一个字节都不动')
})

test('guardProtectedHeads：缺头的补上、live 的分毫不动', async () => {
  const home = mkdtempSync(join(tmpdir(), 'headguard-home-'))
  const mk = (sid, events) => {
    const dir = join(home, 'sessions', '--ws--', sid)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.v4.jsonl.zstd')
    writeSession(file, { ...header(), id: sid }, events)
    return file
  }
  const headlessFile = mk('session-headless', headlessEvents())
  const headedFile = mk('session-headed', headedEvents())
  const headedBefore = readFileSync(headedFile)
  const ctx = {
    get: (n) => (n === 'sessions' ? { get: (id) => (id === 'session-headed' ? { id } : undefined) } : undefined),
    logger: {},
  }
  const r = await guardProtectedHeads(ctx, { home, write: true, deep: true })
  assert.equal(r.scanned, 2)
  assert.equal(r.liveSkipped, 1)
  assert.equal(r.written, 1)
  assert.equal(r.deep, true)
  const back = readSession(headlessFile)
  assert.equal(verify(back.header, back.events).stats.systemHead, 4)
  assert.deepEqual(readFileSync(headedFile), headedBefore, 'live 会话必须分毫不动')
})

test('apply 必须真的装上受保护头守卫（定义 ≠ 接线）', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(src, /installHeadGuard\(ctx, config\)/, 'apply() 没调用 installHeadGuard —— 守卫会变成死代码')
  assert.match(src, /compatHooks\.headGuard\s*=/, 'installHeadGuard 没挂 compatHooks.headGuard —— 目录变化/切除后补扫不会发生')
  assert.match(src, /compatHooks\.afterPurge/, '真删除写盘后没有定向补扫')
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
  assert.ok(existsSync(join(backupDir, 'session-headguard-test.before-headguard.zstd')), '必须先留备份')

  const back = readSession(file)
  const v = verify(back.header, back.events)
  assert.equal(v.ok, true, v.problems?.join('; '))
  assert.equal(v.stats.systemHead, 4)
  assert.ok(readFileSync(file).length > 0)

  const again = guardSessionFile(file, { write: true, backupDir })
  assert.equal(again.status, 'clean')
})
