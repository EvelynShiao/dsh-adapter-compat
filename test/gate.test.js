import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, armEngine, gateTarget, backfillAdapter, GATED } from '../index.js'

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

test('config.autoGate:false 恢复官方行为', () => {
  // 每个测试用独立类，避免 prototype 打标跨用例污染（armEngine 会动 prototype）
  class FreshEngine {
    compactIfNeeded() {
      throw new Error('auto compaction must never run')
    }
    compactNow() {
      return 'manual-ok'
    }
  }
  const engine = new FreshEngine()
  const ctx = makeCtx({ engine })
  apply(ctx, { autoGate: false })
  assert.notEqual(engine.compactIfNeeded[GATED], true, '关闸后不动引擎')
  assert.throws(() => engine.compactIfNeeded(), /auto compaction must never run/)
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
  const pre = ctx._handlers.find((h) => h.event === 'agent/pre-step')
  assert.ok(pre, '应注册 pre-step 监听')
  assert.throws(() => scoped.compactIfNeeded(), /should be gated/, 'pre-step 之前不应被误伤')
  let advanced = false
  pre.handler({ agent: {} }, () => { advanced = true; return undefined })
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
