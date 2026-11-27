import './_hermetic-home.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply, armEngine, gateTarget, backfillAdapter, GATED, setAutoCompactionAllowed, isAutoCompactionAllowed, resolveAutoCompactionAllowed } from '../index.js'

/** 模拟 BasicCompactionEngine 形态：方法在 prototype 上。 */
class FakeEngine {
  compactIfNeeded() {
    throw new Error('auto compaction must never run')
  }
  compactNow() {
    return 'manual-ok'
  }
}

function makeCtx({ engine, scopedEngine } = {}) {
  const handlers = []
  const ctx = {
    llm: {
      adapters: new Map(),
      registerAdapter(providers, adapter) {
        for (const p of providers) this.adapters.set(p, { adapter, provider: { id: p } })
        return () => {}
      },
    },
    get(name) {
      if (name === 'compaction') return engine
      if (name === 'agentPresets') return { serviceFor: () => scopedEngine }
      return undefined
    },
    on(event, handler) {
      handlers.push({ event, handler })
      return () => {}
    },
    effect() {},
    logger: { info() {}, warn() {} },
    _handlers: handlers,
  }
  return ctx
}

test('gateTarget: 装闸后 compactIfNeeded 恒返 null，幂等', () => {
  const obj = { compactIfNeeded() { throw new Error('nope') }, compactNow: () => 'manual' }
  assert.equal(gateTarget(obj), true)
  assert.equal(obj.compactIfNeeded(), null)
  assert.equal(obj.compactIfNeeded[GATED], true)
  assert.equal(gateTarget(obj), false, '重复装闸应跳过')
  assert.equal(obj.compactNow(), 'manual', 'compactNow 不能被碰')
})

test('armEngine: instance + prototype 双层，同类未来实例自动被闸', () => {
  const engine = new FakeEngine()
  assert.equal(armEngine(engine), true)
  assert.equal(engine.compactIfNeeded(), null, '实例被闸')
  assert.equal(engine.compactNow(), 'manual-ok', '手动路径原样')
  const another = new FakeEngine()
  assert.equal(another.compactIfNeeded(), null, '同类新实例经 prototype 也被闸')
  assert.equal(engine.compactIfNeeded.original !== undefined, true, '保留 original 供诊断')
})

test('apply 默认开闸：根引擎被武装', () => {
  class RootEngine {
    compactIfNeeded() {
      throw new Error('should be gated')
    }
    compactNow() {
      return 'manual-ok'
    }
  }
  const engine = new RootEngine()
  const ctx = makeCtx({ engine })
  apply(ctx)
  assert.equal(engine.compactIfNeeded(), null, '默认 autoGate 下根引擎被闸')
  assert.equal(engine.compactNow(), 'manual-ok')
})

test('config.autoGate:false 恢复官方行为（闸常驻、放行转发）', () => {
  /* 2026-11-26 语义变更：为了让设置页开关能实时来回切，闸不再「关掉就不装」，
     而是常驻 + 读实时标志。autoGate:false 的对外行为仍是「官方原样」——
     方法被包了一层，但调用会被原样转发给 original。 */
  class FreshEngine {
    compactIfNeeded(agent, kind) {
      return { summarized: true, kind }
    }
    compactNow() {
      return 'manual-ok'
    }
  }
  const engine = new FreshEngine()
  const ctx = makeCtx({ engine })
  apply(ctx, { autoGate: false })
  assert.equal(engine.compactIfNeeded[GATED], true, '闸仍然装着（否则无法随时切回拦截）')
  assert.equal(isAutoCompactionAllowed(), true, '放行态已置位')
  assert.deepEqual(engine.compactIfNeeded({}, 'pressure'), { summarized: true, kind: 'pressure' }, '放行态必须转发给原方法')
  assert.equal(engine.compactNow(), 'manual-ok', '手动路径原样')
})

test('设置页开关：放行态实时切换，无需重新装闸', () => {
  class ToggleEngine {
    compactIfNeeded(agent, kind) {
      return { summarized: true, kind }
    }
  }
  const engine = new ToggleEngine()
  const ctx = makeCtx({ engine })
  apply(ctx) /* 默认 = 拦截 */
  assert.equal(isAutoCompactionAllowed(), false)
  assert.equal(engine.compactIfNeeded({}, 'pressure'), null, '默认拦截')

  setAutoCompactionAllowed(true)
  assert.equal(engine.compactIfNeeded({}, 'pressure')?.summarized, true, '打开后转发')
  /* prototype 层同步生效：开关之后新建的实例也尊重同一标志 */
  const another = new ToggleEngine()
  assert.equal(another.compactIfNeeded({}, 'pressure')?.summarized, true, '新实例同样放行')

  setAutoCompactionAllowed(false)
  assert.equal(engine.compactIfNeeded({}, 'pressure'), null, '切回拦截')
  assert.equal(another.compactIfNeeded({}, 'pressure'), null, '新实例同样被拦')
})

test('偏好文件 autoCompaction 优先于 patch.yml config.autoGate', () => {
  const dir = mkdtempSync(join(process.env.DSH_HOME || '.', 'pref-'))
  const prefs = join(dir, 'adapter-compat-exit.json')

  /* 文件里没写：落到 config 判断 */
  assert.equal(resolveAutoCompactionAllowed({ autoGate: false }, dir), true, '无文件时 autoGate:false = 放行')
  assert.equal(resolveAutoCompactionAllowed({}, dir), false, '无文件时默认拦截')

  /* 文件写了就以文件为准（设置页开关是真源） */
  writeFileSync(prefs, JSON.stringify({ autoCompaction: true }), 'utf8')
  assert.equal(resolveAutoCompactionAllowed({ autoGate: false }, dir), true, '文件 true 覆盖 patch')
  writeFileSync(prefs, JSON.stringify({ autoCompaction: false }), 'utf8')
  assert.equal(resolveAutoCompactionAllowed({ autoGate: false }, dir), false, '文件 false 覆盖 patch')
})

test('preset 作用域引擎经 pre-step 补闸', () => {
  class ScopedEngine {
    compactIfNeeded() {
      throw new Error('should be gated by pre-step')
    }
    compactNow() {
      return 'manual-ok'
    }
  }
  const scoped = new ScopedEngine()
  const ctx = makeCtx({ engine: undefined, scopedEngine: scoped })
  apply(ctx)
  // 顺序无关：可能有多个 pre-step 监听（自动压缩补闸 + 摘要模型跟随），全部都要跑。
  // 原先只取第一个，等价于假设「pre-step 只有闸一个监听」——加第二个合法监听就误判。
  const pres = ctx._handlers.filter((h) => h.event === 'agent/pre-step')
  assert.ok(pres.length > 0, '应注册 pre-step 监听')
  assert.throws(() => scoped.compactIfNeeded(), /should be gated/, 'pre-step 之前不应被误伤')
  let advanced = false
  for (const p of pres) p.handler({ agent: {} }, () => { advanced = true; return undefined })
  assert.equal(advanced, true, 'next() 必须放行，不能拦 step')
  assert.equal(scoped.compactIfNeeded(), null, 'scoped 引擎被补闸')
})

test('注册监听时抛错不弄挂 apply（闸不能反噬宿主）', () => {
  const ctx = makeCtx({ engine: new FakeEngine() })
  ctx.on = () => { throw new Error('no events surface') }
  apply(ctx)
  assert.equal(ctx.llm.adapters.size >= 0, true)
})

test('回填层回归：既有行为不回归', () => {
  const a = {}
  const added = backfillAdapter(a)
  assert.ok(added.includes('imageRequestPricing'))
  assert.equal(a.imageRequestPricing(), undefined)
  assert.deepEqual(backfillAdapter(a), [])
})
