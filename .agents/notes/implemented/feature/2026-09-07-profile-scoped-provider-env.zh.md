# Agent Note：按 profile 配置的 provider env 让任意 pi-ai 路由自选云端凭据

Status: implemented

[English](2026-09-07-profile-scoped-provider-env.md) | 中文

## Problem

所有 pi-ai 路由都从同一个进程环境读取提供方侧的发现事实——AWS region 与 profile、Vertex project 与 location、代理变量——于是同时运行某个 region 的 Bedrock、某个网关与某条 Vertex 路由的部署无处声明这些逐路由事实：导出 `AWS_REGION` 会把所有路由一起钉在同一个值上。harness 的立场是部署自有的配置住在 profile 里，而移植的提供方设置词汇把 region/profile/project 选择当作配置事实，不是进程环境状态。

## Decision

profile 的 `env` 块（配置词汇：`PiAiProviderProfile.env`）是提供方级环境覆盖，随本路由每个请求转发。词汇沿用 pi-ai 自己的：`ProviderRequestOptions.env` 是 `Record<string, string>`，pi-ai 的提供方发现以它替代 `process.env`——Bedrock region 与 profile、Vertex project 与 location 及代理变量都在 `streamSimple` 路径上经它解析。harness 不新增任何逐云字段：

- 解析像 `headers` 一样脱离原对象复制，转发跳过缺失或为空的块，没人写过的覆盖对请求毫无贡献。
- 覆盖按路由生效，于是两个 Bedrock region 或网关旁的一个 Vertex project 在同一份 profile 集里共存，无需动进程环境。
- 命名的 `apiKeyEnv` 仍决定密钥：覆盖喂给 pi-ai 自己的发现（它的 `AWS_PROFILE`、`GOOGLE_CLOUD_PROJECT` 与代理查询），不喂 harness 凭据 seam。

## Alternatives considered

- **逐云结构化字段（`aws.region`、`gcp.project`……）。** 已拒绝：provider-agnostic 目标说一条路由的云端选择是一张 map，不是每个云一次 schema 追加；pi-ai 的 option 管道本就按 env 键控，结构化层只会用 harness 词汇重拼它的名字再漂移。
- **组合层的进程级环境扩展。** 已拒绝：它表达不了逐路由选择，而那正是被声明的事实。
- **把流式路径切到 pi-ai 带逐 API option 的完整 `stream()`。** 本增量已拒绝：simple 路径是 harness 统一的 reasoning 词汇，而 `env` 经它到达同一套发现；逐 API option 字段留给真需要的路由。

## Consequences

- profile 的 `env` map 可能携带含密钥的值（pi-ai 能发现的 API key 拼写）；与 `headers` 一样它是纯字符串，`apiKeyEnv` 的凭据引用立场不变。
- 登录流程与凭据存储查询仍读环境本身；覆盖只覆盖请求时的发现。
- 手工声明的路由实际不受影响：它们的协议不查询云端发现，pi-ai 会忽略它们从不读取的覆盖键。
