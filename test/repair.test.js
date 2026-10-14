import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanGaps, buildInserts, repairEvents, scanFile, describeGap } from '../repair.js'
import { writeSession, verify } from '../true-delete.js'
import { repairSessionFile, repairScanAll } from '../index.js'

const HEADER = { type: 'session', version: 4, id: 'session-fixture', createdAt: 1000, cwd: '/w', isSeeded: false, delegationDepth: 0 }
const T = (n) => 2000 + n

/** 被抠除的两行（seq4 tool/result + seq5 step/end）——真实断号形态的成因。 */
const REMOVED = [
  {
    type: 'tool/result', seq: 4, time: T(4),
    data: {
      turn: 1, step: 1,
      message: {
        role: 'tool', source: { kind: 'tool', callId: 'call_A' }, toolCallId: 'call_A',
        content: [{ type: 'text', text: 'ls 输出' }], isError: false, id: 'fixed-id-1',
      },
    },
    sourceEventSeqs: [3], surfaceOp: 'append',
  },
  { type: 'step/end', seq: 5, time: T(5), data: { turn: 1, step: 1 } },
]

/** 完整合法链（基线）。 */
function fullChain() {
  return [
    { type: 'turn/start', seq: 0, time: T(0), data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: T(1), data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message', seq: 2, time: T(2),
      data: {
        turn: 1, step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '开跑' },
            { type: 'tool-call', id: 'call_A', name: 'bash', arguments: '{"command":"ls"}' },
          ],
        },
      },
      surfaceOp: 'append',
    },
    { type: 'tool/call', seq: 3, time: T(3), data: { turn: 1, step: 1, callId: 'call_A', name: 'bash', arguments: '{"command":"ls"}' } },
    ...REMOVED,
    { type: 'step/start', seq: 6, time: T(6), data: { turn: 1, step: 2 } },
    { type: 'assistant/message', seq: 7, time: T(7), data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '好了' }] } }, surfaceOp: 'append' },
    { type: 'step/end', seq: 8, time: T(8), data: { turn: 1, step: 2 } },
    { type: 'turn/end', seq: 9, time: T(9), data: { turn: 1 } },
  ]
}

/** 断号形态：抠掉 REMOVED 两行（行内 seq 保持原值 → 跳 3→6）。 */
function brokenChain() {
  return fullChain().filter((e) => e.seq !== 4 && e.seq !== 5)
}

test('基线：完整链本身过 verify（fixture 不是坏的）', () => {
  const v = verify(HEADER, fullChain())
  assert.deepEqual(v.problems, [], 'fixture 应当合法，否则测试没有意义')
  assert.equal(v.ok, true)
})

test('scanGaps：检出 seq 断号（3→6，缺 2 行）', () => {
  const gaps = scanGaps(brokenChain())
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].index, 4)
  assert.equal(gaps[0].expected, 4)
  assert.equal(gaps[0].got, 6)
  assert.equal(gaps[0].missing, 2)
  assert.equal(gaps[0].prevType, 'tool/call')
  assert.equal(gaps[0].nextType, 'step/start')
  assert.match(describeGap(gaps[0]), /seq 断号/)
})

test('R1（missing=2，tool/call 后断到 step/start）：补 [tool/result, step/end]，verify 全绿', () => {
  const broken = brokenChain()
  const plan = repairEvents(HEADER, broken)
  assert.equal(plan.unsupported.length, 0)
  assert.equal(plan.ok, true, 'verify 应全绿：' + plan.problems.join('; '))
  assert.equal(plan.fixed.length, fullChain().length)
  // seq dense
  plan.fixed.forEach((ev, i) => assert.equal(ev.seq, i, `第 ${i} 行 seq 应为 ${i}`))
  // 插入行形态
  const [tr, se] = plan.fixed.slice(4, 6)
  assert.equal(tr.type, 'tool/result')
  assert.equal(tr.data.message.toolCallId, 'call_A')
  assert.equal(tr.data.message.source.callId, 'call_A')
  assert.equal(tr.data.message.content[0].text, '[NaN]', '占位必须是 [NaN]')
  assert.equal(tr.data.turn, 1)
  assert.equal(tr.data.step, 1)
  assert.deepEqual(tr.sourceEventSeqs, [3], 'sourceEventSeqs 在顶层信封')
  assert.equal(tr.surfaceOp, 'append', 'surfaceOp 在顶层信封')
  assert.equal(se.type, 'step/end')
  assert.deepEqual(se.data, { turn: 1, step: 1 })
  // 既有行一个都没动
  const after = plan.fixed.filter((e) => ![4, 5].includes(e.seq) || e.type === 'tool/call')
  assert.ok(after.some((e) => e.type === 'tool/call' && e.seq === 3))
  // 独立复核
  assert.equal(verify(HEADER, plan.fixed).ok, true)
})

test('R2（missing=1，tool/call 后断到同 step 的 step/end）：只补 tool/result', () => {
  const events = fullChain().filter((e) => e.seq !== 4) // 只丢 result，step/end 还在（seq5）
  const gaps = scanGaps(events)
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].missing, 1)
  const plan = repairEvents(HEADER, events)
  assert.equal(plan.ok, true, plan.problems.join('; '))
  assert.equal(plan.inserted.length, 1)
  assert.equal(plan.inserted[0].type, 'tool/result')
  assert.equal(plan.inserted[0].data.message.content[0].text, '[NaN]')
  plan.fixed.forEach((ev, i) => assert.equal(ev.seq, i))
})

test('无法识别的形态：只报告不动手（unsupported，不返回 fixed）', () => {
  // missing=2 但下一跳是同 step 的 assistant/message —— 无法确定性推断缺了什么
  const events = [
    { type: 'turn/start', seq: 0, time: T(0), data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: T(1), data: { turn: 1, step: 1 } },
    { type: 'tool/call', seq: 2, time: T(2), data: { turn: 1, step: 1, callId: 'call_A', name: 'bash', arguments: '{}' } },
    { type: 'assistant/message', seq: 5, time: T(5), data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '?' }] } }, surfaceOp: 'append' },
  ]
  const plan = repairEvents(HEADER, events)
  assert.equal(plan.ok, false)
  assert.equal(plan.unsupported.length, 1)
  assert.equal(plan.fixed, undefined, 'unsupported 时不得给出可写盘的修复结果')
  assert.equal(buildInserts(plan.unsupported[0], events), null)
})

test('无断号：alreadyHealthy，不生成任何插入', () => {
  const plan = repairEvents(HEADER, fullChain())
  assert.equal(plan.ok, true)
  assert.equal(plan.alreadyHealthy, true)
  assert.equal(plan.inserted.length, 0)
})

test('scanFile：写盘→检出断号（读侧集成）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repair-scan-'))
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeSession(file, HEADER, brokenChain())
  const scan = scanFile(file)
  assert.equal(scan.error, undefined)
  assert.equal(scan.gaps.length, 1)
  assert.equal(scan.gaps[0].missing, 2)
  // 健康文件
  writeSession(file, HEADER, fullChain())
  assert.equal(scanFile(file).gaps.length, 0)
})

/** 造一个与宿主同构的 home（sessions/<ws>/<id>/session.v4.jsonl.zstd）。 */
function makeHome(events) {
  const home = mkdtempSync(join(tmpdir(), 'repair-home-'))
  const dir = join(home, 'sessions', 'ws1', 'session-fixture')
  mkdirSync(dir, { recursive: true })
  writeSession(join(dir, 'session.v4.jsonl.zstd'), HEADER, events)
  return home
}

const ctxNotLive = { get: (name) => (name === 'sessions' ? { get: () => undefined } : undefined) }
const ctxLive = { get: (name) => (name === 'sessions' ? { get: () => ({}) } : undefined) }

test('repairSessionFile：干跑只报告、不落盘', async () => {
  const home = makeHome(brokenChain())
  const file = join(home, 'sessions', 'ws1', 'session-fixture', 'session.v4.jsonl.zstd')
  const before = readFileSync(file)
  const r = await repairSessionFile(ctxNotLive, 'session-fixture', { write: false, home })
  assert.equal(r.ok, true)
  assert.equal(r.write, false)
  assert.equal(r.gaps.length, 1)
  assert.equal(r.wouldInsert, 2)
  assert.ok(readFileSync(file).equals(before), '干跑不得改文件')
})

test('repairSessionFile：落盘修复 + 备份 + 回读全绿；repairScanAll 复扫为健康', async () => {
  const home = makeHome(brokenChain())
  const file = join(home, 'sessions', 'ws1', 'session-fixture', 'session.v4.jsonl.zstd')
  const r = await repairSessionFile(ctxNotLive, 'session-fixture', { write: true, home })
  assert.equal(r.ok, true)
  assert.equal(r.inserted, 2)
  assert.equal(r.backup, true)
  // 备份存在且是坏的原始文件
  const bak = join(home, 'backup-true-delete-repair', 'session-fixture.jsonl.zstd')
  assert.ok(existsSync(bak))
  assert.equal(scanFile(bak).gaps.length, 1, '备份应保留原始断号形态')
  // 主文件已健康
  const scan = scanFile(file)
  assert.equal(scan.gaps.length, 0)
  assert.equal(verify(scan.header, scan.events).ok, true)
  // 全盘巡检
  const report = repairScanAll(home)
  assert.equal(report.scanned, 1)
  assert.equal(report.bad.length, 0)
  assert.equal(report.unreadable.length, 0)
  assert.equal(report.ok, true)
})

test('repairSessionFile：live 会话拒写（409 语义）', async () => {
  const home = makeHome(brokenChain())
  await assert.rejects(
    () => repairSessionFile(ctxLive, 'session-fixture', { write: true, home }),
    (e) => e.code === 'SESSION_LIVE',
  )
})

test('repairSessionFile：unsupported 形态拒写且文件不动（PLAN_REJECTED）', async () => {
  const home = makeHome([
    { type: 'turn/start', seq: 0, time: T(0), data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: T(1), data: { turn: 1, step: 1 } },
    { type: 'tool/call', seq: 2, time: T(2), data: { turn: 1, step: 1, callId: 'call_A', name: 'bash', arguments: '{}' } },
    { type: 'assistant/message', seq: 5, time: T(5), data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '?' }] } }, surfaceOp: 'append' },
  ])
  const file = join(home, 'sessions', 'ws1', 'session-fixture', 'session.v4.jsonl.zstd')
  const before = readFileSync(file)
  await assert.rejects(
    () => repairSessionFile(ctxNotLive, 'session-fixture', { write: true, home }),
    (e) => e.code === 'PLAN_REJECTED' && e.plan.unsupported.length === 1,
  )
  assert.ok(readFileSync(file).equals(before), '被拒的修复不得改文件')
})

test('repairScanAll：断号会话被列为 bad 且标记 repairable', async () => {
  const home = makeHome(brokenChain())
  const report = repairScanAll(home)
  assert.equal(report.ok, false)
  assert.equal(report.bad.length, 1)
  assert.equal(report.bad[0].id, 'session-fixture')
  assert.equal(report.bad[0].repairable, true)
  assert.equal(report.bad[0].gaps.length, 1)
})

/* ═════════ 大缺口（missing ≥ 3）：扩展结构重建 ═════════
 * 回归钉子：物化函数曾把动作 `turn-start` 写成 `turn/start`，导致**所有跨 turn 的缺口**
 * 静默失败、看上去像「规划器无解」。下面两条专门跨 turn，写错就红。 */

/** 两轮链（每轮 1 步），用于跨 turn 的大缺口。 */
function twoTurnChain() {
  const msg = (seq, turn, step, text) => ({
    type: 'assistant/message', seq, time: T(seq),
    data: {
      turn, step, stream: [],
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'our-free-model', model: 'longcat-2.5-preview-free' },
        id: `msg-${seq}`,
      },
    },
    surfaceOp: 'append',
  })
  return [
    { type: 'turn/start', seq: 0, time: T(0), data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: T(1), data: { turn: 1, step: 1 } },
    msg(2, 1, 1, '第一轮开工'),
    { type: 'step/end', seq: 3, time: T(3), data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 4, time: T(4), data: { turn: 1 } },
    { type: 'turn/start', seq: 5, time: T(5), data: { turn: 2 } },
    { type: 'step/start', seq: 6, time: T(6), data: { turn: 2, step: 1 } },
    msg(7, 2, 1, '第二轮开工'),
    { type: 'step/end', seq: 8, time: T(8), data: { turn: 2, step: 1 } },
    { type: 'turn/end', seq: 9, time: T(9), data: { turn: 2 } },
  ]
}

test('基线：twoTurnChain 本身过 verify', () => {
  const v = verify(HEADER, twoTurnChain())
  assert.deepEqual(v.problems, [])
})

test('大缺口跨 turn（缺 4 行，结构刚好够）：补 [step/end, turn/end, turn/start, step/start]', () => {
  const full = twoTurnChain()
  const broken = full.filter((e) => ![3, 4, 5, 6].includes(e.seq))
  const gaps = scanGaps(broken)
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].missing, 4)
  const plan = repairEvents(HEADER, broken)
  assert.equal(plan.ok, true, plan.problems.join('; '))
  assert.equal(plan.inserted.map((r) => r.type).join(','), 'step/end,turn/end,turn/start,step/start')
  plan.fixed.forEach((ev, i) => assert.equal(ev.seq, i, `第 ${i} 行 seq 应为 ${i}`))
  assert.equal(verify(HEADER, plan.fixed).ok, true)
  // 既有行必须原样保留（按对象引用比对：确认没被改过）
  for (const e of full) {
    if ([3, 4, 5, 6].includes(e.seq)) continue
    assert.equal(plan.fixed[e.seq], e, `seq ${e.seq} 的原行必须原样保留`)
  }
})

test('大缺口跨 turn（缺 8 行，结构不够填）：多出来的用 assistant/attempt 补（非表层）', () => {
  const broken = twoTurnChain().filter((e) => ![1, 2, 3, 4, 5, 6, 7, 8].includes(e.seq))
  const gaps = scanGaps(broken)
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].missing, 8)
  const plan = repairEvents(HEADER, broken)
  assert.equal(plan.ok, true, plan.problems.join('; '))
  assert.equal(plan.inserted.length, 8)
  const pads = plan.inserted.filter((r) => r.type === 'assistant/attempt')
  assert.ok(pads.length >= 1, '结构行不够填时要用 attempt 补满')
  for (const p of pads) {
    assert.equal(p.surfaceOp, undefined, 'attempt 不是表层事件，不能带 surfaceOp')
    assert.equal(p.sourceEventSeqs, undefined, 'attempt 不能带 sourceEventSeqs')
    assert.deepEqual(p.data.stream, [], 'attempt 必须带 stream（settlement）')
  }
  plan.fixed.forEach((ev, i) => assert.equal(ev.seq, i))
  assert.equal(verify(HEADER, plan.fixed).ok, true)
})

test('大缺口但形态不可定（缺 4 行、turn 内无坐标）：仍然只报告不动手', () => {
  // turn/end 之后直接 step/start(2/1)，结构上只需 1 行 turn/start，却缺 4 行
  // → 多出来的多半是不挂 turn 的真实内容（user/message、插件事件），不许假造
  const broken = [
    { type: 'turn/start', seq: 0, time: T(0), data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: T(1), data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 2, time: T(2), data: { turn: 1 } },
    { type: 'step/start', seq: 6, time: T(6), data: { turn: 2, step: 1 } },
  ]
  const plan = repairEvents(HEADER, broken)
  assert.equal(plan.ok, false)
  assert.equal(plan.unsupported.length, 1)
  assert.equal(plan.fixed, undefined)
})

test('大缺口且下一跳是无坐标插件事件：锚点后移到第一条带坐标的事件', () => {
  // 实测 8420 [1250+12]：缺口下一跳是 session-log-deepseek/delivery-accepted（无 turn/step），
  // 若拿它当收尾目标，step 会停在旧值，而真实后续 assistant/message 已经在下一个 step → 整条链错位。
  const pluginEvent = (seq) => ({
    type: 'session-log-deepseek/delivery-accepted', seq, time: T(seq),
    data: { delivery: { kind: 'accepted' } }, ignorable: true,
  })
  const msg = (seq, turn, step, text) => ({
    type: 'assistant/message', seq, time: T(seq),
    data: {
      turn, step, stream: [],
      message: {
        role: 'assistant', content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'our-free-model', model: 'longcat-2.5-preview-free' },
        id: `msg-${seq}`,
      },
    },
    surfaceOp: 'append',
  })
  const full = [
    { type: 'turn/start', seq: 0, time: T(0), data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: T(1), data: { turn: 1, step: 1 } },
    msg(2, 1, 1, '第一轮开工'),
    { type: 'step/end', seq: 3, time: T(3), data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 4, time: T(4), data: { turn: 1 } },
    { type: 'turn/start', seq: 5, time: T(5), data: { turn: 2 } },
    { type: 'step/start', seq: 6, time: T(6), data: { turn: 2, step: 1 } },
    pluginEvent(7),
    msg(8, 2, 1, '第二轮开工'),
    { type: 'step/end', seq: 9, time: T(9), data: { turn: 2, step: 1 } },
    { type: 'turn/end', seq: 10, time: T(10), data: { turn: 2 } },
  ]
  const broken = full.filter((e) => ![1, 2, 3, 4, 5, 6].includes(e.seq))
  const gaps = scanGaps(broken)
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].missing, 6)
  assert.equal(broken[gaps[0].index].type, 'session-log-deepseek/delivery-accepted', '下一跳确实是无坐标插件事件')
  const plan = repairEvents(HEADER, broken)
  assert.equal(plan.ok, true, plan.problems.join('; '))
  // 收尾必须落在 (turn2, step1)，否则后面的 assistant/message 会错位
  const types = plan.inserted.map((r) => r.type)
  assert.ok(types.includes('turn/start'), '要跨到第二轮：' + types.join(','))
  assert.equal(plan.inserted.at(-1).data.turn, 2, '最后一行要在 turn 2')
  assert.equal(plan.inserted.at(-1).data.step, 1, '最后一行要在 step 1')
  plan.fixed.forEach((ev, i) => assert.equal(ev.seq, i))
  assert.equal(verify(HEADER, plan.fixed).ok, true)
})
