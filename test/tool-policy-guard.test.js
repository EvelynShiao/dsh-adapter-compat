/**
 * 盲调拦截·工具目录白名单单测（2026-10-30，用户清单第 4 条主观预期的补完）。
 *
 * 用户主观预期（原文）：「纯聊天关闭，但是知识库自然语言调用开启的时候问工具
 * 描述是什么（预期是只有知识库读写，没有其他任何工具）……你可以问它桌面上有
 * 几个文件试试，**预期它说无法调用**」。
 *
 * 重测 4.E/4.F 实锤的缺口：目录裁剪只控「下发目录」，模型原生 tool-call 盲调
 * 目录外工具（ops_bash）时宿主 dsh-tools 的 UNKNOWN_TOOL 校验的是【注册表】，
 * 注册表里的工具照常执行。本文件锁定补完后的行为：
 *   ① 白名单 = 本轮实际下发目录（裁剪/chatOnly 之后）——「下发什么就允许什么」；
 *   ② 越权 tool-call 三段块整段吞掉 + finish 前注入拒绝说明文本；
 *   ③ 全拦且 reason=tool-calls → 改 stop（镜像 egress.js 的反方向改写）；
 *   ④ 合法调用原样放行（三段块 index/内容不动）；
 *   ⑤ needPatch=false（全关）时不包装，行为与历史完全一致；
 *   ⑥ 宿主原目录/原对象一律不动。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isKnowledgeTool } from '../egress.js'
import { patchedStreamFor, guardedToolStream } from '../index.js'

const CATALOG = () => ([
  { name: 'read', description: 'Read a UTF-8 text file.' },
  { name: 'ops_bash', description: 'Run commands.' },
  { name: 'grep', description: 'Search content.' },
  { name: 'knowledge_search', description: 'KB layer 1.' },
  { name: 'archives_search', description: 'KB layer 2.' },
])

function makeHome(webin) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tool-policy-'))
  if (webin !== undefined) {
    mkdirSync(join(home, 'webin'), { recursive: true })
    writeFileSync(join(home, 'webin', 'config.json'), JSON.stringify(webin), 'utf8')
  }
  return home
}

/** 组一段标准 tool-call 三段块。 */
function toolCallChunks(index, name, args = '{}') {
  return [
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id: `call_${index}`, name, argumentsDelta: args },
    { type: 'block-end', index, block: { type: 'tool-call', id: `call_${index}`, name, arguments: args } },
  ]
}

async function collect(gen) {
  const chunks = []
  for await (const c of gen) chunks.push(c)
  return chunks
}

async function runPatched(webin, options, chunksIn) {
  const home = makeHome(webin)
  try {
    const out = await collect(patchedStreamFor(async function* () {
      for (const c of chunksIn) yield c
    }, options, home))
    return { out, options }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

const textOf = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
const toolBlocks = (chunks) => chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call')
const finishOf = (chunks) => chunks.find((c) => c.type === 'finish')

/* ==================== ① kb 独占：越权盲调被拦 ==================== */

test('kb 独占：盲调 ops_bash 整段被拦 + 拒绝文本 + finish 改 stop（用户预期「无法调用」）', async () => {
  const options = { provider: 'tiantian', tools: CATALOG() }
  const { out } = await runPatched(
    { kbProtocol: true, nlToolProtocol: false },
    options,
    [
      ...toolCallChunks(0, 'ops_bash', '{"command":"ls"}'),
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
  )

  assert.equal(toolBlocks(out).length, 0, '越权 tool-call 块必须整段消失')
  const text = textOf(out)
  assert.match(text, /tool-policy/, '要有拒绝说明文本')
  assert.match(text, /ops_bash/, '拒绝文本要点名被拦的工具')
  assert.equal(finishOf(out).reason?.kind, 'stop', '全拦 + reason=tool-calls ⇒ 必须改 stop（宿主不会再走执行分支）')
  assert.equal(options.tools.length, 5, '宿主原目录不许被改')
})

test('kb 独占：合法调用 knowledge_search 原样放行，finish 保持 tool-calls', async () => {
  const options = { provider: 'tiantian', tools: CATALOG() }
  const { out } = await runPatched(
    { kbProtocol: true, nlToolProtocol: false },
    options,
    [...toolCallChunks(0, 'knowledge_search', '{"query":"测试"}'), { type: 'finish', reason: { kind: 'tool-calls' } }],
  )

  const blocks = toolBlocks(out)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].block.name, 'knowledge_search')
  assert.equal(blocks[0].block.arguments, '{"query":"测试"}', 'arguments 一字不动')
  assert.equal(finishOf(out).reason?.kind, 'tool-calls', '有存活调用，reason 不动')
  assert.equal(textOf(out), '', '无拦截就没有拒绝文本')
})

test('kb 独占：混合（越权 ops_bash + 合法 knowledge_search）→ 合法存活 + 拒绝文本 + reason 不动', async () => {
  const options = { provider: 'tiantian', tools: CATALOG() }
  const { out } = await runPatched(
    { kbProtocol: true, nlToolProtocol: false },
    options,
    [
      ...toolCallChunks(0, 'ops_bash'),
      ...toolCallChunks(1, 'knowledge_search'),
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
  )

  const blocks = toolBlocks(out)
  assert.equal(blocks.length, 1, '只有合法调用存活')
  assert.equal(blocks[0].block.name, 'knowledge_search')
  assert.match(textOf(out), /ops_bash/, '拒绝文本点名越权者')
  assert.equal(finishOf(out).reason?.kind, 'tool-calls', '仍有存活调用，reason 保持')
})

/* ==================== ② no-kb：方向反转 ==================== */

test('nl 开 + kb 显式关：knowledge_search 被拦，ops_bash 放行', async () => {
  const options = { provider: 'tiantian', tools: CATALOG() }
  const { out } = await runPatched(
    { kbProtocol: false, nlToolProtocol: true },
    options,
    [
      ...toolCallChunks(0, 'knowledge_search'),
      ...toolCallChunks(1, 'ops_bash'),
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
  )

  const blocks = toolBlocks(out).map((c) => c.block.name)
  assert.deepEqual(blocks, ['ops_bash'], 'no-kb 模式下知识库工具调用必须被拦、其余放行')
  assert.match(textOf(out), /knowledge_search/, '拒绝文本点名 knowledge_search')
})

/* ==================== ③ chatOnly：空目录 = 全拦 ==================== */

test('chatOnly：tools=[] 时原生盲调也全拦 + finish 改 stop', async () => {
  const options = { provider: 'tiantian', tools: CATALOG() }
  const { out } = await runPatched(
    { chatOnly: true },
    options,
    [
      ...toolCallChunks(0, 'ops_bash'),
      ...toolCallChunks(1, 'read'),
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
  )

  assert.equal(toolBlocks(out).length, 0, '纯聊天下任何原生调用都不许存活')
  assert.match(textOf(out), /ops_bash/)
  assert.match(textOf(out), /read/)
  assert.equal(finishOf(out).reason?.kind, 'stop')
})

/* ==================== ④ 全关：零包装（历史行为） ==================== */

test('全关：needPatch=false 时不包装流，越权块原样透传（行为与历史一致）', async () => {
  const options = { provider: 'tiantian', tools: CATALOG() }
  const { out } = await runPatched(
    { kbProtocol: false, nlToolProtocol: false, chatOnly: false, zhToolNames: false },
    options,
    [...toolCallChunks(0, 'ops_bash'), { type: 'finish', reason: { kind: 'tool-calls' } }],
  )

  assert.equal(toolBlocks(out).length, 1, '全关 = 没有拦截层（保持宿主原生行为）')
  assert.equal(finishOf(out).reason?.kind, 'tool-calls')
  assert.equal(textOf(out), '')
})

/* ==================== ⑤ 怪流防御 ==================== */

test('孤儿 delta（无 start）：越权名直接吞，合法名放行', async () => {
  const allowed = new Set(['knowledge_search'])
  const out = await collect(guardedToolStream((async function* () {
    yield { type: 'tool-call-delta', index: 0, id: 'c1', name: 'ops_bash', argumentsDelta: '{}' }
    yield { type: 'tool-call-delta', index: 1, id: 'c2', name: 'knowledge_search', argumentsDelta: '{}' }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  })(), allowed))

  const names = out.filter((c) => c.type === 'tool-call-delta').map((c) => c.name)
  assert.deepEqual(names, ['knowledge_search'])
  assert.match(textOf(out), /ops_bash/)
  /* 孤儿 delta 没有 block-end，聚合不成完整调用；alive=0 + reason=tool-calls
   * ⇒ 改 stop 是安全语义（宿主绝不执行半块调用）。 */
  assert.equal(finishOf(out).reason?.kind, 'stop')
})

test('chunk 无 index：用 0 兜底不炸；finish 前正常注入拒绝文本', async () => {
  const out = await collect(guardedToolStream((async function* () {
    yield { type: 'block-start', blockType: 'tool-call' }
    yield { type: 'tool-call-delta', id: 'c1', name: 'grep', argumentsDelta: '{}' }
    yield { type: 'block-end', block: { type: 'tool-call', id: 'c1', name: 'grep', arguments: '{}' } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  })(), new Set(['knowledge_search', 'archives_search', 'read', 'ops_bash'])))

  assert.equal(toolBlocks(out).length, 0)
  assert.match(textOf(out), /grep/)
  assert.equal(finishOf(out).reason?.kind, 'stop')
})

test('未闭合的缓冲块（流中断）：不产出残块', async () => {
  const out = await collect(guardedToolStream((async function* () {
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: 'c1', name: 'knowledge_search', argumentsDelta: '{"q"' }
    /* 没有 block-end，流就结束了 */
  })(), new Set(['knowledge_search'])))

  assert.equal(out.filter((c) => c.type === 'block-start').length, 0, '未闭合块的 start 不许漏出去')
  assert.equal(out.filter((c) => c.type === 'tool-call-delta').length, 0, '未闭合块的 delta 不许漏出去')
})

test('text/thinking/finish（无拦截）全程透传', async () => {
  const out = await collect(guardedToolStream((async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '你好' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '你好' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })(), new Set(['read'])))

  assert.equal(textOf(out), '你好')
  assert.equal(finishOf(out).reason?.kind, 'stop')
  assert.equal(out.length, 4, '零拦截 = 零改动')
})

/* ==================== ⑥ kb 独占 + 普通会话语义（对齐 4.E/4.F 场景） ==================== */

test('kb 独占「桌面上有几个文件」场景：模型先文本后盲调 → 文本保留 + 盲调被拦 + stop', async () => {
  const options = { provider: 'tiantian', tools: CATALOG() }
  const { out } = await runPatched(
    { kbProtocol: true, nlToolProtocol: false },
    options,
    [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '我数一下桌面：' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '我数一下桌面：' } },
      ...toolCallChunks(1, 'ops_bash', '{"command":"ls Desktop"}'),
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
  )

  assert.equal(textOf(out).startsWith('我数一下桌面：'), true, '模型自己的正文必须原样保留')
  assert.equal(toolBlocks(out).length, 0)
  assert.match(textOf(out), /ops_bash/)
  assert.equal(finishOf(out).reason?.kind, 'stop')
})

test('isKnowledgeTool 回归锚：拦截白名单与目录裁剪用同一套知识库判定', () => {
  assert.equal(isKnowledgeTool('knowledge_search'), true)
  assert.equal(isKnowledgeTool('archives_search'), true)
  assert.equal(isKnowledgeTool('ops_bash'), false)
})
