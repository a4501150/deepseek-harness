---
description: "面向用户与维护者的按 purpose 路由的后台模型说明：选择由哪个模型执行压缩与会话标题工作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-model-routing

[English](README.md) | 中文

## 概述

`dsh-model-routing` 承载部署对后台模型工作的路由：一个小而快工作选择，加上针对对话压缩与会话标题的逐 purpose 覆盖。后台消费方先解析 purpose，再解析 small-fast 层级，然后保留各自的回退，因此没有声明路由的部署照旧运行在会话路由上。路由住在 `model-routing` 设置分节里，叠加在组合条目之上，保存的变更在下一次后台调用即可见。本服务只回答一个问题——这个 purpose 或层级声明了什么选择——从不声称部署未曾给出的路由。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当后台模型工作应运行在部署选定的模型、而不一定是会话路由上时挂载本包。在自己的 `ctx.llm.stream()` 调用上盖 `purpose` 的消费方，在回退之前读取 `ctx.modelRouting`。

### 配置路由

组合条目可以为空；部署在设置文档里声明路由。

```yaml
- name: '@deepseek-ai/dsh-model-routing'
```

随后由用户设置分节声明选择：

```yaml
model-routing:
  smallFast: { provider: gateway, model: small-model }
  purposes:
    compaction: { provider: gateway, model: summarizer-model, reasoningEffort: low }
```

| 块 | 含义 |
|---|---|
| `smallFast` | 每个被路由 purpose 的回退层级；后台工作跑在已声明的最小模型上 |
| `purposes.compaction` | 摘要调用（`purpose: 'compaction'`）的选择 |
| `purposes.sessionTitle` | 标题生成（`purpose: 'session-title'`）的选择 |

每个块必须同时给出 `provider` 与 `model`；只写一半的块在写入处即被拒绝。`reasoningEffort` 每块可选。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-model-routing)是每个受支持字段的穷尽式真源。

### 读取路由

`selection({ purpose, tier })` 依次返回 purpose 块、层级、或 `undefined` 的脱离式 `{ provider, model, reasoningEffort? }`——服务从不发明默认值。

```text
const routed = ctx.modelRouting.selection({ purpose: 'compaction', tier: 'smallFast' })
```

消费方在 `undefined` 之后保留自己的回退：压缩回退到已配置的摘要字段、会话最近路由或 Agent 选项；标题提供方回退到会话中已记录的路由。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务如何实现上述行为；可观察契约已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本服务是一次设置层支撑的读取加一个校验点。分节 schema 把每个块接受为可选，因此缺失的路由解析为“没有事实”；`assertServiceable`——注册为该命名空间的校验器——在写入处拒绝只写了一半选择的块。`selection()` 每次调用读取活来源，因此设置写入无需重建注册层事实。配置键是线上传输 purpose 的 camelCase 镜像（`sessionTitle` 对 `'session-title'`）。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`ModelRoutingConfig` 服务、设置分节安装、`assertServiceable`、`selection` |
| — | 不发布运行时不变式伴生包；设置校验器拥有唯一的可变数据关系。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Core 子系统](../../../docs/subsystems/core.zh.md)——本服务补充的 `Agent` 句柄与路由选择。
- [compaction-basic 包](../../compaction/compaction-basic/README.zh.md)——`purpose: 'compaction'` 消费方。
- [session-title-llm 包](../../session/session-title-llm/README.zh.md)——`purpose: 'session-title'` 消费方。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-model-routing)——每个受支持配置字段及其来源声明。
- [Core 分组地图](../README.zh.md)——core 各包如何组合。

-----

<a id="model-experience"></a>
## 模型体验

间接，经由消费方的后台请求：被路由的选择决定由哪个模型书写压缩检查点与会话标题，其 `reasoningEffort` 随这些请求过线，路由不改变主对话的模型、提示词与前缀。

#### KV Cache 影响

被路由模型与会话路由属于不同缓存域：原先复用会话热提供方缓存的摘要前缀现在自热自己的缓存，因此路由以缓存复用换取一个刻意更便宜的辅助模型。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义本服务的范围。它们是当前包约束，不是任务积压。

- **两个被路由 purpose**——只有 `compaction` 与 `sessionTitle` 块；subagent 与 plan-agent 层级在消费方接管时再加入。
- **无保存面**——本服务只读；路由经设置文档或 `settings.replace` 写入，没有 `saveSelection` 式助手。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
