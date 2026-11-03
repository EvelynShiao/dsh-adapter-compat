/**
 * 按钮优先级·工具目录裁剪单测（2026-10-29，用户清单第 4/5 条的实现锁定）。
 *
 * 优先级链（用户 10-25 铁律「上对下有优先级，因为有的功能互斥」）：
 *   chatOnly（纯聊天）  > tools = []
 *   kb 开 + nl 非开     > 只留知识库工具（knowledge_* + archives_search）
 *   nl 开 + kb 显式关   > 去掉知识库工具，其余全留
 *   都开 / 都关 / 缺省  > 不裁
 *
 * 安全设计（本文件要锁死的两条）：
 *   ① kbTrim/noKbTrim 只在 webin config 给出【显式布尔】时才为 true——
 *      kbProtocol 的默认值是 true（!== false），若从默认值推断裁剪，
 *      缺省态会把模型工具全丢 → 灾难。缺省态必须不裁。
 *   ② 裁剪恒返回新数组，宿主原对象/工具对象一律不动。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  isKnowledgeTool,
  resolveToolTrimMode,
  filterToolCatalogByMode,
  normalizeEgressOptions,
  installEgressNormalizer,
} from '../egress.js'
import { patchedStreamFor, readHealOptions } from '../index.js'

/** 5 个工具：2 个知识库（两层）+ 3 个普通工具。 */
const CATALOG = () => ([
  { name: 'read', description: 'Read a UTF-8 text file.' },
  { name: 'ops_bash', description: 'Run commands.' },
  { name: 'grep', description: 'Search content.' },
  { name: 'knowledge_search', description: 'KB layer 1.' },
  { name: 'archives_search', description: 'KB layer 2.' },
])
const KB_ONLY = (list) => list.filter((t) => isKnowledgeTool(t.name)).map((t) => t.name)
const NO_KB = (list) => list.filter((t) => !isKnowledgeTool(t.name)).map((t) => t.name)

/* ==================== 纯函数 ==================== */

test('isKnowledgeTool：knowledge_ 前缀 + archives_search，其余一律不是', () => {
  for (const n of ['knowledge_search', 'knowledge_write', 'knowledge_vec', 'archives_search']) {
    assert.equal(isKnowledgeTool(n), true, n)
  }
  for (const n of ['read', 'ops_bash', 'memory_search', 'knowledgeable_tool', 'archives_search2', '', undefined, null, 42]) {
    assert.equal(isKnowledgeTool(n), false, String(n))
  }
})

test('resolveToolTrimMode：只认显式标志，缺省一律 none', () => {
  assert.equal(resolveToolTrimMode({ kbTrim: true }), 'kb-only')
  assert.equal(resolveToolTrimMode({ noKbTrim: true }), 'no-kb')
  assert.equal(resolveToolTrimMode({}), 'none')
  assert.equal(resolveToolTrimMode({ kbTrim: false, noKbTrim: false }), 'none')
  assert.equal(resolveToolTrimMode(null), 'none')
  assert.equal(resolveToolTrimMode(undefined), 'none')
  /* 关键回归：kbProtocol 默认值（true）绝不能推断出裁剪。 */
  assert.equal(resolveToolTrimMode(normalizeEgressOptions({})), 'none')
})

test('filterToolCatalogByMode：三种模式都返回新数组、原数组与工具对象不动', () => {
  const list = CATALOG()
  const kbOnly = filterToolCatalogByMode(list, 'kb-only')
  assert.deepEqual(kbOnly.map((t) => t.name), KB_ONLY(list))
  assert.equal(kbOnly.length, 2)

  const noKb = filterToolCatalogByMode(list, 'no-kb')
  assert.deepEqual(noKb.map((t) => t.name), NO_KB(list))
  assert.equal(noKb.length, 3)

  const none = filterToolCatalogByMode(list, 'none')
  assert.notEqual(none, list, 'none 也返回副本，防止调用方误以为可以原地改')
  assert.deepEqual(none.map((t) => t.name), list.map((t) => t.name))

  assert.equal(list.length, 5, '原数组不许被改')
  for (const t of list) assert.equal(typeof t.description, 'string', '工具对象不许被改')

  /* 非数组/含脏项安全 */
  assert.deepEqual(filterToolCatalogByMode(null, 'kb-only'), [])
  assert.deepEqual(filterToolCatalogByMode(undefined, 'no-kb'), [])
  const dirty = [null, 42, { name: 'knowledge_search' }, 'read', { name: 'read' }]
  assert.deepEqual(filterToolCatalogByMode(dirty, 'kb-only').map((t) => t?.name), ['knowledge_search'])
  assert.equal(filterToolCatalogByMode(dirty, 'no-kb').length, 4, '脏项当非知识库处理')
})

/* ==================== readHealOptions：webin 显式布尔 → 裁剪标志 ==================== */

function makeHome(webin) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-catalog-trim-'))
  if (webin !== undefined) {
    mkdirSync(join(home, 'webin'), { recursive: true })
    writeFileSync(join(home, 'webin', 'config.json'), JSON.stringify(webin), 'utf8')
  }
  return home
}

test('readHealOptions：webin 显式组合 → kbTrim/noKbTrim（缺省与文件缺失一律不裁）', () => {
  const cases = [
    [{ kbProtocol: true, nlToolProtocol: false }, { kbTrim: true, noKbTrim: false }],
    [{ kbProtocol: true, nlToolProtocol: true }, { kbTrim: false, noKbTrim: false }],
    [{ kbProtocol: false, nlToolProtocol: true }, { kbTrim: false, noKbTrim: true }],
    [{ kbProtocol: false, nlToolProtocol: false }, { kbTrim: false, noKbTrim: false }],
    [{}, { kbTrim: false, noKbTrim: false }],
  ]
  for (const [webin, expect] of cases) {
    const home = makeHome(webin)
    try {
      const v = readHealOptions(home)
      assert.equal(v.kbTrim, expect.kbTrim, `kbTrim: ${JSON.stringify(webin)}`)
      assert.equal(v.noKbTrim, expect.noKbTrim, `noKbTrim: ${JSON.stringify(webin)}`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
  /* 文件缺失：标志必须未定义（绝不为 true）——默认态不裁的兜底。 */
  const home = makeHome(undefined)
  try {
    const v = readHealOptions(home)
    assert.notEqual(v.kbTrim, true)
    assert.notEqual(v.noKbTrim, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

/* ==================== patchedStreamFor：冻结请求的真实生效位 ==================== */

function spyStream() {
  const calls = []
  return {
    stream: (options) => { calls.push(options); return { ok: true, options } },
    get seen() { return calls[calls.length - 1] },
  }
}

test('patchedStreamFor：kb 开 + nl 关 ⇒ 下游只收到知识库工具，且描述已中文化', () => {
  const home = makeHome({ kbProtocol: true, nlToolProtocol: false, zhToolNames: true })
  try {
    const options = { provider: 'tiantian', tools: CATALOG() }
    const spy = spyStream()
    patchedStreamFor(spy.stream, options, home)

    assert.deepEqual(spy.seen.tools.map((t) => t.name), ['knowledge_search', 'archives_search'])
    assert.match(spy.seen.tools[0].description, /知识库/, '幸存工具要拿到中文描述')
    assert.match(spy.seen.tools[1].description, /对话档案/, '第二层也要中文')
    assert.equal(options.tools.length, 5, '宿主原目录不许被改')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('patchedStreamFor：nl 开 + kb 显式关 ⇒ 下游没有知识库工具，其余全留', () => {
  const home = makeHome({ kbProtocol: false, nlToolProtocol: true })
  try {
    const options = { provider: 'tiantian', tools: CATALOG() }
    const spy = spyStream()
    patchedStreamFor(spy.stream, options, home)

    assert.deepEqual(spy.seen.tools.map((t) => t.name), NO_KB(CATALOG()))
    assert.equal(spy.seen.tools.length, 3)
    assert.equal(options.tools.length, 5, '宿主原目录不许被改')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('patchedStreamFor：kb 开 + nl 关，但 purpose=compaction ⇒ 豁免不裁', () => {
  const home = makeHome({ kbProtocol: true, nlToolProtocol: false })
  try {
    const spy = spyStream()
    patchedStreamFor(spy.stream, { purpose: 'compaction', tools: CATALOG() }, home)
    assert.equal(spy.seen.tools.length, 5, '压缩请求不吃目录裁剪')
    const spy2 = spyStream()
    patchedStreamFor(spy2.stream, { purpose: 'session-title', tools: CATALOG() }, home)
    assert.equal(spy2.seen.tools.length, 5, '标题请求同样豁免')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('patchedStreamFor：都开（kb+nl）⇒ 全留；都关 ⇒ 全留', () => {
  for (const webin of [{ kbProtocol: true, nlToolProtocol: true }, { kbProtocol: false, nlToolProtocol: false }]) {
    const home = makeHome(webin)
    try {
      const spy = spyStream()
      patchedStreamFor(spy.stream, { tools: CATALOG() }, home)
      assert.equal(spy.seen.tools.length, 5, `都开/都关不裁：${JSON.stringify(webin)}`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
})

/* ==================== egress 瀑布：可扩展请求原位裁剪 ==================== */

function fakeCtx() {
  const hooks = []
  return {
    hooks,
    llm: {},
    /* cordis 的 effect 会迭代 generator（用 yield 挂 disposer），必须真的跑完。 */
    effect(fn) {
      const g = fn()
      if (g !== null && typeof g === 'object' && typeof g.next === 'function') {
        let step = g.next()
        while (step.done !== true) step = g.next()
      }
    },
    on(name, cb) { hooks.push({ name, cb }) },
  }
}

async function* makeStream(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

test('waterfall：kbTrim 在原位裁剪（可扩展请求，下游同引用可见）', async () => {
  const ctx = fakeCtx()
  const ok = installEgressNormalizer(ctx, {}, {
    log: () => {},
    readOptions: () => ({ kbTrim: true, egressScope: 'all', egressThinking: true, egressXmlTools: 'strip' }),
  })
  assert.equal(ok, true)

  const options = { provider: 'webin-deepseek', tools: CATALOG() }
  const chunks = []
  for await (const c of ctx.hooks[0].cb(options, () => makeStream('好'))) chunks.push(c)
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(text, '好', '正文不受裁剪影响')
  assert.deepEqual(options.tools.map((t) => t.name), ['knowledge_search', 'archives_search'], '原位裁剪，同一引用下游可见')
})

test('waterfall：冻结请求 + kbTrim ⇒ 原对象物理不可改（真实生效位在 prepareCall 层）', async () => {
  const ctx = fakeCtx()
  installEgressNormalizer(ctx, {}, {
    log: () => {},
    readOptions: () => ({ kbTrim: true, egressScope: 'all', egressThinking: true, egressXmlTools: 'strip' }),
  })
  const options = Object.freeze({ provider: 'webin-deepseek', tools: Object.freeze(CATALOG()) })
  assert.doesNotThrow(() => ctx.hooks[0].cb(options, () => makeStream('好')))
  assert.equal(options.tools.length, 5, '冻结原对象不可能被改（这是架构限制，不是缺陷）')
})
