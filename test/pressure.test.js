import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  calibratePressureView,
  calibrateContextPressure,
  PRESSURE_CALIBRATED,
  PRESSURE_MIN_SAMPLE,
  PRESSURE_MAX_RATIO,
} from '../index.js'

test('官方公式在中文会话里少算一半：校准把启发式增量按实测倍率放大', () => {
  const state = { pressureTokens: 200000, surfaceTokens: 150000, sampledSurfaceTokens: 100000 }
  const official = { contextWindow: 1048576, pressureTokens: 200000, projectedTokens: 250000 }
  const out = calibratePressureView(state, official)
  // ratio = 2 → 200000 + (150000-100000)*2 = 300000
  assert.equal(out.projectedTokens, 300000)
  assert.equal(out.pressureTokens, 200000)
  assert.equal(out.contextWindow, 1048576)
})

test('真实数据（DeepSeek(1) 会话）复算', () => {
  const state = { pressureTokens: 462816, surfaceTokens: 215111, sampledSurfaceTokens: 215063 }
  const official = { contextWindow: 1048576, pressureTokens: 462816, projectedTokens: 462864 }
  const out = calibratePressureView(state, official)
  const ratio = 462816 / 215063
  assert.equal(out.projectedTokens, Math.max(0, Math.round(462816 + (215111 - 215063) * ratio)))
  assert.ok(out.projectedTokens >= official.projectedTokens)
})

test('样本量不足时原样退回官方值（不猜）', () => {
  const state = { pressureTokens: 500000, surfaceTokens: 10, sampledSurfaceTokens: PRESSURE_MIN_SAMPLE - 1 }
  const official = { pressureTokens: 500000, projectedTokens: 500000 + 10 - (PRESSURE_MIN_SAMPLE - 1) }
  assert.deepEqual(calibratePressureView(state, official), official)
})

test('倍率异常时原样退回官方值', () => {
  const official = { pressureTokens: 900000, projectedTokens: 900000 }
  // ratio = 900000/10000 = 90 > 8
  assert.deepEqual(
    calibratePressureView({ pressureTokens: 900000, surfaceTokens: 11000, sampledSurfaceTokens: 10000 }, official),
    official,
  )
  // ratio <= 0（pressure 为 0）
  assert.deepEqual(
    calibratePressureView({ pressureTokens: 0, surfaceTokens: 10000, sampledSurfaceTokens: 10000 }, official),
    official,
  )
})

test('缺字段/非对象输入一律安全退回', () => {
  const official = { pressureTokens: 1, projectedTokens: 2 }
  assert.deepEqual(calibratePressureView(undefined, official), official)
  assert.deepEqual(calibratePressureView({}, official), official)
  assert.deepEqual(calibratePressureView({ pressureTokens: 1, surfaceTokens: 2 }, official), official)
  assert.equal(calibratePressureView({ pressureTokens: 1, surfaceTokens: 2, sampledSurfaceTokens: 3 }, undefined), undefined)
})

test('倍率上界之内正常生效，且结果非负', () => {
  const state = { pressureTokens: 80000, surfaceTokens: 10000, sampledSurfaceTokens: 10000 }
  const official = { pressureTokens: 80000, projectedTokens: 80000 }
  const out = calibratePressureView(state, official)
  assert.equal(out.projectedTokens, 80000) // 增量为 0，倍率不影响
  const shrink = calibratePressureView(
    { pressureTokens: 80000, surfaceTokens: 5000, sampledSurfaceTokens: 10000 },
    { pressureTokens: 80000, projectedTokens: 75000 },
  )
  assert.equal(shrink.projectedTokens, 80000 + (5000 - 10000) * 8)
})

test('calibrateContextPressure：已注册单元被就地包裹且幂等', () => {
  const definition = {
    key: 'contextPressure',
    wire: {
      viewSchema: { parse: (v) => v },
      view: ({ pressureTokens, surfaceTokens, sampledSurfaceTokens }) => ({
        pressureTokens,
        projectedTokens: pressureTokens + surfaceTokens - sampledSurfaceTokens,
      }),
    },
  }
  // 模拟官方 register：把 wire 对象按引用捕获
  const captured = { view: (state) => definition.wire.view(state) }
  const registrations = new Map([['contextPressure', { def: { key: 'contextPressure', wire: captured } }]])
  const projections = { registrations, register: (def) => def }

  assert.equal(calibrateContextPressure(projections), 1)
  const state = { pressureTokens: 200000, surfaceTokens: 150000, sampledSurfaceTokens: 100000 }
  assert.equal(captured.view(state).projectedTokens, 300000)
  assert.ok(captured.view[PRESSURE_CALIBRATED])

  // 幂等：再调一次不再包装
  assert.equal(calibrateContextPressure(projections), 0)
  assert.equal(captured.view(state).projectedTokens, 300000)
})

test('calibrateContextPressure：晚注册（register 包装）路径也生效', () => {
  const registered = []
  const projections = { registrations: new Map(), register: (def) => registered.push(def) }
  assert.equal(typeof calibrateContextPressure(projections), 'number')
  // 本插件加载后才注册的单元，经包装后的 register 进入时即被校准
  projections.register({
    key: 'contextPressure',
    wire: {
      view: ({ pressureTokens, surfaceTokens, sampledSurfaceTokens }) => ({
        projectedTokens: pressureTokens + surfaceTokens - sampledSurfaceTokens,
      }),
    },
  })
  const state = { pressureTokens: 200000, surfaceTokens: 150000, sampledSurfaceTokens: 100000 }
  assert.equal(registered[0].wire.view(state).projectedTokens, 300000)
  // 其他 key 不碰
  projections.register({ key: 'title', wire: { view: () => ({ title: 'x' }) } })
  assert.equal(registered[1].wire.view({}).title, 'x')
})

test('calibrateContextPressure：缺服务时不炸', () => {
  assert.equal(calibrateContextPressure(undefined), 0)
  assert.equal(calibrateContextPressure({}), 0)
  assert.equal(PRESSURE_MAX_RATIO, 8)
})
