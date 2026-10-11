# dsh-adapter-compat

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
