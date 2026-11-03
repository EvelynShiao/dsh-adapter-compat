/** nl-utterance 单测（重建版）——19 项照第六批口径。 */
import test from "node:test";
import assert from "node:assert/strict";
import { translateKbUtterance, translateToolUtterance, translateUtterance, looksLikeUtteranceStart } from "../nl-utterance.js";

const tools = [
  { name: "knowledge_search", parameters: { required: ["query"], properties: {} } },
  { name: "archives_search", parameters: { required: ["query"], properties: {} } },
  { name: "read", parameters: { required: ["path"], properties: {} } },
];
const names = new Set(tools.map(t => t.name));

test("KB 第一层", () => assert.deepEqual(translateKbUtterance("我要调动第一层知识库，搜索光阳", names), { name: "knowledge_search", arguments: '{"query":"光阳"}' }));
test("KB 第二层", () => assert.deepEqual(translateKbUtterance("我要调动第二层知识库，搜索Lyma 光阳的雪", names), { name: "archives_search", arguments: '{"query":"Lyma 光阳的雪"}' }));
test("KB 带句号", () => assert.deepEqual(translateKbUtterance("我要调动第一层知识库，搜索光阳。", names), { name: "knowledge_search", arguments: '{"query":"光阳"}' }));
test("kb 关=不翻", () => assert.equal(translateUtterance("我要调动第一层知识库，搜索光阳", tools, { kb: false }), null));
test("工具不在", () => assert.equal(translateKbUtterance("我要调动第一层知识库，搜索光阳", new Set(["read"])), null));
test("空查询", () => assert.equal(translateKbUtterance("我要调动第一层知识库，搜索", names), null));
test("NL 参数JSON", () => assert.deepEqual(translateUtterance('我要用工具 read，参数 {"path": "C:/a.txt"}', tools, { kb: true, nl: true }), { name: "read", arguments: '{"path":"C:/a.txt"}' }));
test("NL 裸参数", () => assert.deepEqual(translateUtterance("我要调用 read，C:/b.txt", tools, { kb: true, nl: true }), { name: "read", arguments: '{"path":"C:/b.txt"}' }));
test("nl关=不翻", () => assert.equal(translateUtterance('我要用工具 read，参数 {}', tools, { kb: true, nl: false }), null));
test("工具不存在", () => assert.equal(translateUtterance("我要用工具 hack，参数 {}", tools, { kb: true, nl: true }), null));
test("坏JSON", () => assert.equal(translateUtterance("我要用工具 read，参数 {path: x}", tools, { kb: true, nl: true }), null));
test("普通聊天", () => assert.equal(translateUtterance("今天聊聊光阳吧", tools, { kb: true, nl: true }), null));
test("长文不翻（>400 字符整体超限）", () => {
  const long = "我要调动第一层知识库，搜索光阳 ——" + "补".repeat(500);
  assert.ok(long.length > 400);
  assert.equal(translateKbUtterance(long, names), null);
  assert.equal(translateUtterance(long, tools, { kb: true }), null);
});
test("句中提及", () => assert.equal(translateKbUtterance("关于「我要调动第一层知识库，搜索xx」这个功能", names), null));
test("前缀:我要调动", () => assert.equal(looksLikeUtteranceStart("我要调动第一层知识库"), true));
test("前缀:我要用工具", () => assert.equal(looksLikeUtteranceStart("我要用工具 read"), true));
test("前缀:普通", () => assert.equal(looksLikeUtteranceStart("今天的天气"), false));
test("前缀:太长", () => assert.equal(looksLikeUtteranceStart("我要" + "很长的开头".repeat(20)), false));
test("前缀:空", () => assert.equal(looksLikeUtteranceStart(""), false));
