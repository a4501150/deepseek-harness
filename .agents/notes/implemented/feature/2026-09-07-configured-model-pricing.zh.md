# Agent Note：按模型配置的定价经解析后的模型元数据上报

Status: implemented

[English](2026-09-07-configured-model-pricing.md) | 中文

## Problem

harness 此前没有任何美元定价：`llm-pi-ai` 把 pi-ai 目录自带的成本元数据清零，没有适配器声明费率，也没有消费方能够上报开销。同时运行多个提供方（官方、网关、自托管）的部署只能统计 token，无法知道一次会话花了多少钱；从 free-code harness 的 `modelSettings.json` 移植提供方/模型配置时，定价必须是逐模型的配置事实，而不是 harness 明确不信任的目录查询。

## Decision

定价是按精确模型路由由部署声明的事实，与所有其他已配置模型事实走同一条路径：

- 词汇是 `LlmModelPricing`（`packages/llm/llm/src/types.ts`）：按百万 token 计的美元费率 `input`、`output`、`cacheRead`、`cacheWrite`，各自可选。`LlmResolvedModelInfo.pricing` 承载它；`LlmRuntime.normalizeModelInfo` 校验（有限、非负）并脱离原对象复制，违例以 `INVALID_MODEL_PRICING` 拒绝——与其他适配器返回的元数据同一条最早报错点规则。
- `llm-pi-ai` 的模型条目与 `modelOverrides` 值接受 `pricing`；`llm-deepseek` 的目录条目同样接受。解析沿用 `configuredMaxTokens` 先例：只有 profile 写出的块进入 `configuredPricing`；空块不声明任何费率（schema 会把缺失键物化为 `{}`，缺失与为空是同一状态），已安装 pi-ai 目录的成本元数据继续不被读取——没人选择的费率不是部署事实。
- `estimateUsageCost`（`packages/llm/llm/src/pricing.ts`，同时以 `./pricing` 子路径导出）为单个 `TokenUsage` 样本计价：互斥桶按各自费率，缺失桶按零（自托管路由的真实零），推理 token 不单独计价，全空表返回 `undefined`——报 `0` 会声称一个部署从未声明的事实。
- `session-controller` 的 `buildModelCatalog` 把定价带入 `ModelCatalogModel`，浏览器模型目录因此把费率带给任何消费方（选择器、用量面板、Models 页的 profile 编辑器），无需第二次查询。

## Alternatives considered

- **复用 pi-ai 的 `Model.cost`。** 已拒绝：pi-ai 要求四个字段齐全，把"免费"与"未知"混为一谈，而 harness 已有立场（`replay.ts` 清零成本）把目录成本当作不可信；profile 声明的映射让显式配置规则在 `RouteCatalog` 中与 `configuredMaxTokens` 并列可见。
- **profile 无定价时继承目录成本。** 已拒绝：目录费率描述的是厂商公开定价，不是部署经代理或企业协议实际支付的价格，静默继承会让没人声明的开销看起来权威。
- **在 token meter 中计算逐轮开销。** 已推迟：持久 usage 事件不带费率，meter 折叠是纯同步的，且轮次用量目前在客户端折叠（`ui-chat` `deriveTurnTokenUsage`）；聊天开销行现在即可在渲染时用目录定价为 `usage.routes` 计价，无需改动折叠。

## Consequences

- 聊天 Turn 用量面板的开销显示是目录定价与已记录用量的纯消费方；折叠逻辑保持无定价。
- 未定价模型的路由上报"无成本"而非猜测成本；把 DeepSeek 公开定价写成事实的方式是给它加入 `DEFAULT_MODELS`。
- 定价变更会追溯重估历史：费率取自显示时的当前配置，而不是每次调用落盘的费率快照。
