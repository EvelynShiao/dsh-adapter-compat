import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, backfillAdapter, BASE_DEFAULTS } from '../index.js'

/** 一个刻意缺方法的裸类 adapter（模拟 dsh-our-free-model 1.3.1 的形态）。 */
class BareAdapter {
  providerInfo(provider) {
    return { id: provider, name: 'Bare ' + provider }
  }
  providerRetryPolicy() {
    return { mode: 'normal', maxRetries: 2 }
  }
  // 缺 imageRequestPricing / listModels / resolveModel / prepareCall
}

function makeLlm() {
  const listeners = new Set()
  return {
    adapters: new Map(),
    registerAdapter(providers, adapter) {
      // 模拟宿主校验：registerAdapter 内部就会调 providerInfo/providerRetryPolicy
      for (const p of providers) {
        const info = adapter.providerInfo(p)
        assert.equal(typeof info.id, 'string')
        adapter.providerRetryPolicy(p)
        this.adapters.set(p, { adapter, provider: { id: p } })
      }
      this._emit?.()
      return () => {}
    },
    _emit() {
      for (const l of listeners) l()
    },
    _on(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}

function makeCtx(llm) {
  return {
    llm,
    on: (event, cb) => (event === 'llm/adapters-updated' ? llm._on(cb) : () => {}),
    effect: (factory) => factory(),
  }
}

test('backfillAdapter 只补缺失方法，不覆盖已有实现', () => {
  const a = new BareAdapter()
  const added = backfillAdapter(a)
  assert.ok(added.includes('imageRequestPricing'))
  assert.ok(added.includes('listModels'))
  assert.ok(added.includes('resolveModel'))
  assert.ok(added.includes('prepareCall'))
  assert.ok(!added.includes('providerInfo'), '已有实现不应被报告为补入')
  assert.ok(!added.includes('providerRetryPolicy'))
  // 已有实现保持原样
  assert.equal(a.providerRetryPolicy().maxRetries, 2)
  // 缺失方法已补上且语义与基类一致
  assert.equal(a.imageRequestPricing('x', 'm'), undefined)
  // 幂等
  assert.deepEqual(backfillAdapter(a), [])
})

test('回填的方法与基类默认语义一致', async () => {
  const a = {}
  backfillAdapter(a)
  assert.deepEqual(a.providerInfo('p'), { id: 'p', name: 'p' })
  assert.equal(a.providerRetryPolicy(), undefined)
  assert.deepEqual(await a.listModels('p'), [])
  assert.deepEqual(await a.resolveModel('p', 'm'), { provider: 'p', id: 'm', name: 'm' })
  assert.equal(typeof BASE_DEFAULTS.prepareCall, 'function')
})

test('非对象输入安全返回空数组', () => {
  assert.deepEqual(backfillAdapter(null), [])
  assert.deepEqual(backfillAdapter(undefined), [])
  assert.deepEqual(backfillAdapter('str'), [])
})

test('apply 包装 registerAdapter：新注册的 adapter 先回填再过宿主校验', () => {
  const llm = makeLlm()
  apply(makeCtx(llm))
  assert.ok(llm.registerAdapter[Symbol.for('dsh-adapter-compat.wrapped')], '应已打包装标记')

  const a = new BareAdapter()
  // 不抛错即通过——宿主校验在 registerAdapter 内部，缺方法的 adapter 若未回填会在这里露馅
  llm.registerAdapter(['route-a'], a)
  assert.equal(typeof a.imageRequestPricing, 'function')
  assert.equal(llm.adapters.get('route-a').adapter, a)
})

test('apply 时先于本插件注册的 adapter 也会被扫描回填', () => {
  const llm = makeLlm()
  const early = new BareAdapter()
  llm.registerAdapter(['early-route'], early) // 未包装时注册
  assert.equal(typeof early.imageRequestPricing, 'undefined')

  apply(makeCtx(llm))
  assert.equal(typeof early.imageRequestPricing, 'function', '存量注册应被 sweep 补齐')
})

test('llm/adapters-updated 事件触发再扫描', () => {
  const llm = makeLlm()
  apply(makeCtx(llm))
  // 绕过包装直接塞一个裸 adapter 进注册表（模拟旁路注册）
  const stray = new BareAdapter()
  llm.adapters.set('stray-route', { adapter: stray, provider: { id: 'stray-route' } })
  assert.equal(typeof stray.imageRequestPricing, 'undefined')
  llm._emit() // 模拟宿主 emitAdaptersUpdated
  assert.equal(typeof stray.imageRequestPricing, 'function', '事件后应被扫描补齐')
})

test('已有完整实现的 adapter 不受影响（官方 adapter 形态）', async () => {
  class FullAdapter extends BareAdapter {
    imageRequestPricing() {
      return { USD: 1 }
    }
    async listModels() {
      return [{ id: 'm1' }]
    }
    async resolveModel(provider, model) {
      return { provider, id: model, name: 'custom' }
    }
  }
  const llm = makeLlm()
  apply(makeCtx(llm))
  const f = new FullAdapter()
  llm.registerAdapter(['full-route'], f)
  assert.deepEqual(f.imageRequestPricing('p', 'm'), { USD: 1 }, '不能覆盖已有实现')
  assert.deepEqual(await f.listModels('p'), [{ id: 'm1' }])
  assert.equal((await f.resolveModel('p', 'm')).name, 'custom')
})

test('registerAdapter 抛错时垫片不吞错（宿主语义保持）', () => {
  const llm = makeLlm()
  llm.registerAdapter = () => {
    throw new Error('DUPLICATE_ADAPTER')
  }
  apply(makeCtx(llm))
  assert.throws(() => llm.registerAdapter(['x'], new BareAdapter()), /DUPLICATE_ADAPTER/)
})
