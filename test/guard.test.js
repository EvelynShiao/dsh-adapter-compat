import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeRuntime,
  normalizeRuntimeConfigs,
  guardSettingsSchema,
  apply,
  SCHEMA_GUARDED,
} from '../index.js'

/** 宿主 dsh-settings schema() 的复刻：只判 undefined，遇 null 即抛（lib/index.js:540）。 */
function hostSchema(entry) {
  const schema = entry?.fiber?.runtime?.Config
  return schema !== undefined && 'toJSON' in schema ? schema : undefined
}

/** 真 schema 形态：有 toJSON。 */
const realSchema = { toJSON: () => ({ type: 'object' }) }

test('normalizeRuntime: null → undefined（成功），其余形态一律不动', () => {
  const rt = { Config: null }
  assert.equal(normalizeRuntime(rt), true)
  assert.equal(rt.Config, undefined)

  assert.equal(normalizeRuntime({ Config: realSchema }), false)
  assert.equal(normalizeRuntime({}), false)
  assert.equal(normalizeRuntime(null), false)
  assert.equal(normalizeRuntime(undefined), false)
})

test('normalizeRuntime: 冻结对象不抛，返回 false', () => {
  const rt = Object.freeze({ Config: null })
  assert.equal(normalizeRuntime(rt), false)
  assert.equal(rt.Config, null)
})

test('normalizeRuntimeConfigs: registry 来源，修完幂等', () => {
  const bad1 = { Config: null }
  const bad2 = { Config: null }
  const good = { Config: realSchema }
  const ctx = { registry: { values: () => [bad1, good, bad2] } }
  assert.equal(normalizeRuntimeConfigs(ctx), 2)
  assert.equal(bad1.Config, undefined)
  assert.equal(bad2.Config, undefined)
  assert.equal(good.Config, realSchema)
  // 幂等：再扫一遍 0 条
  assert.equal(normalizeRuntimeConfigs(ctx), 0)
})

test('normalizeRuntimeConfigs: registry 不可用 → configEditor 回落', () => {
  const bad = { Config: null }
  const ctx = {
    configEditor: { entries: () => [{ fiber: { runtime: bad } }, { fiber: undefined }, {}] },
  }
  assert.equal(normalizeRuntimeConfigs(ctx), 1)
  assert.equal(bad.Config, undefined)
})

test('normalizeRuntimeConfigs: 三源全不可用 → 安全返回 0', () => {
  assert.equal(normalizeRuntimeConfigs({}), 0)
  assert.equal(normalizeRuntimeConfigs({ registry: 123, configEditor: null }), 0)
})

test('guardSettingsSchema: 套壳后宿主 describe 遇 null 条目不再抛', () => {
  const badEntry = { fiber: { runtime: { Config: null } } }
  const goodEntry = { fiber: { runtime: { Config: realSchema } } }

  // 裸宿主行为：先炸
  assert.throws(() => hostSchema(badEntry), TypeError)

  // 装守卫（settings 实例的 schema 挂在原型上，模拟真实形态）
  class FakeSettings {
    schema(entry) {
      const schema = entry?.fiber?.runtime?.Config
      return schema !== undefined && 'toJSON' in schema ? schema : undefined
    }
    describe(entries) {
      return entries.flatMap((e) => {
        const s = this.schema(e)
        return s === undefined ? [] : [s]
      })
    }
  }
  const settings = new FakeSettings()
  const ctx = { settings }

  assert.equal(guardSettingsSchema(ctx), true)
  assert.equal(settings.schema[SCHEMA_GUARDED], true)

  // describe 全体条目（含 null）：不抛，真 schema 照常返回，坏条目被安全跳过
  const out = settings.describe([badEntry, goodEntry])
  assert.equal(out.length, 1)
  assert.equal(out[0], realSchema)
  // 副作用：null 已被归一
  assert.equal(badEntry.fiber.runtime.Config, undefined)

  // 幂等：二次装不双层套
  assert.equal(guardSettingsSchema(ctx), true)
  assert.equal(guardSettingsSchema({ settings }), true)
})

test('guardSettingsSchema: 晚注册条目（守卫后才出现的 null）也兜得住', () => {
  class FakeSettings {
    schema(entry) {
      const schema = entry?.fiber?.runtime?.Config
      return schema !== undefined && 'toJSON' in schema ? schema : undefined
    }
  }
  const settings = new FakeSettings()
  guardSettingsSchema({ settings })

  // 模拟 dsh-sync（bundles 排后）注册晚于本插件
  const lateEntry = { fiber: { runtime: { Config: null } } }
  assert.equal(settings.schema(lateEntry), undefined)
  assert.equal(lateEntry.fiber.runtime.Config, undefined)
})

test('guardSettingsSchema: 无 settings 面 → false 不抛', () => {
  assert.equal(guardSettingsSchema({}), false)
  assert.equal(guardSettingsSchema({ settings: {} }), false)
})

test('apply 端到端：三症状场景（null 条目 + describe/write 循环）全程不抛', () => {
  const listeners = []
  class FakeSettings {
    schema(entry) {
      const schema = entry?.fiber?.runtime?.Config
      return schema !== undefined && 'toJSON' in schema ? schema : undefined
    }
    describe(entries) {
      return entries.flatMap((e) => {
        const s = this.schema(e)
        return s === undefined ? [] : [s]
      })
    }
  }
  // 模拟 dsh-sync 在 adapter-compat 之后注册（bundles 顺序）
  const runtime = { Config: null }
  const entries = [{ fiber: { runtime } }, { fiber: { runtime: { Config: realSchema } } }]

  const ctx = {
    llm: { adapters: new Map(), registerAdapter: () => () => {} },
    settings: new FakeSettings(),
    configEditor: { entries: () => entries },
    get: () => undefined,
    on: (ev, fn) => { listeners.push([ev, fn]); return () => {} },
    effect: () => {},
    logger: { info: () => {}, warn: () => {} },
  }

  apply(ctx, {}) // 不抛即通过

  // 立即扫描：configEditor 源已把 null 归一
  assert.equal(runtime.Config, undefined)

  // describe/write 循环恢复
  assert.equal(ctx.settings.describe(entries).length, 1)
})
