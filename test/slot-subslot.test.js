/**
 * 子插槽兼容性：session-kit 与 adapter 各自单独启用 / 同时启用都不能报错。
 *
 * 为什么要有这个测试：slot 机制规定「注册进未声明的槽位会抛
 * `slot "…" is not declared`」。压缩出口分区从「独立分区」改成「挂进
 * session-kit 的子插槽」后，两边单独启用就成了真实风险：
 *   - session-kit 单独：子插槽没人注册 → 必须渲染为空、不报错；
 *   - adapter 单独（无 session-kit）：注入挂起 → 必须回落到独立分区、不报错；
 *   - 两者共存：挂进子插槽 + 撤掉兜底分区（不能出现两个入口）。
 *
 * 用**真 SlotCore**（DSH 安装目录里的 dsh-client-ui-slots）而不是桩 —— 声明/注册
 * 纪律就是这个类实现的，桩测不出「未声明就抛」这条真实约束。找不到安装目录时跳过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const CORE_PATHS = [
  'C:/Users/Evelyn/AppData/Local/Programs/DeepSeekHarness/dsh/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js',
  '/usr/lib/dsh/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js',
]
const corePath = CORE_PATHS.find((p) => existsSync(p))
const SK_EXTRA = 'dsh-session-kit.settings.extra'
const SK_CHILDREN = { [SK_EXTRA]: { kind: 'list', scope: 'root' } }

/** 复刻宿主（ui-settings-general）对 settings.section 的声明。 */
function declareHost(core) {
  core.record('root').spec = { kind: 'single', scope: 'root' }
  const rec = core.record('settings.section')
  rec.spec = { kind: 'list', scope: 'root' }
  rec.declaredBy = 'settings-general(host)'
}

/** 最小 ctx：inject 已声明即触发，未声明则挂起（对齐真实声明 epoch 语义）。 */
function makeCtx(core, pending) {
  return {
    slots: {
      inject(key, cb) {
        if (core.records.get(key)?.spec) return cb()
        pending.push({ key, cb })
        return () => {}
      },
      register: (opts, comp) => core.register(opts, comp),
      entries: (key) => core.entries(key),
    },
  }
}
function flush(core, pending) {
  for (const p of [...pending]) {
    if (core.records.get(p.key)?.spec) {
      pending.splice(pending.indexOf(p), 1)
      p.cb()
    }
  }
}

/** 装载 adapter 的注册流程（与 client.js apply() 同构）。 */
function applyAdapter(core, pending) {
  const ctx = makeCtx(core, pending)
  let standaloneDispose = null
  let nestedActive = false
  ctx.slots.inject(SK_EXTRA, () => {
    nestedActive = true
    if (typeof standaloneDispose === 'function') { standaloneDispose(); standaloneDispose = null }
    return ctx.slots.register({ name: SK_EXTRA, id: 'adapter-compat-exit', order: 0 }, () => null)
  })
  ctx.slots.inject('settings.section', () => {
    if (nestedActive) return () => {}
    const d = ctx.slots.register({ name: 'settings.section', id: 'adapter-compat-exit-standalone', order: 36 }, () => null)
    standaloneDispose = d
    return d
  })
}

/** 装载 session-kit 的分区注册（与 client.js apply() 同构）。 */
function applySessionKit(core) {
  return core.register({
    name: 'settings.section',
    id: 'dsh-session-kit-settings',
    order: 35,
    children: SK_CHILDREN,
  }, () => null)
}

const skip = corePath === undefined ? '找不到 DSH 安装目录里的 dsh-client-ui-slots，跳过' : false

test('session-kit 单独：声明子插槽不报错，无人注册时渲染为空', { skip }, async () => {
  const { SlotCore } = await import(pathToFileURL(corePath).href)
  const core = new SlotCore()
  declareHost(core)
  assert.doesNotThrow(() => applySessionKit(core))
  assert.equal(!!core.records.get(SK_EXTRA)?.spec, true, '子插槽应被声明')
  assert.equal(core.entries(SK_EXTRA).length, 0, '没人注册时应是空集（不留空壳）')
})

test('adapter 单独（无 session-kit）：不报错，回落到独立分区', { skip }, async () => {
  const { SlotCore } = await import(pathToFileURL(corePath).href)
  const core = new SlotCore()
  declareHost(core)
  const pending = []
  assert.doesNotThrow(() => applyAdapter(core, pending))
  const ids = core.entries('settings.section').map((e) => e.options.id)
  assert.deepEqual(ids, ['adapter-compat-exit-standalone'])
})

test('两者共存：挂进子插槽，兜底分区被撤掉（无重复入口）', { skip }, async () => {
  const { SlotCore } = await import(pathToFileURL(corePath).href)
  const core = new SlotCore()
  declareHost(core)
  const pending = []
  applyAdapter(core, pending)
  assert.doesNotThrow(() => applySessionKit(core))
  flush(core, pending)
  assert.deepEqual(core.entries(SK_EXTRA).map((e) => e.options.id), ['adapter-compat-exit'])
  assert.equal(core.entries('settings.section').some((e) => e.options.id === 'adapter-compat-exit-standalone'), false, '兜底必须撤掉')
})

test('注册进未声明的槽位确实会抛（锁住这条约束本身）', { skip }, async () => {
  const { SlotCore } = await import(pathToFileURL(corePath).href)
  const core = new SlotCore()
  declareHost(core)
  assert.throws(() => core.register({ name: 'nobody.declared.this', id: 'x' }, () => null), /is not declared/)
})
