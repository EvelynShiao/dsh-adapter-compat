import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  selectedRoute,
  wrapSummarize,
  armSummarizer,
  armSummarizerSelection,
  SUMMARIZER_ARMED,
} from '../index.js'

/** 伪造一个 cordis ctx：只提供 sessionProjections。 */
function ctxWith(state, opts = {}) {
  const calls = []
  const ctx = {
    get(name) {
      calls.push(name)
      if (name === 'sessionProjections') {
        if (opts.noProjections) return undefined
        return {
          stateOf(session, key) {
            if (opts.throwOnStateOf) throw new Error('not registered')
            assert.equal(key, 'modelSelection')
            return typeof state === 'function' ? state(session) : state
          },
        }
      }
      return undefined
    },
    logger: { info() {} },
    on() {},
  }
  ctx.__calls = calls
  return ctx
}

const agent = { session: { id: 'session-1' } }

test('selectedRoute：pending 优先（UI 里刚切、还没被请求消费）', () => {
  const ctx = ctxWith({ lastUsed: { provider: 'a', model: 'old' }, pending: { provider: 'b', model: 'new' } })
  assert.deepEqual(selectedRoute(ctx, agent), { provider: 'b', model: 'new' })
})

test('selectedRoute：没有 pending 时退回 lastUsed', () => {
  const ctx = ctxWith({ lastUsed: { provider: 'a', model: 'old' }, pending: null })
  assert.deepEqual(selectedRoute(ctx, agent), { provider: 'a', model: 'old' })
})

test('selectedRoute：投影缺失/未注册/空值全部返回 undefined（静默回退）', () => {
  assert.equal(selectedRoute(ctxWith(null, { noProjections: true }), agent), undefined)
  assert.equal(selectedRoute(ctxWith(null, { throwOnStateOf: true }), agent), undefined)
  assert.equal(selectedRoute(ctxWith(null), agent), undefined)
  assert.equal(selectedRoute(ctxWith({ lastUsed: null, pending: null }), agent), undefined)
  assert.equal(selectedRoute({}, agent), undefined)
  // provider/model 必须是非空字符串
  assert.equal(selectedRoute(ctxWith({ pending: { provider: '', model: 'm' } }), agent), undefined)
  assert.equal(selectedRoute(ctxWith({ pending: { provider: 'p', model: '' } }), agent), undefined)
})

/** 最小引擎替身：summarize 记录执行期间的 this.config。 */
function engineStub() {
  const seen = []
  const engine = {
    config: Object.freeze({
      thresholdRatio: 0.8,
      headroomTokens: 65536,
      retainRatio: 0.16,
      summarizationProvider: '',
      summarizationModel: '',
      maxTokens: 65536,
      compactionRetries: 1,
      maxOverflowRetries: 1,
      modelPolicies: [],
      auto: true,
    }),
    async summarize(input, a, signal) {
      seen.push({ config: engine.config, input, signal })
      return { ok: true }
    },
  }
  engine.__seen = seen
  return engine
}

test('wrapSummarize：调用期间把摘要目标钉到 pending，finally 原样还原', async () => {
  const ctx = ctxWith({ lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash' }, pending: { provider: 'dsh', model: 'deepseek-v4.1-flash' } })
  const engine = engineStub()
  const before = engine.config
  assert.equal(wrapSummarize(ctx, engine), true)
  await engine.summarize('INPUT', agent, undefined)
  // 执行期间用的是 pending
  assert.deepEqual(
    { p: engine.__seen[0].config.summarizationProvider, m: engine.__seen[0].config.summarizationModel },
    { p: 'dsh', m: 'deepseek-v4.1-flash' },
  )
  // 其余字段原样保留（换引用不是改对象）
  assert.equal(engine.__seen[0].config.headroomTokens, 65536)
  assert.equal(engine.__seen[0].config.modelPolicies.length, 0)
  // 参数透传
  assert.equal(engine.__seen[0].input, 'INPUT')
  // 还原
  assert.equal(engine.config, before)
  assert.equal(engine.config.summarizationProvider, '')
})

test('wrapSummarize：summarize 抛错时也还原（异常路径）', async () => {
  const ctx = ctxWith({ pending: { provider: 'x', model: 'y' } })
  const before = Object.freeze({ summarizationProvider: '', summarizationModel: '', auto: true })
  const engine = {
    config: before,
    async summarize() { throw new Error('boom') },
  }
  wrapSummarize(ctx, engine)
  await assert.rejects(() => engine.summarize('i', agent), /boom/)
  assert.equal(engine.config, before)
})

test('wrapSummarize：拿不到选中模型时完全不动 config（回退宿主原逻辑）', async () => {
  const ctx = ctxWith(null, { noProjections: true })
  const engine = engineStub()
  const before = engine.config
  wrapSummarize(ctx, engine)
  await engine.summarize('i', agent)
  assert.equal(engine.__seen[0].config, before)
  assert.equal(engine.config, before)
})

test('wrapSummarize 幂等：二次包装不生效', () => {
  const ctx = ctxWith({ pending: { provider: 'x', model: 'y' } })
  const engine = engineStub()
  assert.equal(wrapSummarize(ctx, engine), true)
  assert.equal(wrapSummarize(ctx, engine), false)
  assert.equal(engine.summarize[SUMMARIZER_ARMED], true)
})

test('armSummarizer：prototype 打一次即覆盖同类全部实例，且不打实例自有属性', () => {
  class Engine {
    constructor() { this.config = Object.freeze({ summarizationProvider: '', summarizationModel: '' }) }
    async summarize() { return null }
  }
  const ctx = ctxWith({ pending: { provider: 'x', model: 'y' } })
  const a = new Engine()
  const b = new Engine()
  assert.equal(armSummarizer(ctx, a), true)
  // a 自己没被装自有属性（走原型）
  assert.equal(Object.prototype.hasOwnProperty.call(a, 'summarize'), false)
  assert.equal(Engine.prototype.summarize[SUMMARIZER_ARMED], true)
  // b 是同类的新实例，自动获得同一包装
  assert.equal(b.summarize[SUMMARIZER_ARMED], true)
  // 再来一次：幂等
  assert.equal(armSummarizer(ctx, b), false)
})

test('armSummarizerSelection：根引擎 + agent/pre-step 双保险，且不依赖 autoGate', () => {
  const events = []
  const ctx = {
    get(name) { return name === 'compaction' ? rootEngine : undefined },
    logger: { info() {} },
    on(evt, handler, opts) { events.push({ evt, handler, opts }) },
  }
  const rootEngine = engineStub()
  armSummarizerSelection(ctx)
  assert.equal(rootEngine.summarize[SUMMARIZER_ARMED], true)
  assert.equal(events.length, 1)
  assert.equal(events[0].evt, 'agent/pre-step')
  assert.equal(events[0].opts.prepend, true)

  // preset 作用域引擎在首步前补装
  const scoped = engineStub()
  const ctx2 = {
    get(name) {
      if (name === 'agentPresets') return { serviceFor: () => scoped }
      return undefined
    },
    logger: { info() {} },
    on(evt, handler, opts) { events.push({ evt, handler, opts }); return () => {} },
    __handler: null,
  }
  ctx2.on = (evt, handler, opts) => { ctx2.__handler = handler; return () => {} }
  armSummarizerSelection(ctx2)
  assert.ok(!scoped.summarize[SUMMARIZER_ARMED])
  let called = false
  ctx2.__handler({ agent }, () => { called = true })
  assert.equal(called, true)
  assert.equal(scoped.summarize[SUMMARIZER_ARMED], true)
})

test('armSummarizerSelection：ctx 各种残缺形态都不抛', () => {
  assert.doesNotThrow(() => armSummarizerSelection({}))
  assert.doesNotThrow(() => armSummarizerSelection({ get() { throw new Error('x') }, on() { throw new Error('y') } }))
  assert.doesNotThrow(() => armSummarizerSelection({ get: () => undefined, logger: { info() { throw new Error('z') } } }))
})
