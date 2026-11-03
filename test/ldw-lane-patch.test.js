/**
 * LDW 车道链路单测（2026-11-01，第四窗口遗留实锤）。
 *
 * 背景文档（Desktop\DSH第四窗口总结-Adapter验收与LDW-2026-10-31.md §4）写死的风险：
 * 「LDW 走 webin 的 streamOnce 构造路径，不一定经过 adapter-compat 的 llm/stream 瀑布。
 *   guardedToolStream / attachment-inline 挂在 patchedStreamFor 里，
 *   API 通道生效，不代表 LDW 也生效。」
 *
 * 本文件用代码实锤销案。链路证据（全部读自真源）：
 *   ① webin 以 ctx.llm.registerAdapter([route], adapter) 注册（webin lib/index.js:5228，
 *      route = `webin-<providerId>`，ROUTE_PREFIX="webin"，lib/index.js:1918）；
 *   ② adapter-compat 包装 llm.registerAdapter：未来注册先 backfillAdapter 再交宿主
 *      （index.js:4609-4614），profile bundles 里 adapter-compat 先于 webin 加载
 *      （profiles/web/package.json dsh.profile.bundles 顺序），包装必然先就位；
 *   ③ 宿主 dsh-llm 的两个 dispatch 构造点【只】经 adapter.prepareCall 取流
 *      （dsh-llm lib/index.js:2205/2292 → 2231/2295 adapterCall.stream(options)），
 *      全库没有直接调 adapter.stream 的调用点；
 *   ④ backfillAdapter 把 prepared.stream 换成 (options)=>patchedStreamFor(innerStream, options)
 *      （index.js:205-215）。
 *   ⇒ LDW 请求必经 patchedStreamFor，provider 无关。
 *
 * 本文件锁死：注册即包装（含 PREPARE_PATCHED 防重）、LDW 形态 options 下
 * chatOnly 清目录、附件内联、盲调拦截、全关透传（当前生产 config 现状）、
 * session-title 豁免。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { backfillAdapter } from '../index.js'

const PREPARE_PATCHED = Symbol.for('dsh-adapter-compat.prepare-call-patched')

const ROUTE_LDW = 'webin-ldw'
const CATALOG = () => ([
  { name: 'read', description: 'Read a UTF-8 text file.' },
  { name: 'ops_bash', description: 'Run commands.' },
  { name: 'knowledge_search', description: 'KB layer 1.' },
  { name: 'archives_search', description: 'KB layer 2.' },
])

function makeHome(webin) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ldw-lane-'))
  if (webin !== undefined) {
    mkdirSync(join(home, 'webin'), { recursive: true })
    writeFileSync(join(home, 'webin', 'config.json'), JSON.stringify(webin), 'utf8')
  }
  return home
}

/**
 * 包装链上 prepareCall 调 patchedStreamFor(innerStream, options) 不传 home
 * （生产语义：读真实配置）。单测用 DSH_HOME 把 dshHomeDir() 的默认落到临时目录：
 * dshHomeDir 每次调用动态读 process.env.DSH_HOME，无模块级缓存串扰
 * （healOptionsCache 还按 home 键隔离，双保险）。测试后恢复原值。
 */
function pointDSHHomeAt(home) {
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return () => {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
}

/** 造附件文件 + 宿主完整段形态句柄（与 attachment-inline.test.js 同款）。 */
function makeAttachment(home, name, body) {
  const dir = join(home, 'attachments', 'v1', 'files', 'ab', 'abcd1234')
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, body, 'utf8')
  const segment = `[File "${name}" (${Buffer.byteLength(body)} bytes, sha256:abcd1234ef5678): verbatim read-only copy saved at "${p.replaceAll('\\', '\\\\')}". Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it. When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]`
  return { path: p, segment, body }
}

const SENTINEL_HEAD = 'LDW附件哨兵-HEAD-8K2M'
const SENTINEL_TAIL = 'LDW附件哨兵-TAIL-8K2M'
const userMsg = (text) => ({ role: 'user', content: [{ type: 'text', text }] })

/** 按 webin lib/index.js:3566-3572 的真实形态造 adapter；streamOnce 捕获收到的 options。 */
function makeWebinAdapter(captured, chunksOut = []) {
  async function* streamOnce(options) {
    captured.push(options)
    for (const c of chunksOut) yield c
  }
  return {
    prepareCall(provider, model) {
      return Promise.resolve({
        model: { id: model },
        stream: (options) => streamOnce(options),
      })
    },
  }
}

/**
 * 按 adapter-compat index.js:4609-4614 的真实形态包装 registerAdapter，
 * 再模拟 webin 的注册（webin lib/index.js:5228）。返回宿主侧 registry。
 */
function registerThroughWrappedRegisterAdapter(adapter) {
  const adapters = new Map()
  const original = (providers, a) => { adapters.set(providers[0], { provider: providers[0], adapter: a }) }
  const wrapped = (providers, a) => { backfillAdapter(a); return original(providers, a) } // ← 4609-4614 逐字语义
  wrapped([ROUTE_LDW], adapter)
  return adapters
}

/** 走宿主 dsh-llm lib/index.js:2205/2292 的真实调度形态取流。 */
async function dispatchLikeHost(adapter, options) {
  const adapterCall = await adapter.prepareCall(options.provider, options.model, options.signal)
  return adapterCall.stream(options)
}

async function collect(gen) { const c = []; for await (const x of gen) c.push(x); return c }
const textOf = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
const toolBlocks = (chunks) => chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call')
const finishOf = (chunks) => chunks.find((c) => c.type === 'finish')

/** 组一段标准 tool-call 三段块（与 tool-policy-guard.test.js 同款协议）。 */
function toolCallChunks(index, name, args = '{}') {
  return [
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id: `call_${index}`, name, argumentsDelta: args },
    { type: 'block-end', index, block: { type: 'tool-call', id: `call_${index}`, name, arguments: args } },
  ]
}

/* ==================== ① 注册即包装 ==================== */

test('LDW 链路①：webin adapter 经 wrapped registerAdapter 注册后，prepareCall 已被包装（PREPARE_PATCHED）', async () => {
  const captured = []
  const adapter = makeWebinAdapter(captured)
  const adapters = registerThroughWrappedRegisterAdapter(adapter)

  const registration = adapters.get(ROUTE_LDW)
  assert.ok(registration?.adapter, 'webin 注册进了宿主 registry')
  assert.equal(registration.adapter.prepareCall[PREPARE_PATCHED], true, '注册即被 backfillAdapter 包装')

  /* 幂等：重复 sweep/backfill 不得二次包装（防热重载重复套娃）。 */
  backfillAdapter(registration.adapter)
  assert.equal(registration.adapter.prepareCall[PREPARE_PATCHED], true)
})

/* ==================== ② chatOnly + 附件全链 ==================== */

test('LDW 链路②（chatOnly+附件，用户欠的第一脚的 API 侧等价）：经包装 prepareCall 的流在 LDW 形态 options 下清目录 + 附件内联', async () => {
  const home = makeHome({ chatOnly: true })
  const restore = pointDSHHomeAt(home)
  try {
    const { segment } = makeAttachment(home, 'ldw.txt', `${SENTINEL_HEAD}\n中间内容行\n${SENTINEL_TAIL}`)
    const captured = []
    const adapter = makeWebinAdapter(captured)
    registerThroughWrappedRegisterAdapter(adapter)

    /* 宿主 dispatch 形态：LDW 车道的真实请求（provider=webin-ldw，带完整目录与附件句柄）。 */
    const options = { provider: ROUTE_LDW, model: 'ldw-default', tools: CATALOG(), messages: [userMsg(`请看附件。${segment}以上就是附件。`)] }
    await collect(await dispatchLikeHost(adapter, options))

    assert.equal(captured.length, 1, 'streamOnce（webin 车道构造点）被调用且只一次')
    const seen = captured[0]
    assert.deepEqual(seen.tools, [], 'chatOnly 经 patchedStreamFor 后，LDW 车道下游收到 tools=[]')
    const text = seen.messages[0].content[0].text
    assert.doesNotMatch(text, /verbatim read-only copy/, '句柄引导整段消失（防盲调 bait）')
    assert.match(text, /附件内联/)
    assert.match(text, new RegExp(SENTINEL_HEAD), 'LDW 车道模型可直接看到附件全文（头部哨兵）')
    assert.match(text, new RegExp(SENTINEL_TAIL), '尾部哨兵')
    assert.match(text, /以上就是附件。/, '句柄段之后的正文保留')
    /* 冻结安全：原请求对象不动 */
    assert.equal(options.messages[0].content[0].text.includes('verbatim read-only copy'), true)
    assert.equal(options.tools.length, 4)
  } finally {
    restore()
    rmSync(home, { recursive: true, force: true })
  }
})

/* ==================== ③ kb 独占 + 附件内联 ==================== */

test('LDW 链路③（kb 独占+附件）：目录裁到知识库子集 + 句柄整段替换为内联全文', async () => {
  const home = makeHome({ kbProtocol: true, nlToolProtocol: false })
  const restore = pointDSHHomeAt(home)
  try {
    const { segment } = makeAttachment(home, 'ldw-kb.txt', `${SENTINEL_HEAD}\n${SENTINEL_TAIL}`)
    const captured = []
    const adapter = makeWebinAdapter(captured)
    registerThroughWrappedRegisterAdapter(adapter)

    const options = { provider: ROUTE_LDW, model: 'ldw-default', tools: CATALOG(), messages: [userMsg(segment)] }
    await collect(await dispatchLikeHost(adapter, options))

    const seen = captured[0]
    assert.deepEqual(seen.tools.map((t) => t.name), ['knowledge_search', 'archives_search'], 'kb 独占裁剪对 LDW 生效')
    const text = seen.messages[0].content[0].text
    assert.doesNotMatch(text, /Read that path/, '无工具引导残留')
    assert.match(text, new RegExp(SENTINEL_TAIL), '内联全文可达')
  } finally {
    restore()
    rmSync(home, { recursive: true, force: true })
  }
})

/* ==================== ④ 盲调拦截 ==================== */

test('LDW 链路④（kb 独占盲调 ops_bash）：越权三段块整段被吞 + 拒绝文本 + finish 改 stop', async () => {
  const home = makeHome({ kbProtocol: true, nlToolProtocol: false })
  const restore = pointDSHHomeAt(home)
  try {
    const captured = []
    const adapter = makeWebinAdapter(captured, [
      ...toolCallChunks(0, 'ops_bash', '{"command":"ls ~/Desktop"}'),
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
    registerThroughWrappedRegisterAdapter(adapter)

    const options = { provider: ROUTE_LDW, model: 'ldw-default', tools: CATALOG(), messages: [userMsg('桌面上有几个文件？')] }
    const out = await collect(await dispatchLikeHost(adapter, options))

    assert.equal(toolBlocks(out).length, 0, 'LDW 车道越权 tool-call 同样整段消失')
    assert.match(textOf(out), /tool-policy/, '拒绝说明文本注入')
    assert.match(textOf(out), /ops_bash/, '点名被拦工具')
    assert.equal(finishOf(out).reason?.kind, 'stop', '全拦 + tool-calls ⇒ 改 stop')
  } finally {
    restore()
    rmSync(home, { recursive: true, force: true })
  }
})

test('LDW 链路④b（kb 独占合法调用 knowledge_search）：原样放行', async () => {
  const home = makeHome({ kbProtocol: true, nlToolProtocol: false })
  const restore = pointDSHHomeAt(home)
  try {
    const captured = []
    const adapter = makeWebinAdapter(captured, [
      ...toolCallChunks(0, 'knowledge_search', '{"query":"测试"}'),
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
    registerThroughWrappedRegisterAdapter(adapter)

    const options = { provider: ROUTE_LDW, model: 'ldw-default', tools: CATALOG(), messages: [userMsg('搜一下')] }
    const out = await collect(await dispatchLikeHost(adapter, options))

    const blocks = toolBlocks(out)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].block.name, 'knowledge_search')
    assert.equal(blocks[0].block.arguments, '{"query":"测试"}')
    assert.equal(finishOf(out).reason?.kind, 'tool-calls')
  } finally {
    restore()
    rmSync(home, { recursive: true, force: true })
  }
})

/* ==================== ⑤ 全关透传（当前生产 config 现状守卫） ==================== */

test('LDW 链路⑤（全关=当前生产 webin config）：LDW options 原引用透传，chunk 原样，不误伤', async () => {
  const home = makeHome({ kbProtocol: false, nlToolProtocol: false, chatOnly: false, zhToolNames: false })
  const restore = pointDSHHomeAt(home)
  try {
    const captured = []
    const adapter = makeWebinAdapter(captured, [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'LDW 原样输出' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'LDW 原样输出' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    registerThroughWrappedRegisterAdapter(adapter)

    const options = { provider: ROUTE_LDW, model: 'ldw-default', tools: CATALOG(), messages: [userMsg('hi')] }
    const out = await collect(await dispatchLikeHost(adapter, options))

    assert.equal(captured[0], options, '全关 = 原请求引用透传（needPatch=false 分支）')
    assert.equal(textOf(out), 'LDW 原样输出')
    assert.equal(finishOf(out).reason?.kind, 'stop')
  } finally {
    restore()
    rmSync(home, { recursive: true, force: true })
  }
})

/* ==================== ⑥ session-title 豁免（LDW 标题链路） ==================== */

test('LDW 链路⑥（session-title 豁免）：宿主标题请求经 LDW 车道不被裁剪/清空（webin 的 LDW 前缀标题依赖它）', async () => {
  const home = makeHome({ chatOnly: true, kbProtocol: true })
  const restore = pointDSHHomeAt(home)
  try {
    const captured = []
    const adapter = makeWebinAdapter(captured)
    registerThroughWrappedRegisterAdapter(adapter)

    const options = { provider: ROUTE_LDW, model: 'ldw-default', purpose: 'session-title', tools: CATALOG(), messages: [userMsg('总结为标题')] }
    await collect(await dispatchLikeHost(adapter, options))

    assert.equal(captured[0].tools.length, 4, '标题请求豁免：目录原样')
  } finally {
    restore()
    rmSync(home, { recursive: true, force: true })
  }
})
