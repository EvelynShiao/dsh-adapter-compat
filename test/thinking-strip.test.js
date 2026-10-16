/**
 * <thinking> 标签剥离单测（2026-10-16 用户截图实证的「思考链被当正文」）。
 *
 * 实测现场：正文 = `<thinking>…</thinking>`（长度与 reasoning 块完全相同），
 * 即上游把思考同时写进了 content。剥离规则是**只剥正文开头**那一段 ——
 * 正文中间/后面出现的标签要保留（那可能是引用别人的输出，或在讨论标签本身）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { stripLeadingThinking } from '../index.js'

test('整段开头 <thinking> 被剥掉，后面的真正正文保留', () => {
  const r = stripLeadingThinking('<thinking>我在想事情</thinking>真正的回答')
  assert.equal(r.text, '真正的回答')
  assert.equal(r.inTag, false)
  assert.equal(r.changed, true)
})

test('正文就是整段思考（无正文）⇒ 清空', () => {
  const r = stripLeadingThinking('<thinking>只有思考，没有回答</thinking>')
  assert.equal(r.text, '')
  assert.equal(r.changed, true)
})

test('前导空白/大小写/属性都不影响识别', () => {
  assert.equal(stripLeadingThinking('\n  <THINKING>  想  </THINKING>答案').text, '答案')
  assert.equal(stripLeadingThinking('<thinking type="reasoning">想</thinking>答案').text, '答案')
})

test('正文中间/后面的标签**不**被剥（避免误伤引用与讨论）', () => {
  const text = '这是普通回答，里面引用了 <thinking>别人的思考</thinking> 这个标签。'
  const r = stripLeadingThinking(text)
  assert.equal(r.text, text)
  assert.equal(r.changed, false)
})

test('流式：标签被切在两个 delta 之间（跨段累积）', () => {
  // 第一段：只有开标签的前半 —— 什么都不该吐出去
  const a = stripLeadingThinking('<thin')
  assert.equal(a.text, '')
  assert.equal(a.pending, '<thin')
  // 第二段：补上剩余并闭合
  const b = stripLeadingThinking(a.pending + 'king>思考中</thinking>回答')
  assert.equal(b.text, '回答')
  assert.equal(b.inTag, false)
})

test('流式：开标签完整但闭合还没来 ⇒ 进思考态，后续段继续丢到闭合为止', () => {
  const a = stripLeadingThinking('<thinking>思考第一段')
  assert.equal(a.text, '')
  assert.equal(a.inTag, true)
  const b = stripLeadingThinking('思考第二段</thinking>真正的回答', a.inTag)
  assert.equal(b.text, '真正的回答')
  assert.equal(b.inTag, false)
})

test('流式：闭合标签本身也可能被切开', () => {
  const a = stripLeadingThinking('<thinking>思考')
  const b = stripLeadingThinking(a.pending + '思考</thin', a.inTag)
  assert.equal(b.text, '')
  assert.equal(b.inTag, true, '闭合不完整时仍应停在思考态')
  assert.equal(b.pending, '</thin', '半个闭合标签要留进 pending（否则下一段拼不回来）')
  const c = stripLeadingThinking(b.pending + 'king>回答', b.inTag)
  assert.equal(c.text, '回答')
  assert.equal(c.inTag, false)
})

test('连续两段思考（模型分两段写）⇒ 都剥掉', () => {
  const r = stripLeadingThinking('<thinking>一</thinking><thinking>二</thinking>答案')
  assert.equal(r.text, '答案')
})

test('普通正文（无标签）原样返回，changed=false', () => {
  const r = stripLeadingThinking('就是一句普通回答。')
  assert.equal(r.text, '就是一句普通回答。')
  assert.equal(r.changed, false)
  assert.equal(r.inTag, false)
})
