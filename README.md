# dsh-adapter-compat

### 9999.9.33：删除守卫 —— 可见会话永不真删

**事故（2026-10-16，双侧实测）**：真删除把 `dsh-session-kit` 的记忆快照轮换事件
（`kind = dsh-session-kit-memory-eject`）误判成「用户删轮墓碑」，按被遮蔽节点的
`data.turn` 反推出整轮 → `excise` 整轮物理切除。实测手机 `session-7e75046b` 712→467、
电脑 `session-afa6ba0b` 2077→1759；表现是「每重启一次 DSH 就少一大段对话」，
而**用户没有删任何东西**。另有一次人工误操作：用 API 调 `/versions/purge`
删掉 11 个在侧栏里**用户看得见**的会话（6 个无法找回）。

三层加固（本次提交）：

1. **整轮切除的误判修掉**（`purge.js`）：`needsNodeLookup` 分支**一律只外科摘除被遮蔽节点**，
   绝不整轮。该类载体只可能来自 `dsh-session-kit-` 前缀（`memory-context` / `memory-eject` /
   将来的变体），与「用户删轮」无关；不再用 `legacy-turn-fallback` / `surfacepos` 猜轮号
   —— 猜错一次就是用户几百个事件。真实备份干跑复验：要删事件 245/318 → 2/2/7，整轮 0。
2. **删除守卫**（`guardDeletion`，所有真删入口强制经过）：
   - 登记表（`storages/workspace.json` 的 `sessionIds` / `archivedSessionIds`）里的
     **可见会话 → 硬拒绝**（不是提示，是拒绝执行，`confirmBulk` 也无效）；
   - 当前会话（`DSH_SESSION_ID`）→ 拒绝；
   - 一次超过 3 个 → 必须显式 `confirmBulk: true`。
3. **取消一切自动删除**：`installInvisibleSweeper` 的 boot / interval 定时器移除，
   只能由面板按钮显式触发一次；`cordis.patch.yml` 里 `sweepInvisible: false`。
   真删除保持**真删除**语义（不加回收站——用户否决：「这不是真删除」）。

顺带修掉一个潜伏 bug：`currentSessionId()` 被调用但**从未定义**（HEAD 里就是悬空的），
扫除器一旦运行就会 `ReferenceError`；守卫上线后被单测抓到并补上定义。

测试：`test/memory-carrier-no-turn.test.js`（4 例：eject / context / 未来变体 / 带 turn 也不整轮）、
`test/delete-guard.test.js`（7 例：可见拒绝 / 归档保护 / 批量上限 / 登记表坏形状 / 空输入）。
全量 139 通过 / 0 失败。

### 9999.9.23：统一清除正文占位

瘦身、墓碑清除、缺失结果修复与请求出口统一使用 `[内容已清除]`，明确标识正文不可用，不再生成含义不明的 `[NaN]`。墓碑清除先擦正文再填占位，防止占位被二次擦空；缺失工具名单独使用协议标识符 `unknown_tool`。不批量改写既有历史或非空工具输出。

DSH LLM adapter **兼容垫片** + **自动压缩硬闸**：

1. **回填层**：在 adapter 注册时回填缺失的 `LlmAdapter` 基类默认方法，修复 `/compact` 因 `xxx is not a function` 静默失败；
2. **硬闸层（v1.1.0）**：把压缩引擎的 `compactIfNeeded` 恒置为"无需压缩"，**从代码层彻底关闭自动压缩**——手动 `/compact` 完全不受影响。

> 独立插件，不依赖、不修改任何被保护插件的源码，也**不依赖任何配置文件**。被保护插件（如 `dsh-our-free-model`）即使被强制更新换回裸类，下一次注册仍会被本插件兜住——**它的更新机制无法移除这个修复**；`cordis.patch.yml` 被 sync 覆盖、`auto` 配置回滚到默认 `true` 也一样拦得住。

## 根因

`@deepseek-ai/dsh-llm` 的 `LlmRuntime` 在 token 计价/压缩路径上**无条件**调用：

```js
imageRequestPricing(provider, model) {
  return this.adapters.get(provider)?.adapter.imageRequestPricing(provider, model);
}
```

`?.` 只保护 *adapter 不存在*，不保护 *方法不存在*。官方 adapter 都 `extends LlmAdapter`（基类带默认空实现）；第三方**裸类** adapter（例如 `dsh-our-free-model` 1.3.1——刻意不继承基类以便挂载多条内核线）没实现该方法 → 压缩一启动、token meter 一计价就抛：

```
this.adapters.get(...)?.adapter.imageRequestPricing is not a function
```

异常被静默吞掉 → 80% 阈值永不触发、手动 `/compact` 无反应。窗口涨到 98.5% 也不会压。

## 修法（运行时垫片）

1. **包装 `ctx.llm.registerAdapter`**：任何 adapter 在交给宿主前先被回填缺失方法（只补缺、绝不覆盖已有实现）。必须在调用原始方法*之前*回填——宿主的 `providerInfo`/`providerRetryPolicy` 校验发生在 `registerAdapter` 内部。
2. **apply 时扫描 `ctx.llm.adapters`**：把先于本插件加载的注册补一遍。
3. **监听 `llm/adapters-updated`**：覆盖热重载/`replace()` 等旁路。

回填表逐行镜像自 `dsh-llm` 基类默认实现（`providerInfo` / `providerRetryPolicy` / `imageRequestPricing` / `listModels` / `resolveModel` / `prepareCall`），语义与基类一致。

## 硬闸层：彻底关闭自动压缩（v1.1.0）

宿主自动压缩的唯一咽喉是 `BasicCompactionEngine.compactIfNeeded()`，两个自动触发器（每步压力 `pressure`、请求溢出恢复 `context-overflow`）都经过它；**手动 `/compact` 走的是另一条完全独立的 `compactNow()`，从不经过它**。硬闸把 `compactIfNeeded` 替换为恒返回 `null`（宿主语义 = 无需压缩，调用方静默跳过）：

- **与配置无关**：`cordis.patch.yml` 被 sync 整文件盖掉、`auto` 回到默认 `true`、监听器照常注册——事件触发时调到的也是这道闸；
- **与实例无关**：instance + prototype 双层打标，preset 作用域的引擎在首次 `agent/pre-step` 时补闸（`prepend`，先于 compaction-basic 自己的监听执行）；
- **手动无损**：`compactNow`（`/compact` 命令入口）一概不碰；
- **代价（预期行为）**：窗口真爆时不再自动压缩救场，而是原样报 context-overflow 错——手动 `/compact` 兜底。这正是"不要自动压缩"的应有之义。

恢复官方行为：`cordis.patch.yml` 本插件行 `config: { autoGate: false }` + 重启。

生效条件：插件代码在 composition 构建时读取一次，**改动后需重启 DSH**。

## 第七层：受保护系统头守卫（9999.9.13）

宿主 `dsh-session-format-v3-to-v4` 的表层状态机只认一种合法头：**首个 append 到空表层的
`system/message`**（表层节点 0，受保护）。缺了它，日志**当下还能读**（宿主的规则只在
"表层非空 + 还没有受保护头时又 append 一条 system" 才拒绝），但这是一颗哑弹：
下一轮系统提示词一变（换模型、工具集变化、新请求系列），宿主的 `SystemPromptProjection`
就会 append 一条新的 `system/message` → 落盘即永久损坏：

```
stored session "session-xxx" is corrupt:
  system/message requires a protected first surface head
```

老版 `excise`/`planPurge` 的"头序自愈"正是这种情况下的最坏选择：**删光全部 system/message**，
理由写的是"宿主不罚缺失，无头=合法"——合法是对的，脆弱也是真的，会话就埋在那儿等下一次引爆。

本层做三件事：

1. **补头**：`head-guard.js` 在首个表面节点前插一条**空** `system/message` 占位头，
   其后所有 `seq` 与 `seq` 引用（`surfaceOp.*`、`sourceEventSeqs`、`shadowedRange/Seqs`、
   `headerSeq`、`messageSeq(s)`、`throughSeq`、`sourceEventSeq`）整体 +1，保持 seq 密集。
   空内容不是"没提示词"：宿主 `project()` 把它当占位头，下一轮会用渲染好的提示词替换它。
   预筛只读文件前缀（`probeProtectedHead`），只有确实缺头才整读整写。
2. **收敛级联**：`excise`/`planPurge` 不再"删光全部 system"，只拔**真的会迟到**的
   append（`lateSystemAppends`，逐轮算到不动点）。合法的 replacement 载体被牵连拔掉，
   会把它遮蔽的内容整段"复活"——那同样是在毁历史。

3. **去重复块**（与补头同一条流水线）：同步下载/写盘重试会把同一段事件原地写两遍
   （两份逐字节相同）→ seq 回跳 → 宿主报 `released v2 row N has seq gap`。
   `guardSessionFile` 在 `verify` 不过时先试去重（丢掉重复的那一份、seq 重新密集），
   治好再验。**这两类病之外**的坏文件一个字节都不动，只报 `problems`。
4. **对齐 tool/result 替换**（9999.9.14）：宿主规定 `tool/result` 的**替换体**除
   `message.content` 外必须与被遮蔽原事件逐字节一致（`assertToolResultRewrite`），
   否则整份日志以 `invalid seed event at index N: tool/result surface replacement may
   change only content` 拒载。2026-10-11 实锤自伤两处，都已从源头修掉：
   - `redactEventPayload` 的 `scrubDeep(data)` 会一路清掉 `meta.lines[].text`，替换体随即与原事件不一致；
     现在**先深拷贝入参、再擦、最后原样还原 `meta`**——顺带修掉「原地改坏调用方事件」（浅拷贝 + 深擦会让
     内存与磁盘分叉）；`verify` 也补上了这条规则，任何写入器再犯都会被自己的写盘门拦下。
   - 历史遗留的这类错位由守卫自动对齐：把原事件的 `data` 整份搬过来、只保留替换体自己的 `content`
     —— 占位正文照留，省上下文的收益不变。

触发时机：开机 4s/25s 各全扫一次（只读前缀预筛，缺头才动手）+ **开机 45s 补一次深扫**
（整读 + verify，连不在前缀里的重复块/断口一起治）+ 会话目录变化后（预筛）+ 真删除写盘后
定向深扫。没伤病时开机那次也只留一行摘要（`head-guard[boot-deep+45s] scanned=… written=0`），
免得"守卫到底在不在跑"只能靠猜。
**live 会话绝不碰**（内存事件数组必须与文件对齐）；写盘前 `verify`（宿主规则移植版）不许过
就分毫不动，写盘后回读复核，坏文件先备份到 `$DSH_HOME/backup-head-guard/`。

恢复官方行为：`cordis.patch.yml` 本插件行 `config: { headGuard: false }` + 重启。

## 第八层：断号修复（9999.9.20）

症状（2026-10-12 实证，session-790e9a59）：**强退 DSH 会丢掉一次未落盘的追加批次**，
重启后宿主按内存续写，会话文件中间出现 seq 断号——zstd 帧结构完整、checksum 都对，
历史加载却报 `corrupt Zstandard session log: complete frame contains a torn JSONL record`
（误导文案：不是 zstd 撕裂，是断号让 committedBytes 停滞）。宿主自带的自愈只覆盖**尾部
撕裂**（截断丢弃），中间断号覆盖不到 → 历史打不开。典型断点：`tool/call` 之后缺
`tool/result` + `step/end`（工具执行中强退）。

修法 = 按上下文补行，不重编号、不动任何既有行：

- 只认从工具协议可**确定性推断**的形态：`tool/call` 后缺 1 行 → 补 `tool/result`；
  缺 2 行且下一跳是 `step/start` → 补 `[tool/result, step/end]`。其余形态一律只报告
  不动手（`unsupported`），绝不猜；
- 合成行占位正文 `[内容已清除]`（与 slim 同一惯例）；`sourceEventSeqs`/`surfaceOp` 放顶层信封；
- `verify`（宿主规则移植版）全绿才落盘：先备份到 `$DSH_HOME/backup-true-delete-repair/`，
  写完读回复核，不过就回滚；live 会话 409 拒写；
- 干跑默认，`write: true` 才改文件。

路由（重启 DSH 后生效）：

```bash
# 巡检全部会话（只读）：列出断号/不可读会话
curl http://127.0.0.1:<port>/dsh-adapter-compat/repair-scan
# 干跑诊断单个会话
curl -X POST http://127.0.0.1:<port>/dsh-adapter-compat/repair-session \
  -d '{"sessionId":"session-xxxx"}'
# 确认无误后落盘修复
curl -X POST http://127.0.0.1:<port>/dsh-adapter-compat/repair-session \
  -d '{"sessionId":"session-xxxx","write":true}'
```

关掉：`cordis.patch.yml` 本插件行 `config: { repairSession: false }` + 重启。

## 第九层：压缩摘要跟随「当前选中模型」（9999.9.22）

症状（2026-10-14 16:36 实证，session-fd76557f）：在 UI 里把模型切成一个能用的，
再点 `/compact`，报的还是旧模型的错——

```
16:16:52  request/header    deepseek-official/deepseek-flash   ← 最后一次真正派发过的请求
16:35:25  model/selection   dsh/deepseek-v4.1-flash            ← 用户切换的模型
16:36:57  compaction/end    ERROR: Insufficient Balance
```

根因：摘要那一次请求的模型解析链是 `configured ?? latest ?? agentTarget`，其中
`latest = agent.session.requestHeader()?.config`，而 `request/header` 事件只在请求
**真正被派发**时写入（`dsh-agent-loop`；且 header 与上次相同时不写事件）。
所以「在 UI 里切了模型、但还没有一条消息真正路由出去」时，`latest` 仍是旧模型——
切模型等于没切。另外界面上那句
`Compaction could not produce a useful summary.` 只是错误码 `summary` 的固定文案，
是「摘要那一步失败」的统称，**不代表摘要质量差**；402 余额不足、网络 transport 失败
全都落到这一句上，排查时别被它带偏。

修法：包装 `BasicCompactionEngine.summarize()`，调用期间把 `this.config` 的摘要目标
临时钉到宿主 `modelSelection` 投影的 `pending ?? lastUsed`：

- `pending` = 在 UI 里选了、还没有任何已派发请求消费掉的选择；
- `lastUsed` = 上一次真正派发过的请求用的路由；
- 取 `pending ?? lastUsed`，与 UI 上「下一个请求会用谁」语义完全一致。

要点：

- 不碰任何核心文件，不改 `cordis.patch.yml`，DSH 升级后依然生效；
- 与 `autoGate` 解耦：关掉自动压缩硬闸时，手动 `/compact` 照样跟随当前选中模型；
- `config` 是 `deepFreeze` 过的对象，所以换的是实例上的引用，不是改对象本身；
- `finally` 无条件还原，异常 / 取消 / 超时路径都覆盖；
- 任何一步拿不到投影就静默回退到宿主原逻辑，垫片绝不反过来弄挂宿主。

注意：本层只解决「压缩用哪个模型」，不解决「那个模型本身能不能用」。当前选中的模型
若余额不足或网络不通，压缩仍会失败——区别是它现在会老实按你选的那个打，而且切完模型
立刻生效，不需要先成功发一条消息。

## 第十层：压缩 .txt 出口设置 + 版本分页器开关（9999.9.24）

用户要求（2026-10-16）：「点了分叉会话或修改过对话后下面总有『版本切换』按钮，
能不能禁了」+「`.txt 出口设置` 改到 Adapter 插件上」。

### ① 「版本切换」按钮默认隐藏

那个按钮是 **dsh-easyrewrite** 的版本分页器（撤回/编辑重发的版本切换），
DOM 标记 `data-dsh-easyrewrite="version-pager"`。

本层**不碰 easyrewrite 一个字节**：客户端半身按偏好注入一条 CSS：

```css
[data-dsh-easyrewrite="version-pager"]{display:none !important}
```

- 模块加载即生效（不等用户打开设置页），否则分叉会话后仍会先看到按钮；
- 设置页可切回显示（开关状态存 `~/.dsh/adapter-compat-exit.json`）。

### ② 压缩 .txt 出口设置入口

设置 → 会话与提示词 → **压缩出口与版本分页器**，三样可调：

| 项目 | 说明 |
|---|---|
| 压缩 .txt 出口 | `never`（压缩不走网页，直接拒绝）/ `auto`（超阈值才打包 `.txt`）/ `always`（一律打包） |
| 直接发送阈值 | auto 模式的分界（字符），默认 100000 |
| 「版本切换」按钮 | 已隐藏 / 显示中 |

**值写真源仍是 webin 的 `~/.dsh/webin/config.json`**（`compactionFileMode` /
`compactionFileThresholdChars`）——因为出口行为由 webin 执行，本层只当设置面板，
两套配置不会打架。webin 每次请求都 `readConfig()` 现读，所以**改完即时生效、不用重启**。

要点：

- 只改「隐藏分页器」时**不动 webin 配置**（少写少险，写错就是清空用户设置）；
- 合并写：webin 配置里的其它键（delay / 账号 / edgeDriver）原样保留；
- 非法值一律拒绝并返回原因，不静默回退；
- 原子写（临时文件 + rename），不残留 `.tmp`。

单测：`node --test test/exit-prefs.test.js`（默认值 / 合并写保留其它键 / 只改分页器不碰 webin 配置 / 非法输入拒绝 / 无 `.tmp` 残留）。

## 第十一层：版本家族保护 + 磁盘清理（9999.9.25）

用户实测（2026-10-16）两个问题：

1. 「分叉/版本切换占磁盘吗，占的话希望清掉，我自己点了分叉又何必再备份一次」；
2. 「那个版本切换会触发我其他插件的真删除」。

### 事实（实测数据）

DSH 分叉走 `@deepseek-ai/dsh-session/fork` 的 `buildForkSeed`：把父会话的**事件前缀复制**进新会话，
新会话 header 记 `parentSession`。所以分叉**确实等于复制一份历史**。

本机扫描（102 个会话）：**17 条分叉产物、合计 21.97 MB**，其中从 `session-43c4199d` 分叉出的
`session-72185b36` 单条 4.63 MB。

### A. 旧版本受保护：真删除跳过家族成员

切换版本会往另一个分支写墓碑；本插件的 true-delete 一旦处理，就会把那个分支的内容**物理切除**，
旧版本再也回不去。所以 `purgeTombstones()` 现在默认跳过「版本家族成员」（有 `parentSession`
的会话 + 被子会话引用的父会话），只记账不动刀。

- 判据来自 session header 顶层的 `parentSession`（⚠️ 不在 `data` 里，第一版读错导致家族扫描全 0）；
- 家族按**最顶层祖先**聚合：多层分叉算同一个家族；
- **孤儿分叉**（父会话已被删）同样保护、同样计入体积；
- 索引缓存 30s，清理链不会被全盘读头拖慢；
- 想真删：走 `/versions/purge`（显式请求），不走自动路径。

### B. 设置页可手动清理

设置 → 会话日志修复 → **版本家族与磁盘占用**（折叠子块）：

- 汇总：家族数 / 分叉条数 / 分叉占多少 MB / 全部会话多少 MB；
- 每个家族列出成员（`根` / `分叉` / `·孤` 标记、各自体积、时间）；
- 「清理旧版本」= 删除该家族里**除根以外**的全部分叉（两步确认，真删不留副本）；
- 正在运行的会话一律跳过（`live-refused`），不会删到手上这条。

路由：`GET /dsh-adapter-compat/versions`、`POST /dsh-adapter-compat/versions/purge`。

单测：`node --test test/version-family.test.js`（顶层字段 / 家族聚合 / 孤儿分叉 / 单会话不算家族 / 保护集合）。

## 安装

电脑（profile 目录 = 你的 DSH profile，如 `~/.dsh/profiles/web`）：

```bash
# 1. profile 的 package.json：
#    dependencies 加一行    "dsh-adapter-compat": "github:EvelynShiao/dsh-adapter-compat"
#    dsh.profile.bundles 加一项  "dsh-adapter-compat"（放在 adapter 插件之前更稳，但不是必须）
# 2. 然后：
pnpm install
# 3. 彻底退出 DSH 再重开（不是关窗口）
```

手机端：同样的两处修改 + `pnpm install` + 重启。本仓库公有，匿名可拉。

## 验证

```bash
node --test test/compat.test.js test/gate.test.js test/guard.test.js test/inbox-rewrite.test.js test/pressure.test.js test/slim.test.js test/head-guard.test.js test/title-warm.test.js test/true-delete.test.js
```

- 回填层：装完后开个新会话敲 `/compact`，回 `Compacted N history items (~X tokens)` 即修好；还报 `imageRequestPricing is not a function` → 本插件没被加载，检查 bundles 列表。
- 硬闸层：重启后 DSH 日志应出现 `[adapter-compat] auto-compaction gate armed`；此后无论怎么聊，**不应再出现任何非手动触发的 `compaction/start` 事件**（`command/run compact` 手动触发的除外）。
- 头守卫层：日志（`$DSH_HOME/dsh-adapter-compat.log`）出现 `head-guard[...] written=N ...` 就是补过头；
  之后再也看不到 `requires a protected first surface head`。

## 仓库

- GitHub（公有，供手机端下载）：https://github.com/EvelynShiao/dsh-adapter-compat
- GitCode（私有备份）：https://gitcode.com/gcw_wXIDw07q/dsh-adapter-compat

上游问题参考：zouyuxuan122/dsh-our-free-model#42（上游 1.4.4 起已自带该方法；本垫片对任何版本、任何裸类 adapter 都生效）。

## License

MIT

## 第十二层：可见性清理（9999.9.26）

用户规则（原话）：「我只要左边我用的能看见的，不看见的不要留着，从源头上断绝」。

判据来自宿主登记表 `storages/workspace.json`：

| 来源 | 含义 | 处理 |
|---|---|---|
| `tables.workspaces[<wid>].sessionIds` | 侧栏能选出来的会话 | **正本，保留** |
| `global.archivedSessionIds` | 收起但能展开的 | 保留 |
| 盘上有文件、登记表里都没有 | **不可见** | 清理对象 |

实测（本机）：可见 91 条 / 31.75 MB，不可见 11 条 / 1.88 MB —— 那 11 条已按此规则删除（freedMB=1.88）。
注意：3~4.6 MB 的大文件全在侧栏里（是正本），所以「删所有分叉」会误删在用会话。

### 自动扫除（默认关，本机已在 cordis.patch.yml 打开）

`sweepInvisible: true` 后：开机 90s 首扫 + 每 10 分钟一次，删「不可见 && 非 live && 静默超 30 分钟」的会话。

四道安全阀（缺一不可，任一不满足就跳过）：

1. 登记表读不到 / 结构异常（含 `tables.workspaces` 是数组）→ 整轮放弃；
2. `DSH_SESSION_ID` 指向的当前会话 → 永不删；
3. live（内存里活着）→ 跳过；
4. 静默未满宽限（默认 30 分钟）→ 跳过（刚分叉/刚建那会儿会话还没登记）。

另有一条兜底闸：**可见数为 0 而盘上却有会话 ⇒ 拒绝清理**（疑似登记表被重置，否则一次就把所有会话扫光）。

### 已知限制（诚实说明）

DSH 的 workspace registry **没有「移除会话」API**（只有 create / rename / delete 工作区 / insertBefore /
insertSessionBefore / archive / unarchive / pin）。所以侧栏里那些「登记了但文件已删」的空条目只能
**停机改 workspace.json**：`clean-dangling.cjs`（干跑默认，`--apply` 才写，写前自动备份）——
2026-10-16 已清掉 18 条 archived 残留。

单测：`node --test test/invisible.test.js`（可见/归档/workspace-id/登记表损坏四档）。