/**
 * 中文工具名/描述覆盖测试（2026-10-30 真机矩阵 3.C 验收的回归锁）。
 *
 * 背景：真机矩阵 3.C（zhToolNames=true）实测 54 个工具里 3 个描述退回英文
 * （exit_plan_mode / read_image / skill——宿主全量目录比 10-29 多出的工具没进映射表）。
 * 本文件锁三件事：
 *   ① 3.C 当晚发现的 3 个漏网工具必须有中文描述 + 中文名；
 *   ② 知识库 9 件套（kbTrim 幸存集合）描述全覆盖（第 4 条验收的「都是中文名无代码」）；
 *   ③ 中文名↔英文名反向映射自洽（enToolName(zh)===en）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { zhToolName, enToolName, ZH_TOOL_DESCRIPTIONS, TOOL_ZH_NAMES } from '../tool-names.js'

test('3.C 实测漏网的 3 个工具已有中文描述与中文名', () => {
  for (const name of ['exit_plan_mode', 'read_image', 'skill']) {
    assert.ok(/[\u4e00-\u9fff]/.test(ZH_TOOL_DESCRIPTIONS[name] ?? ''), `${name} 描述应为中文`)
    assert.notEqual(zhToolName(name), name, `${name} 应有中文名`)
  }
})

test('知识库 9 件套描述全覆盖（kbTrim 幸存集合）', () => {
  const kbTools = ['knowledge_search', 'knowledge_list', 'knowledge_tags', 'knowledge_write', 'knowledge_update', 'knowledge_delete', 'knowledge_vec', 'knowledge_probe', 'archives_search']
  for (const name of kbTools) {
    assert.ok(/[\u4e00-\u9fff]/.test(ZH_TOOL_DESCRIPTIONS[name] ?? ''), `${name} 描述应为中文`)
  }
})

test('名字表与描述表的键互为英文真名且反向映射自洽', () => {
  for (const [en, zh] of Object.entries(TOOL_ZH_NAMES)) {
    assert.equal(enToolName(zh), en, `反向映射失败: ${zh} -> ${en}`)
  }
  for (const en of Object.keys(ZH_TOOL_DESCRIPTIONS)) {
    assert.ok(!/^\s*$/.test(ZH_TOOL_DESCRIPTIONS[en]), `${en} 描述不能为空`)
  }
})
