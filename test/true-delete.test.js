import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  listSessionFiles,
  isSessionLive,
  purgeTombstones,
  installTrueDelete,
  TRUE_DELETE_BACKUP_DIR,
  TRUE_DELETE_PENDING_FILE,
} from '../index.js'
import { classifyTombstoneCarrier, planPurge, purgeSessionFile, readPendingLedger, checkInboxSplices, inboxSpliceSeqs } from '../purge.js'
import { readSession } from '../true-delete.js'

/** 真实素材（只读）：DeepSeek(1)，含 turn 595/596 两条真删除墓碑。 */
const REAL = 'C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/sessions/--C-Users-Evelyn-AppData-Local-DeepSeekHarness-.dsh-work-Evelyn--/session-bee75240-acce-4502-b577-9f9f5ce28d9d/session.v4.jsonl.zstd'
const SID = 'session-bee75240-acce-4502-b577-9f9f5ce28d9d'
const haveReal = existsSync(REAL)
/** 真实素材是可变的（真删除会把它清空）——依赖它的用例必须能优雅跳过。 */
const skipReason = !haveReal
  ? '缺少真实素材（换机器/被删）'
  : (planPurge(readSession(REAL).events).remove.length === 0
    ? '真实素材里的墓碑已被物理清理（这正是本功能生效的证据）；写盘路径的覆盖由 _truedelete/test-excision.mjs 的合成用例保证'
    : false)

/** 把真实会话文件复制成 <tmp>/sessions/--ws--/<sid>/session.v4.jsonl.zstd。 */
function fakeHome(sid = SID) {
  const home = mkdtempSync(join(tmpdir(), 'adapter-compat-purge-'))
  const dir = join(home, 'sessions', '--ws--', sid)
  mkdirSync(dir, { recursive: true })
  copyFileSync(REAL, join(dir, 'session.v4.jsonl.zstd'))
  return home
}

/** 一切会话都非 live 的假 ctx。 */
const notLiveCtx = { get: (name) => (name === 'sessions' ? { get: () => undefined } : undefined) }
/** 一切会话都 live 的假 ctx。 */
const allLiveCtx = { get: (name) => (name === 'sessions' ? { get: () => ({ id: 'x' }) } : undefined) }

test('classifyTombstoneCarrier：只认插件墓碑；regeneration 载体必须跳过', () => {
  const mk = (kind, summary, op = { op: 'replace', startSeq: 1, endSeq: 1 }) => ({
    type: 'user/message', surfaceOp: op, data: { source: { kind, summary: JSON.stringify(summary) } },
  })
  assert.equal(classifyTombstoneCarrier({ type: 'user/message', surfaceOp: { op: 'append' }, data: {} }), undefined)
  assert.equal(classifyTombstoneCarrier(mk('dsh-compaction', { turn: 1 })), undefined)
  const regen = classifyTombstoneCarrier(mk('dsh-session-kit-turns-del', { turn: 3, endTurn: 3, regeneration: { operationId: 'x' } }))
  assert.equal(regen.skip, true)
  assert.equal(regen.why, 'regenerate')
  const notice = classifyTombstoneCarrier(mk('dsh-session-kit-turns-del', { turn: 5, endTurn: 7 }))
  assert.deepEqual([...notice.turns], [5, 6, 7])
})

test('classifyTombstoneCarrier：无 summary 的旧载体走节点反推，拿不到就保守跳过', () => {
  const legacy = classifyTombstoneCarrier({
    type: 'user/message',
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 },
    sourceEventSeqs: [4, 5],
    data: { source: { kind: 'dsh-session-kit-turns-del' } },
  })
  assert.equal(legacy.needsNodeLookup, true)
  assert.deepEqual(legacy.sourcesFor, [4, 5])
  const noSources = classifyTombstoneCarrier({
    type: 'user/message',
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 },
    data: { source: { kind: 'dsh-session-kit-turns-del' } },
  })
  assert.equal(noSources.skip, true)
})

test('真实素材：planPurge 只挑出 595/596，且不含 regeneration 载体', { skip: skipReason }, () => {
  const doc = readSession(REAL)
  const plan = planPurge(doc.events)
  assert.deepEqual(plan.turns, [595, 596])
  assert.ok(plan.remove.length >= 20, `应删掉整轮事件，实际 ${plan.remove.length}`)
  assert.equal(plan.skipped.length, 0)
})

test('真实素材：purgeSessionFile 干跑 verify=true，且不动原文件', { skip: skipReason }, () => {
  const before = statSync(REAL).size
  const mtime = statSync(REAL).mtimeMs
  const r = purgeSessionFile(REAL, SID, {})
  assert.equal(r.status, 'planned')
  assert.equal(r.verify, true)
  assert.equal(r.removed, 25)
  assert.deepEqual(r.turns, [595, 596])
  assert.equal(statSync(REAL).size, before, '干跑绝不能改文件')
  assert.equal(statSync(REAL).mtimeMs, mtime, '干跑连 mtime 都不能变')
})

test('端到端：对副本真写盘 —— 事件变少、备份生成、台账清空、读回 verify', { skip: skipReason }, async () => {
  const home = fakeHome()
  try {
    const file = join(home, 'sessions', '--ws--', SID, 'session.v4.jsonl.zstd')
    const before = readSession(file).events.length
    const r = await purgeTombstones(notLiveCtx, { home, write: true })
    const written = r.results.filter((x) => x.status === 'written')
    assert.equal(written.length, 1)
    assert.equal(written[0].sid, SID)
    assert.equal(written[0].verify, true)
    const after = readSession(file)
    assert.equal(after.events.length, before - 25)
    assert.equal(after.events.length, written[0].after)
    // 备份存在，且必须是「改写前的原始字节」（不是切除后的）
    const bak = join(home, TRUE_DELETE_BACKUP_DIR, `${SID}.zstd`)
    assert.ok(existsSync(bak), '必须留备份')
    assert.equal(statSync(bak).size, statSync(REAL).size, '备份必须是改写前的原始字节')
    // 台账被清空（该会话已清完）
    assert.equal(readPendingLedger(home).pending[SID], undefined)
    // 幂等：再跑一次没有可删的了
    const again = await purgeTombstones(notLiveCtx, { home, write: true })
    assert.equal(again.results.filter((x) => x.status === 'written').length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('live 会话绝不写盘，只记台账', { skip: skipReason }, async () => {
  const home = fakeHome()
  try {
    const file = join(home, 'sessions', '--ws--', SID, 'session.v4.jsonl.zstd')
    const before = statSync(file).size
    const r = await purgeTombstones(allLiveCtx, { home, write: true })
    assert.equal(r.results.every((x) => x.status === 'live-skipped'), true)
    assert.equal(statSync(file).size, before, 'live 会话文件一个字节都不能动')
    const ledger = readPendingLedger(home)
    assert.ok(ledger.pending[SID], 'live 的必须记进待清理台账')
    assert.deepEqual(ledger.pending[SID].turns, [595, 596])
    assert.equal(existsSync(join(home, TRUE_DELETE_BACKUP_DIR)), false, 'live 时不该产生备份')
    assert.ok(existsSync(join(home, TRUE_DELETE_PENDING_FILE)))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('isSessionLive 判定不了就保守当作 live', () => {
  assert.equal(isSessionLive({ get: () => undefined }, 'x'), true, '无 sessions 服务 → true')
  assert.equal(isSessionLive({ get: () => ({ get: undefined }) }, 'x'), true, 'get 不是函数 → true')
  assert.equal(isSessionLive({ get: () => { throw new Error('boom') } }, 'x'), true, '抛错 → true')
  assert.equal(isSessionLive(notLiveCtx, 'x'), false)
  assert.equal(isSessionLive(allLiveCtx, 'x'), true)
})

test('listSessionFiles：扫出 <home>/sessions/<ws>/<sid>/session.v4.jsonl.zstd', { skip: skipReason }, () => {
  const home = fakeHome()
  try {
    const files = listSessionFiles(home)
    assert.equal(files.length, 1)
    assert.equal(files[0].id, SID)
    assert.ok(files[0].file.endsWith('session.v4.jsonl.zstd'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('installTrueDelete：默认关闭，写盘必须显式 config.trueDelete:true', () => {
  const ctx = { get: () => undefined }
  assert.equal(installTrueDelete(ctx, {}), undefined, '默认不装——本层会重写会话文件，必须显式开启')
  assert.equal(installTrueDelete(ctx, { trueDelete: false }), undefined)
  const ok = installTrueDelete(ctx, { trueDelete: true })
  assert.ok(ok?.run)
  for (const t of ok.timers) clearInterval(t)
})

test('checkInboxSplices：合法链通过；抽掉中间一条 splice 立刻不通过', () => {
  const mk = (seq, target, start, removedCount, ids) => ({
    type: 'agent/inbox/spliced', seq, data: { target, start, removedCount, inserted: ids.map((id) => ({ id })) },
  })
  // 追加式链：第 3 条要求队列长度 >= 2，抽掉中间那条就会越界
  const chain = [
    mk(1, 'next-turn', 0, 0, ['a']),
    mk(2, 'next-turn', 1, 0, ['b']),
    mk(3, 'next-turn', 0, 2, ['c']),
  ]
  assert.equal(checkInboxSplices(chain).problems.length, 0)
  assert.deepEqual(checkInboxSplices(chain).final['next-turn'].map((m) => m.id), ['c'])
  // 抽掉中间那条 → 后续 removedCount 越界（这正是宿主报
  // invalid persisted inbox splice 的成因）
  const broken = [chain[0], chain[2]]
  const bad = checkInboxSplices(broken)
  assert.equal(bad.problems.length, 1)
  assert.match(bad.problems[0].reason, /越界|pending/)
  // 重复 id 也要被抓到
  const dup = [mk(1, 'next-turn', 0, 0, ['a']), mk(2, 'next-step', 0, 0, ['a'])]
  assert.equal(checkInboxSplices(dup).problems.length, 1)
})

test('inboxSpliceSeqs：列出全部 spliced 的 seq（护栏一的判定输入）', () => {
  const events = [
    { type: 'user/message', seq: 0, data: {} },
    { type: 'agent/inbox/spliced', seq: 1, data: {} },
    { type: 'turn/start', seq: 2, data: {} },
    { type: 'agent/inbox/spliced', seq: 3, data: {} },
  ]
  assert.deepEqual(inboxSpliceSeqs(events), [1, 3])
})
