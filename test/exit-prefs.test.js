/**
 * 压缩 .txt 出口 + 版本分页器开关：读写逻辑单测。
 *
 * 覆盖点（都是「写错就静默失效」的地方）：
 *   1. 默认值：webin 配置缺失时给 auto/100000，分页器默认隐藏；
 *   2. 合并写：只改给的键，**webin 配置里的其它键一个都不能丢**
 *      （delay/账号/edgeDriver 丢了 = 用户设置被清空）；
 *   3. 非法输入拒绝：模式不在枚举、阈值非正数、布尔非布尔 ⇒ ok:false 且不落盘；
 *   4. 原子写：不留下 .tmp 残骸。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  readExitPrefs,
  writeExitPrefs,
  exitPrefsPath,
  webinConfigPath,
  COMPACT_EXIT_DEFAULTS,
} from '../index.js'

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'cad-exit-'))
}

function seedWebinConfig(home, doc) {
  mkdirSync(join(home, 'webin'), { recursive: true })
  writeFileSync(webinConfigPath(home), JSON.stringify(doc, null, 2), 'utf8')
}

test('默认值：webin 配置缺失 ⇒ auto/100000，分页器默认隐藏', () => {
  const home = tempHome()
  const prefs = readExitPrefs(home)
  assert.equal(prefs.compactionFileMode, COMPACT_EXIT_DEFAULTS.compactionFileMode)
  assert.equal(prefs.compactionFileThresholdChars, COMPACT_EXIT_DEFAULTS.compactionFileThresholdChars)
  assert.equal(prefs.hideVersionPager, true)
})

test('合并写：webin 其它键必须原样保留（账号/间隔/edgeDriver）', () => {
  const home = tempHome()
  const original = {
    sendDelayMinMs: 2000,
    enableTools: true,
    edgeDriver: { enabled: true, port: 9411 },
    accounts: { deepseek: { slots: ['evelyn-deepseek'], active: 'evelyn-deepseek' } },
  }
  seedWebinConfig(home, original)
  const r = writeExitPrefs({ compactionFileMode: 'always', compactionFileThresholdChars: 50000 }, home)
  assert.equal(r.ok, true)
  const after = JSON.parse(readFileSync(webinConfigPath(home), 'utf8'))
  assert.equal(after.compactionFileMode, 'always')
  assert.equal(after.compactionFileThresholdChars, 50000)
  assert.equal(after.sendDelayMinMs, 2000)
  assert.equal(after.enableTools, true)
  assert.deepEqual(after.edgeDriver, { enabled: true, port: 9411 })
  assert.deepEqual(after.accounts.deepseek.slots, ['evelyn-deepseek'])
})

test('分页器开关独立存储，且只改它时不碰 webin 配置', () => {
  const home = tempHome()
  seedWebinConfig(home, { compactionFileMode: 'auto', sendDelayMaxMs: 4000 })
  const before = readFileSync(webinConfigPath(home), 'utf8')
  const r = writeExitPrefs({ hideVersionPager: false }, home)
  assert.equal(r.ok, true)
  assert.equal(readExitPrefs(home).hideVersionPager, false)
  assert.equal(readFileSync(webinConfigPath(home), 'utf8'), before)
  assert.equal(existsSync(exitPrefsPath(home)), true)
})

test('非法输入一律拒绝且不落盘', () => {
  const home = tempHome()
  seedWebinConfig(home, { compactionFileMode: 'never' })
  const r1 = writeExitPrefs({ compactionFileMode: 'sometimes' }, home)
  assert.equal(r1.ok, false)
  assert.match(String(r1.error), /compactionFileMode/)
  const r2 = writeExitPrefs({ compactionFileThresholdChars: -5 }, home)
  assert.equal(r2.ok, false)
  const r3 = writeExitPrefs({ hideVersionPager: 'yes' }, home)
  assert.equal(r3.ok, false)
  // 原值必须保持（拒绝 = 不改）
  assert.equal(readExitPrefs(home).compactionFileMode, 'never')
})

test('原子写：不残留 .tmp 文件', () => {
  const home = tempHome()
  seedWebinConfig(home, { compactionFileMode: 'auto' })
  assert.equal(writeExitPrefs({ compactionFileThresholdChars: 123456 }, home).ok, true)
  const leftovers = readdirSync(join(home, 'webin')).filter((f) => f.includes('.tmp-cad-'))
  assert.deepEqual(leftovers, [])
})
