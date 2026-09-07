# Agent Note：按 purpose 的模型路由把后台工作移离会话路由

Status: implemented

[English](2026-09-07-purpose-model-routing.md) | 中文

## Problem

压缩与会话标题调用运行在会话所用的任意路由上：摘要器依次回退到已配置字段、最近一次已路由请求或 Agent 选项，标题提供方回退到会话中已记录的路由。于是主模型是大而慢或昂贵路由的部署，每次检查点摘要与标题都在支付那条路由的价格——而移植的提供方设置词汇把这些事实保留为独立的 purpose 槽位（`defaultSmallFastModel`、逐 purpose 路由），不是会话状态的偶然产物。

## Decision

`dsh-model-routing`（设置命名空间 `model-routing`）把一个小型服务 `ctx.modelRouting.selection({ purpose?, tier? })` 作为部署后台路由的所有者：先解析 purpose 块，再解析 `smallFast` 层级，最后 `undefined`——消费方在未声明路由之后保留自己的回退链，因此挂载插件本身不改变任何行为，直到某个分节声明了事实。解析点：压缩按 `已配置字段 → 路由 → 最近请求路由 → Agent 选项` 解析并转发被路由选择的 `reasoningEffort`；标题提供方按 `显式成对配置 → 路由 → 已记录路由` 解析并以同样方式转发 effort。被路由的 `reasoningEffort` 随请求过线；持久的标题出处只保留 provider 与 model。

设置形状是 `smallFast` 加 `purposes.compaction` / `purposes.sessionTitle`，每块 `{ provider, model, reasoningEffort? }`。键是线上传输 purpose 的 camelCase 镜像（`'session-title'`），因为配置目录遍历器按字面比较 schema 路径与属性名。只写了一半配对的块在写入处被命名空间校验器拒绝，因此解析可以信任完整配对。

## Alternatives considered

- **把设置放进各自拥有的消费方包。** 已拒绝：部署声明的是一条路由事实，而压缩与标题会各自长出平行的路由 schema 与校验器；共享词汇正是目的。
- **一次移植完整 purpose 层级集（`defaultSubagentModel`、`balanced`、`mostPowerful`、`planAgentConfig`）。** 已延期：还没有消费方解析这些槽位，无主的配置能力就是猜测；`selection()` 已接受 `tier` 参数，后来的层级只需一个 schema 键即可加入。
- **把分节托管进 `agent-default-model`。** 已拒绝：那个服务拥有的是 agent 创建时读取的一次全局默认；后台路由是问题不同、消费方不同的另一件事，合并会把两条因无关原因变化的读取路径耦合在一起。

## Consequences

- 被路由的后台模型与会话路由属于不同缓存域：摘要前缀不再复用会话的热提供方缓存而是自热自己的缓存——这是部署选择路由时主动接受的交换。
- 新的后台 purpose 通过扩展 `ModelRoutingPurpose`、加一个 schema 键、并接入消费方的解析点来加入；服务 API 不变。
- 设置文档可以在消费方出现之前路由某个 purpose；没人消费的块声明了一条未使用的事实，不使任何调用点丢失信息。
