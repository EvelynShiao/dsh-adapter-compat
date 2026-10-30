/**
 * prepareCall 补丁链单测（2026-10-29 补缺口）。
 *
 * 为什么单独一个文件：agent-loop 把 request 深冻结后才调用 provider，
 * 三件套（chatOnly / zhToolNames / nlTeach）**唯一的真实生效位**是
 * `backfillAdapter` 包装出来的 `prepareCall → patchedStreamFor`。
 * 在补这个文件之前，246 个测试里没有任何一条覆盖这条链——
 * 「chatOnly 到底有没有把 0 工具交给下游」全靠读代码断言，不算证据。
 *
 * 测试用 `home` 注入口指向临时目录，不读用户真实配置
 * （readHealOptions 的缓存已按 home 区分，否则跨用例会串目录）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { patchedStreamFor } from '../index.js'

/** 造一个临时 home：webin/config.json = 真源（heal 文件不写 = 用出厂默认）。 */
function makeHome(webin = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-prepare-patch-'))
  mkdirSync(join(home, 'webin'), { recursive: true })
  writeFileSync(join(home, 'webin', 'config.json'), JSON.stringify(webin), 'utf8')
  return home
}

/** 记录下游到底收到了什么。注意：必须整体持有对象，别 `const { stream, seen } = ...`
 *  —— 解构会把 getter 当场求值一次（那时 calls 还是空的），seen 会固化成 undefined。 */
function spyStream() {
  const calls = []
  return {
    calls,
    stream: (options) => {
      calls.push(options)
      return { ok: true, options }
    },
    get seen() { return calls[calls.length - 1] },
  }
}

const TWO_TOOLS = () => ([
  { name: 'read', description: 'Read a UTF-8 text file.' },
  { name: 'no_such_tool_xyz', description: 'Unmapped tool stays English.' },
])

test('patchedStreamFor：chatOnly 清空工具目录，并把 0 工具交给下游（原请求不改）', () => {
  const home = makeHome({ chatOnly: true })
  try {
    const options = { provider: 'tiantian', model: 'deepseek-v4.1-flash', tools: TWO_TOOLS() }
    const spy = spyStream()
    patchedStreamFor(spy.stream, options, home)

    assert.equal(spy.seen.tools.length, 0, '下游必须收到 0 工具（纯聊天）')
    assert.equal(options.tools.length, 2, '宿主原请求的工具目录不许被改')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('patchedStreamFor：压缩/标题请求豁免 —— chatOnly 开也不清工具', () => {
  const home = makeHome({ chatOnly: true })
  try {
    for (const purpose of ['compaction', 'session-title']) {
      const options = { purpose, tools: TWO_TOOLS() }
      const spy = spyStream()
      patchedStreamFor(spy.stream, options, home)
      assert.equal(spy.seen.tools.length, 2, `${purpose} 请求的工具目录必须保留`)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('patchedStreamFor：zhToolNames 把映射到的工具描述换成中文，未映射的保持原文', () => {
  const home = makeHome({ zhToolNames: true })
  try {
    const options = { tools: TWO_TOOLS() }
    const spy = spyStream()
    patchedStreamFor(spy.stream, options, home)

    assert.equal(spy.seen.tools.length, 2, '中文工具名不裁目录，只换描述')
    assert.equal(spy.seen.tools[0].name, 'read', 'name 必须保留英文真名（function calling 要用）')
    assert.match(spy.seen.tools[0].description, /读取/, 'read 的描述应是中文')
    assert.equal(spy.seen.tools[1].description, 'Unmapped tool stays English.', '没映射的工具退回原文')
    assert.equal(options.tools[0].description, 'Read a UTF-8 text file.', '原请求描述不许被改')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('patchedStreamFor：nlTeach 只在 kb+nl 同开时注入系统教学', () => {
  const onHome = makeHome({ kbProtocol: true, nlToolProtocol: true })
  const offHome = makeHome({ kbProtocol: false, nlToolProtocol: true })
  try {
    const on = spyStream()
    patchedStreamFor(on.stream, { system: '基础系统提示' }, onHome)
    assert.match(String(on.seen.system), /我要调动第一层知识库/, 'kb+nl 同开必须注入教学')
    assert.match(String(on.seen.system), /基础系统提示/, '原有 system 要保留')

    /* kb 关 + nl 开 = nlTeach 假（egress.js 定义：nlToolProtocol === true && kbProtocol !== false）
     * ⇒ 不注入教学；但 2026-10-29 起这个组合还触发 no-kb 目录裁剪（按钮优先级），
     * 所以走的是补丁分支（副本），不再是原引用透传。 */
    const off = spyStream()
    const req = { system: '基础系统提示', tools: [{ name: 'read' }, { name: 'knowledge_search' }] }
    patchedStreamFor(off.stream, req, offHome)
    assert.notEqual(off.seen, req, 'kb 关 + nl 开要裁目录 ⇒ 必须走补丁副本分支')
    assert.doesNotMatch(String(off.seen.system), /我要调动第一层知识库/, 'kb 关不许注入教学')
    assert.deepEqual(off.seen.tools.map((t) => t.name), ['read'], 'no-kb 裁剪：知识库工具出局、普通工具保留')
  } finally {
    rmSync(onHome, { recursive: true, force: true })
    rmSync(offHome, { recursive: true, force: true })
  }
})

test('patchedStreamFor：三件套全关时原对象引用透传（不复制、不改写）', () => {
  const home = makeHome({})
  try {
    const options = { provider: 'tiantian', tools: TWO_TOOLS() }
    const spy = spyStream()
    patchedStreamFor(spy.stream, options, home)
    assert.equal(spy.seen, options, '全关时下游拿到的是同一个对象引用')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('patchedStreamFor：冻结请求 + AbortSignal —— 不抛、signal 保持原引用、工具仍清空', () => {
  const home = makeHome({ chatOnly: true })
  try {
    const controller = new AbortController()
    /* 模拟宿主：options 与 tools 数组都冻结（4e3ffb6 修的就是这类形态）。 */
    const options = Object.freeze({
      provider: 'tiantian',
      signal: controller.signal,
      signals: [controller.signal],
      tools: Object.freeze(TWO_TOOLS()),
    })
    const spy = spyStream()
    assert.doesNotThrow(() => patchedStreamFor(spy.stream, options, home))

    assert.equal(spy.seen.tools.length, 0, '冻结也不影响清空（改的是顶层浅副本）')
    assert.equal(spy.seen.signal, controller.signal, 'AbortSignal 必须保持原引用，不许被克隆')
    assert.equal(spy.seen.signals[0], controller.signal, 'signals[0] 同理')
    assert.equal(options.tools.length, 2, '冻结的原请求不可能被改，必须保持 2')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
