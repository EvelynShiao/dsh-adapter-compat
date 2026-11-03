/** egress NL 层流式测试（重建版）——7 项。 */
import test from "node:test";
import assert from "node:assert/strict";
import { finalizeEgressText, normalizeEgressOptions } from "../egress.js";

const tools = [
  { name: "knowledge_search", parameters: { required: ["query"], properties: {} } },
  { name: "archives_search", parameters: { required: ["query"], properties: {} } },
];
const nlOn = { enabled: true, kb: true, nl: false };

test("finalize：KB 句式翻译成调用", () => {
  const r = finalizeEgressText("我要调动第一层知识库，搜索光阳", { nlUtterance: nlOn, tools });
  assert.ok(r.parts.includes("nl-utterance"));
  assert.equal(r.text, "");
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, "knowledge_search");
  assert.deepEqual(JSON.parse(r.calls[0].arguments), { query: "光阳" });
});

test("finalize：第二层 → archives_search", () => {
  const r = finalizeEgressText("我要调动第二层知识库，搜索Lyma", { nlUtterance: nlOn, tools });
  assert.equal(r.calls[0].name, "archives_search");
});

test("finalize：普通文本不动", () => {
  const r = finalizeEgressText("今天聊聊光阳", { nlUtterance: nlOn, tools });
  assert.equal(r.calls.length, 0);
  assert.equal(r.text, "今天聊聊光阳");
});

test("finalize：nlUtterance 未启用不翻", () => {
  const r = finalizeEgressText("我要调动第一层知识库，搜索光阳", { tools });
  assert.equal(r.calls.length, 0);
  assert.equal(r.text, "我要调动第一层知识库，搜索光阳");
});

test("finalize：kb 关掉不翻", () => {
  const r = finalizeEgressText("我要调动第一层知识库，搜索光阳", { nlUtterance: { enabled: true, kb: false, nl: false }, tools });
  assert.equal(r.calls.length, 0);
});

test("normalize：默认值", () => {
  const o = normalizeEgressOptions({});
  assert.equal(o.kbProtocol, true);
  assert.equal(o.nlToolProtocol, false);
});

test("finalize：thinking 剥离与 NL 叠加", () => {
  const r = finalizeEgressText("<thinking>internal</thinking>\n我要调动第一层知识库，搜索雪", { nlUtterance: nlOn, tools, thinking: true });
  assert.ok(r.parts.includes("thinking"));
  assert.ok(r.parts.includes("nl-utterance"));
  assert.equal(JSON.parse(r.calls[0].arguments).query, "雪");
});
