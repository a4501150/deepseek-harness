# Agent 笔记：逐模型 effort 默认值与声明式 reasoning summary 模式

Status: implemented

[English](2026-09-07-per-model-effort-default-and-reasoning-summary.md) | 中文

## 问题

被移植的提供方设置词汇表携带两条 pi-ai 路由 profile 无法表达的逐模型事实。`defaultEffort` 在源词汇表中逐模型而异（一个提供方的模型默认 `high`，另一个默认 `xhigh`），而 profile 结构只有路由级 `reasoning` 默认值——异构路由被迫为全部模型选一个默认。`reasoningSummary`（OpenAI Responses 的 `reasoning.summary` 模式）完全没有落点：pi-ai 的 `streamSimple` 不转发 summary，且其 `buildBaseOptions` 白名单会丢弃未知请求键，因此该值无法经适配器使用的选项词汇表到达线路。

## 决策

`models` 条目与 `modelOverrides` 值新增两个字段，与 `pricing`、`maxTokens` 走同一条解析路径：`defaultReasoningEffort` 记录逐模型 effort，必须命名该模型提供的等级（即 `getSupportedThinkingLevels` 去掉 `off`，`off` 的含义是"什么都不发"，不是一个等级），并在请求回退与已解析元数据的 `defaultEffort` 两处都优先于路由的 `reasoning`；`reasoningSummary` 接受 `auto`、`concise`、`detailed`，并在该模型解析出的协议从不读取 `reasoning` 参数时被拒绝——接收协议为 `openai-responses`、`azure-openai-responses` 与 `openai-codex-responses`。

适配器经 pi-ai 的 `onPayload` 钩子应用该模式，每个 Responses 实现都会带着已构建完成的请求体调用它：钩子把配置的 mode 合并进协议构建器产出的 `reasoning`，或在没有该参数时只声明 `{ summary }`，协议把这读作提供方自带的默认 effort。省略 summary 是默认：未设置字段与配置专用的 `off` 值都会剥掉 pi-ai 构建器注入的 `auto`，因此提供方不运行摘要过程；`off` 这个词永不上线——提供方会拒绝它。经 Responses 后端实测，注入的 summary 会使计费的 reasoning tokens 大致翻倍（第二个 reasoning item 自身的输出 tokens），而它是该路由唯一可见的 thinking，因此被移植词汇表的沉默被实现为省略，而不是 pi-ai 那个要付费的 `auto`。用户选择的 effort（源词汇表中的 `selectedEffort`）不需要新字段：`agent-default-model` 已经持久化完整选择（含 `reasoningEffort`），而被移植的“回退到 `defaultEffort`”恰是选择未命名等级时选择器读取的已解析元数据 `defaultEffort`。

## 考虑过的替代方案

- **逐云 summary 字段或改用完整 `stream()`。** 被否决：pi-ai 的简单词汇表路径丢弃未知键，而为单一字段把适配器逐协议切到完整 `stream()` 会分叉每条路由的选项管线；`onPayload` 是每个实现都会带着请求体调用的那个钩子。
- **经 `samplingParams` 携带该模式。** 被否决：`Object.assign` 会整体替换 `reasoning` 参数，丢弃 pi-ai 的 effort 映射与钳制——summary 会悄悄改写 effort 分发。
- **逐模型 `selectedEffort` 设置字段。** 被否决：harness 经 `agentDefaultModel.saveSelection` 持久化用户的显式选择，再起一个存储就会以不同的清除规则在两地保存同一事实。
- **把 pi-ai codex 的 `"off"`/`"on"` summary 拼写暴露为配置值。** 被否决：后端自己的拒绝信息只列 `auto`、`concise`、`detailed`，所以 `off` 以省略参数实现，而 `on` 相对 `auto` 没有增加任何事实。

## 后果

- 手声明路由上的 summary 模式由适配器而非 pi-ai 应用，因此忽略该参数的网关与接受默认值的网关呈现相同字节——该声明说的是请求，行为由提供方回答。
- 模型自带不同提供方默认值的路由现在逐模型声明；共享一个默认的路由仍用路由级 `reasoning` 字段，且每个既有 profile 的逐模型映射都为空。
- 拒绝信息点名接收协议，因此 completions 路由的作者会知道该字段为 Responses 路由而存在，而不是看着它应用到了空处。
- 未声明 summary mode 的 Responses 路由现在完全不发 `reasoning.summary`——此前 pi-ai 的构建器会在每个推理请求上放 `auto`——所以在声明 mode 之前 thinking 不可见，而每条未声明的路由都不再为摘要过程付费。
