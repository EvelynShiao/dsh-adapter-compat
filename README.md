# dsh-adapter-compat

DSH LLM adapter **兼容垫片**：在 adapter 注册时回填缺失的 `LlmAdapter` 基类默认方法，修复 `/compact` 与自动压缩因 `xxx is not a function` 静默失败的问题。

> 独立插件，不依赖、不修改任何被保护插件的源码。被保护插件（如 `dsh-our-free-model`）即使被强制更新换回裸类，下一次注册仍会被本插件兜住——**它的更新机制无法移除这个修复**。

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
node --test test/
```

装完后开个新会话敲 `/compact`：

- 回 `Compacted N history items (~X tokens)` → 修好了
- 还报 `imageRequestPricing is not a function` → 本插件没被加载，检查 bundles 列表

## 仓库

- GitHub（公有，供手机端下载）：https://github.com/EvelynShiao/dsh-adapter-compat
- GitCode（私有备份）：https://gitcode.com/gcw_wXIDw07q/dsh-adapter-compat

上游问题参考：zouyuxuan122/dsh-our-free-model#42（上游 1.4.4 起已自带该方法；本垫片对任何版本、任何裸类 adapter 都生效）。

## License

MIT
