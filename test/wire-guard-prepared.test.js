import { test } from 'node:test'
import assert from 'node:assert/strict'

import { installWireGuard } from '../wire-tap.js'

/**
 * 复刻新版 dsh-llm `adapterStream` 的门禁（lib/index.js:2301）：
 *   if (prepared !== void 0 && !callConfigEquals(options, prepared.config)) throw
 * callConfigEquals 只比 provider / model / reasoningEffort / temperature / maxTokens / stop。
 * 这里就是它在本测试里的替身——真正的门禁已由装机验证复现过（见提交说明）。
 */
function fakeLlm() {
  const seen = []
  const llm = {
    streamWithRegistration(options, prepared) {
      if (prepared !== undefined) {
        const cfg = prepared.config ?? {}
        const same = ['provider', 'model', 'reasoningEffort', 'temperature', 'maxTokens']
          .every((key) => options[key] === cfg[key])
        if (!same) throw new Error('prepared LLM call config changed before adapter dispatch')
      }
      seen.push({ options, prepared })
      return { options, prepared }
    },
  }
  return { llm, seen }
}

/** 约 88 万 token 的会话（实测出错那次同量级：887631 / 1048576）。 */
function bigMessages() {
  return [{ role: 'user', content: [{ type: 'text', text: 'a'.repeat(2600000) }] }]
}

test('预算闸压 maxTokens 时必须同步 prepared.config —— 否则新版宿主整轮报 INVALID_PREPARED_CALL', () => {
  const { llm, seen } = fakeLlm()
  const events = []
  installWireGuard(llm, { log: (e) => events.push(e), config: {} })

  const prepared = { config: Object.freeze({ provider: 'p', model: 'm', maxTokens: 256000 }) }
  const options = Object.freeze({ provider: 'p', model: 'm', maxTokens: 256000, messages: bigMessages(), contextWindow: 1048576 })

  assert.doesNotThrow(() => llm.streamWithRegistration(options, prepared))

  assert.equal(seen.length, 1)
  const { options: outOptions, prepared: outPrepared } = seen[0]
  assert.ok(outOptions.maxTokens < 256000, '确实压了 maxTokens')
  assert.equal(outPrepared.config.maxTokens, outOptions.maxTokens, '压过的值必须同步进 prepared.config')
  assert.equal(outPrepared.config.provider, 'p')
  assert.ok(events.some((e) => e.event === 'wire-budget' && e.clampedTo === outOptions.maxTokens))
  assert.ok(events.some((e) => e.event === 'wire-config-synced' && e.maxTokens === outOptions.maxTokens))
})

test('只改 messages（空 tool 结果补占位符）时不重建 prepared：配置没变就不用同步', () => {
  const { llm, seen } = fakeLlm()
  installWireGuard(llm, { log: () => {}, config: {} })

  const prepared = { config: Object.freeze({ provider: 'p', model: 'm', maxTokens: 8192 }) }
  const options = Object.freeze({
    provider: 'p',
    model: 'm',
    maxTokens: 8192,
    messages: [{ role: 'tool', toolCallId: 'c1', content: [] }],
    contextWindow: 1048576,
  })

  assert.doesNotThrow(() => llm.streamWithRegistration(options, prepared))
  assert.equal(seen[0].prepared, prepared, 'prepared 原样透传')
  assert.equal(seen[0].options.maxTokens, 8192, '配置未被改动')
  assert.equal(seen[0].options.messages[0].content[0].text, '[内容已清除]')
})

test('装得下时一个字段都不碰：options / prepared 原样透传', () => {
  const { llm, seen } = fakeLlm()
  installWireGuard(llm, { log: () => {}, config: {} })

  const prepared = { config: Object.freeze({ provider: 'p', model: 'm', maxTokens: 8192 }) }
  const options = Object.freeze({
    provider: 'p',
    model: 'm',
    maxTokens: 8192,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    contextWindow: 1048576,
  })

  llm.streamWithRegistration(options, prepared)
  assert.equal(seen[0].options, options)
  assert.equal(seen[0].prepared, prepared)
})
