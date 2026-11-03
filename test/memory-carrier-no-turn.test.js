/**
 * 回归：session-kit 的记忆快照载体**绝不允许整轮切除**。
 *
 * 事故（2026-10-16 双侧实测）：
 *   - 手机 session-7e75046b：712 → 467（少 245 个事件，整轮 turn 4）
 *   - 电脑 session-afa6ba0b：2077 → 1759（少 318 个事件）
 * 根因：`classifyTombstoneCarrier` 只豁免了 `dsh-session-kit-memory-context` 这一种 kind，
 * session-kit 后来加了 `-memory-eject` 变体，于是掉进 legacy-turn-fallback：
 * 拿被遮蔽节点的 data.turn 反推出「第 N 轮」→ turnSet.add(N) → excise 整轮。
 * 而这类载体只是 session-kit 在轮换自己的上下文快照，跟用户删轮毫无关系。
 *
 * 现在的要求（治本）：needsNodeLookup 分支一律只外科摘除被遮蔽节点，绝不整轮 ——
 * 不管 kind 是 memory-context、memory-eject，还是将来再加的 -memory-xxx 变体。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { planPurge, classifyTombstoneCarrier } from '../purge.js'

/** 造一段会话：3 个完整轮次，每轮里有若干真消息。 */
function sessionWithCarrier(carrierKind, { carrierInTurn = 3, summary = undefined, markRotation = false } = {}) {
  const events = []
  let seq = 0
  const push = (e) => { seq += 1; events.push({ seq, ...e }) }

  for (let turn = 1; turn <= 3; turn += 1) {
    push({ type: 'turn/start', data: { turn } })
    push({ type: 'user/message', data: { turn, message: { role: 'user', content: [{ type: 'text', text: `第${turn}轮提问` }] } } })
    push({ type: 'assistant/message', data: { turn, message: { role: 'assistant', content: [{ type: 'text', text: `第${turn}轮回答` }] } } })
    push({ type: 'tool/result', data: { turn } })
    push({ type: 'turn/end', data: { turn } })
  }

  // 载体：session-kit 的快照替换（replace 遮蔽了一个轮内节点）
  const shadowedSeq = events.find((e) => e.type === 'user/message' && e.data?.turn === carrierInTurn).seq
  push({
    type: 'user/message',
    surfaceOp: { op: 'replace', startSeq: shadowedSeq, endSeq: shadowedSeq },
    sourceEventSeqs: [shadowedSeq],
    data: {
      turn: carrierInTurn,
      source: {
        kind: carrierKind,
        ...(markRotation ? { snapshotRotation: true } : {}),
        ...(summary === undefined ? {} : { summary: JSON.stringify(summary) }),
      },
    },
  })
  return { events, shadowedSeq, carrierSeq: seq }
}

test('memory-eject 载体：不整轮，只外科摘除被遮蔽节点', () => {
  const { events, shadowedSeq, carrierSeq } = sessionWithCarrier('dsh-session-kit-memory-eject')
  const carrier = events.find((e) => e.seq === carrierSeq)
  const classified = classifyTombstoneCarrier(carrier, { purgeRegenerate: true })
  assert.equal(classified.needsNodeLookup, true, 'eject 载体应走 needsNodeLookup')

  const plan = planPurge(events, { purgeRegenerate: true, sinceMs: 0 })
  assert.deepEqual(plan.turns, [], '不得推导出任何整轮')
  /* 安全性质：绝不整轮。合成数据里「被遮蔽节点」不在表层索引中（真实会话里会被
     外科摘除或由 excise 清孤儿标记），所以这里断言的是**规模**与**边界**：
     删除量必须是个位数，且绝不包含轮边界事件。 */
  assert.ok(plan.remove.length < 5, `删除量应为个位数（实际 ${plan.remove.length}）`)
  for (const e of events) {
    if (e.type === 'turn/start' || e.type === 'turn/end') {
      assert.equal(plan.remove.includes(e.seq), false, `轮边界 seq ${e.seq} 不该被删`)
    }
  }
  assert.ok(shadowedSeq > 0)
})

test('memory-context 载体：同样不整轮（原有行为不能退化）', () => {
  const { events, shadowedSeq } = sessionWithCarrier('dsh-session-kit-memory-context')
  const plan = planPurge(events, { purgeRegenerate: true, sinceMs: 0 })
  assert.deepEqual(plan.turns, [])
  assert.ok(plan.remove.length < 5, `删除量应为个位数（实际 ${plan.remove.length}）`)
  assert.ok(shadowedSeq > 0)
})

test('将来再加 -memory-xxx 变体：一律不整轮（治本：不再靠 kind 白名单）', () => {
  for (const kind of ['dsh-session-kit-memory-eject', 'dsh-session-kit-memory-rotate', 'dsh-session-kit-memory-future-x']) {
    const { events } = sessionWithCarrier(kind)
    const plan = planPurge(events, { purgeRegenerate: true, sinceMs: 0 })
    assert.deepEqual(plan.turns, [], `${kind} 不得整轮`)
  }
})

test('显式标记 snapshotRotation 优先于 kind 前缀（换名字也不会误判）', () => {
  /* session-kit 现在给快照轮换事件加 `source.snapshotRotation = true`。
     万一它以后把 kind 改成不带 `-memory-` 的名字，只要带标记就必须走「只外科摘除」。 */
  for (const kind of ['dsh-session-kit-snapshot-rotate', 'dsh-session-kit-whatever-future']) {
    const { events } = sessionWithCarrier(kind, { markRotation: true })
    const plan = planPurge(events, { purgeRegenerate: true, sinceMs: 0 })
    assert.deepEqual(plan.turns, [], `${kind}（带标记）不得整轮`)
    assert.ok(plan.remove.length < 5, `${kind} 删除量应为个位数（实际 ${plan.remove.length}）`)
  }
})

test('反推轮号的老路已废：即便被遮蔽节点带 data.turn，也不许整轮', () => {
  /* 这正是事故路径：legacy-turn-fallback 会 turnSet.add(node.data.turn) ⇒ 整轮。 */
  const { events, carrierSeq } = sessionWithCarrier('dsh-session-kit-memory-eject')
  const plan = planPurge(events, { purgeRegenerate: true, sinceMs: 0 })
  const carrierTurnStart = events.find((e) => e.type === 'turn/start' && e.data?.turn === 3).seq
  assert.equal(plan.remove.includes(carrierTurnStart), false, '第 3 轮的 turn/start 不该被删（整轮的标志）')
  assert.deepEqual(plan.turns, [])
  assert.ok(carrierSeq > 0)
})
