import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { digestRequest, recordWireRequest } from '../wire-tap.js'

test('digestRequest records protocol teaching and tool metadata without message bodies', () => {
  const result = digestRequest({
    provider: 'tiantian',
    model: 'deepseek-v4.1-flash',
    system: '我要调动第一层知识库',
    tools: [{ name: 'read', description: `描述${'x'.repeat(200)}` }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'secret' }] }],
  })

  assert.equal(result.provider, 'tiantian')
  assert.equal(result.model, 'deepseek-v4.1-flash')
  assert.equal(result.nlTeach, true)
  assert.equal(result.toolCount, 1)
  assert.equal(result.tools[0].name, 'read')
  assert.equal(result.tools[0].description.length, 160)
  assert.equal(result.messages[0].blocks[0].textLen, 6)
  assert.equal('text' in result.tools[0], false)
})

test('digestRequest reports absent tools and teaching safely', () => {
  const result = digestRequest({ messages: [] })

  assert.equal(result.nlTeach, false)
  assert.equal(result.toolCount, 0)
  assert.equal(result.tools, null)
})

test('recordWireRequest writes the final request digest to the bounded wire file', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-wire-digest-'))
  try {
    recordWireRequest({ provider: 'tiantian', model: 'deepseek-v4.1-flash', tools: [] }, home, 'adapter-dispatch')
    const line = readFileSync(join(home, 'llm-wire.jsonl'), 'utf8').trim()
    const result = JSON.parse(line)
    assert.equal(result.stage, 'adapter-dispatch')
    assert.equal(result.provider, 'tiantian')
    assert.equal(result.model, 'deepseek-v4.1-flash')
    assert.equal(result.toolCount, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
