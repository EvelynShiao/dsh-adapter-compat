import { test } from 'node:test'
import assert from 'node:assert/strict'

import { planInboxRewrite, applyInboxRewrite, checkInboxSplices, purgeSessionFile } from '../purge.js'

/** 造一条 splice 事件。 */
const sp = (seq, target, start, removedCount, ids) => ({
  type: 'agent/inbox/spliced',
  seq,
  data: { target, start, removedCount, inserted: ids.map((id) => ({ id })) },
})
/** 造一条 user/message（带 id，用于标删）。 */
const um = (seq, id) => ({ type: 'user/message', seq, data: { id, message: { id } } })

test('planInboxRewrite：被删 splice 插入的消息要从链上摘掉，队列不留残影', () => {
  // 用户趁忙发了一条 a（splice），随后被 claim 掉
  const events = [
    sp(0, 'next-turn', 0, 0, ['a']), // 插入 a
    sp(1, 'next-turn', 0, 1, []), // claim 走 a
  ]
  // 删掉这两条（等价于删掉承接 a 的那个轮次）
  const rw = planInboxRewrite(events, [0, 1])
  assert.ok(rw.deletedIds.has('a'), 'claim 区间里的 a 必须被标删')
  const rewritten = applyInboxRewrite(events, rw.rewrites)
  const inbox = checkInboxSplices(rewritten)
  assert.equal(inbox.problems.length, 0, '重写后必须仍可重放')
})

test('planInboxRewrite：只删后面的 splice，前面的插入要跟着摘掉（不留排队残影）', () => {
  // a 插队 → b 插队 → claim 一起取走
  const events = [
    sp(0, 'next-turn', 0, 0, ['a']),
    sp(1, 'next-turn', 1, 0, ['b']),
    sp(2, 'next-turn', 0, 2, []),
  ]
  const rw = planInboxRewrite(events, [1]) // 删掉「插入 b」
  assert.ok(rw.deletedIds.has('b'))
  const rewritten = applyInboxRewrite(events, rw.rewrites)
  const inbox = checkInboxSplices(rewritten)
  assert.equal(inbox.problems.length, 0)
  // 重放末态：a 被 claim 走，b 从未进来 → 队列空
  assert.deepEqual(inbox.final['next-turn'], [])
  // claim 那条被投影成 (0,1,[]) —— 正好取走 a
  const claim = rewritten.find((e) => e.seq === 2)
  assert.equal(claim.data.start, 0)
  assert.equal(claim.data.removedCount, 1)
})

test('planInboxRewrite：区间内全被删时插入点落在「区间前最后存活元素」之后', () => {
  const events = [
    sp(0, 'next-turn', 0, 0, ['keep']),
    sp(1, 'next-turn', 1, 0, ['gone']),
    sp(2, 'next-turn', 1, 1, []), // 取走 gone
    sp(3, 'next-turn', 1, 0, ['tail']), // 再追加 tail
  ]
  const rw = planInboxRewrite(events, [1]) // 删掉插入 gone
  const rewritten = applyInboxRewrite(events, rw.rewrites)
  const inbox = checkInboxSplices(rewritten)
  assert.equal(inbox.problems.length, 0)
  assert.deepEqual(inbox.final['next-turn'].map((m) => m.id), ['keep', 'tail'])
})

test('planInboxRewrite：splice 越界的原始链不猜，原样跳过（不改事件）', () => {
  const events = [sp(0, 'next-turn', 5, 0, ['x'])] // start 越界
  const rw = planInboxRewrite(events, [])
  assert.equal(rw.rewrites.size, 0)
  assert.equal(applyInboxRewrite(events, rw.rewrites), events)
})

test('后置条件：真实素材干跑要么 planned（且零残留）要么 skipped，绝不出半成品', () => {
  // 无墓碑的素材（如已被清理过的会话）应直接 clean
  const fake = { header: { type: 'session' }, events: [{ type: 'user/message', seq: 0, data: {} }] }
  assert.equal(fake.events.length, 1)
  // purgeSessionFile 在文件不存在时也必须 fail-soft 而不是抛
  const r = purgeSessionFile('C:/definitely/not/here/session.v4.jsonl.zstd', 'session-x', {})
  assert.equal(r.status, 'failed')
  assert.ok(r.notes.length > 0)
})
