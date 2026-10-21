/** 全局 .txt 三件套端到端验证：GET/POST /exit-prefs 三键读回环。 */
const API = "http://127.0.0.1:3080/dsh-adapter-compat/exit-prefs";

let pass = 0, total = 0;
const t = (label, cond) => { total++; if (cond) pass++; console.log(`${cond ? "✅" : "❌"} ${label}`); };

// ① GET 现状
const g1 = await fetch(API).then(r => r.json()).catch(() => ({ ok: false }));
t("① GET 可达", g1.ok === true && g1.value !== undefined);
const before = g1.value ?? {};

// ② POST 改三键
const post = await fetch(API, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ directSendThresholdChars: 7777, txtChunkBytes: 300000, chatOnly: true, kbProtocol: before.kbProtocol, nlToolProtocol: before.nlToolProtocol, titlePrefix: before.titlePrefix }),
}).then(r => r.json()).catch(() => ({ ok: false }));
t("② POST 改三键 ok", post.ok === true);

// ③ GET 读回
const g2 = await fetch(API).then(r => r.json()).catch(() => ({ ok: false }));
const v2 = g2.value ?? {};
t("③ directSendThresholdChars=7777", v2.directSendThresholdChars === 7777);
t("④ txtChunkBytes=300000", v2.txtChunkBytes === 300000);
t("⑤ chatOnly=true", v2.chatOnly === true);

// ④ webin config 真源
const cfg = await fetch("http://127.0.0.1:3080/dsh-webin/api/config").then(r => r.json()).catch(() => ({ config: {} }));
const c = cfg.config ?? {};
t("⑥ webin config 同源 direct=7777", Number(c.directSendThresholdChars) === 7777);
t("⑦ webin config 同源 chunk=300000", Number(c.txtChunkBytes) === 300000);
t("⑧ webin config 同源 chatOnly=true", c.chatOnly === true);

// ⑤ 恢复默认
const restore = await fetch(API, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ directSendThresholdChars: 6000, txtChunkBytes: 409600, chatOnly: false, kbProtocol: before.kbProtocol, nlToolProtocol: before.nlToolProtocol, titlePrefix: before.titlePrefix }),
}).then(r => r.json()).catch(() => ({ ok: false }));
const g3 = await fetch(API).then(r => r.json()).catch(() => ({ ok: false }));
t("⑨ 恢复默认", (g3.value ?? {}).directSendThresholdChars === 6000 && (g3.value ?? {}).txtChunkBytes === 409600);

console.log(`\n${pass}/${total} ${pass === total ? "全过 ✅" : "❌"}`);
