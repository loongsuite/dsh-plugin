# DeepSeek Harness 的 LoongSuite 可观测插件

[English](README.md) | 简体中文

`@loongsuite/dsh-plugin` 是面向
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的独立开源可观测
插件。它观测 DSH 原生的会话、Agent 循环、LLM 流和工具生命周期，将其转换为 OpenTelemetry
GenAI Trace 与 Metric，并通过标准 OTLP/HTTP Protobuf 上报到任意兼容后端。

LoongSuite 是基于 OpenTelemetry 的开源可观测采集体系。本仓库是它面向 DSH 的原生集成。插件**不依赖也不
要求安装 LoongSuite Pilot**，不需要 sidecar、本地 JSONL 采集点，也不绑定任何厂商的后端。

> 当前状态：稳定的 `0.1.x` 版本。可从 npm 或 DSH 插件市场安装 `@loongsuite/dsh-plugin`。

<p align="center">
  <img src="docs/assets/langfuse-trace.png" alt="DSH 的一轮对话作为 OpenTelemetry GenAI 调用链，在自建 Langfuse 中查看" width="900">
  <br>
  <em>一轮 DSH 对话通过 OTLP 上报到自建 Langfuse：4 个 react step、每次调用的耗时与 token、
  <code>web_search</code> 失败后回退到 <code>bash</code>，以及 ENTRY span 上的 GenAI 语义属性。
  该截图显式开启了正文采集，默认是关闭的。</em>
</p>

## 数据模型

```text
DSH session/event + llm/stream
                │
                ▼
          生命周期协调器
                │
                ▼
   LoongSuite GenAI OTel 工具库
                │
                ▼
 私有 TracerProvider + MeterProvider
                │  OTLP/HTTP Protobuf
                ▼
   任意 OpenTelemetry 兼容后端
```

DSH 的每一轮对话生成一条调用链：

```text
ENTRY
└── AGENT
    └── STEP
        ├── LLM
        └── TOOL
```

每次真实 LLM 调用都会生成独立的 `LLM` span，因此重试会保留为同一个 STEP 下的多次尝试。工具调用
通过 DSH call ID 与结果关联。错误、中止、不完整的流以及插件卸载都会以错误状态关闭未结束 span，不会
留下悬挂链路。Subagent 会话生成独立 trace，并携带 DSH 父会话和委派层级属性。

开启正文采集时，`ENTRY` 和 `AGENT` 的输入消息只包含本轮 `source.kind=user` 的直接输入。Runtime
快照、Agent 指令、Skill Catalog、Goal 和 Coordinator relay 等 DSH 合成上下文仍保留在 `LLM`
span 上，但会排除之前 turn 的会话历史，确保每条 trace 只包含自身 turn 的上下文。同一 turn 的工具
循环中，后续 LLM span 仍会保留本 turn 前面产生的 Assistant 工具调用和工具结果。`ENTRY` 和
`AGENT` 的输出消息只包含最终 `stop` 回复；如果 turn 没有到达 `stop`，则回退到最后一条可用的
Assistant 消息。

插件还会上报标准的 `gen_ai.client.operation.duration` 与 `gen_ai.client.token.usage` 指标。它不
上报 OpenTelemetry Log，可与独立的 DSH 日志导出插件同时使用。

GenAI Invocation 构建与语义属性由
[`@loongsuite/otel-util-genai`](https://www.npmjs.com/package/@loongsuite/otel-util-genai) SDK 提供。

## 兼容范围

| 组件 | 支持范围 | 已完整验证版本 |
| --- | --- | --- |
| DeepSeek Harness | `>=0.1.0-rc.6 <0.2.0` | `0.1.0-rc.6` 的 headless 与 Web profile |
| Node.js | `>=22.19.0` | macOS 上的 `22.19`、`24.19` 和 `25.9` |

不支持早于 `0.1.0-rc.6` 的 DSH RC 版本。每个插件版本都以 DSH 当前最新发布版为准进行验证，
不会仅凭 bundle 能成功组合就宣称具备完整运行时兼容性。

## 安装与使用

手上还没有 OTLP 后端的话，[`examples/quickstart`](examples/quickstart/README.zh-CN.md) 会起一个本地
Jaeger 后端，三条命令看到第一条调用链。

在需要观测的每个 DSH profile 中安装插件：

```sh
dsh plugin --profile web add @loongsuite/dsh-plugin
dsh plugin --profile headless add @loongsuite/dsh-plugin
```

本地开发时，把包名换成本仓库的绝对路径：

```sh
dsh plugin --profile web add /absolute/path/to/dsh-plugin
```

设置服务名和 OTLP/HTTP Collector 地址，然后照常启动该 profile：

```sh
export OTEL_SERVICE_NAME=dsh-agent
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_EXPORTER_OTLP_HEADERS='authorization=Bearer%20your-token'

dsh --profile web
# 或：dsh --profile headless "总结这个工作区"
```

共享 endpoint 会自动补成 `/v1/traces` 与 `/v1/metrics`。未配置 endpoint 时，导出器使用
OpenTelemetry 标准默认值。

## 插件配置

大部分部署只需环境变量。也可以修改 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`（默认位于
`~/.dsh`）中的插件配置：

```yaml
- id: loongsuite-observability
  config:
    endpoint: http://localhost:4318
    serviceName: dsh-agent
    headers:
      authorization: Bearer your-token
    resourceAttributes:
      deployment.environment.name: development
    captureContent: false
    exportMetrics: true
```

显式插件配置的优先级高于环境变量。

如果不想修改 profile，可在启动 DSH 前通过 GenAI 正文采集模式开启：

```sh
export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=SPAN_ONLY
dsh --profile web
```

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 不卸载 bundle，直接停止采集。 |
| `endpoint` | 未设置 | OTLP/HTTP 公共基地址；插件自动追加 signal 路径。 |
| `traceEndpoint` / `metricEndpoint` | 未设置 | 完整的单 signal 地址；优先于 `endpoint`。 |
| `headers` | `{}` | 同时添加到两个导出器的请求头。 |
| `serviceName` | `OTEL_SERVICE_NAME` 或 `deepseek-harness` | OpenTelemetry `service.name`。 |
| `resourceAttributes` | `{}` | 额外的字符串类型 Resource 属性。 |
| `captureContent` | 环境变量配置或 `false` | 上报提示词、回复、工具定义、参数和结果正文。 |
| `contentMaxChars` | `128000` | 每个正文属性序列化后保留的最大字符数。 |
| `exportMetrics` | 环境变量配置或 `true` | 上报 LLM 耗时和 token 指标。 |
| `maxExportBatchSize` | `512` | 每批最多上报的 span 数。 |
| `maxQueueSize` | `2048` | 最多排队的 span 数，不能小于 batch size。 |
| `traceExportIntervalMs` | `5000` | Trace 批量导出间隔。 |
| `metricExportIntervalMs` | `60000` | Metric 导出间隔。 |
| `exportTimeoutMs` | `30000` | OTLP 导出超时。 |
| `debug` | `false` | 通过 DSH logger 输出额外的插件生命周期诊断。 |

支持以下 OpenTelemetry 标准环境变量：

- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 和 `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`
- `OTEL_EXPORTER_OTLP_HEADERS`
- `OTEL_EXPORTER_OTLP_TRACES_HEADERS` 和 `OTEL_EXPORTER_OTLP_METRICS_HEADERS`
- `OTEL_SERVICE_NAME`
- `OTEL_RESOURCE_ATTRIBUTES`
- `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`（未显式配置 `captureContent` 时，`SPAN_ONLY` 或 `SPAN_AND_EVENT` 开启 span 正文）
- `OTEL_METRICS_EXPORTER`（未显式配置 `exportMetrics` 时，`none` 关闭指标导出）

Header 与 Resource 值使用标准的逗号分隔、百分号编码 `key=value` 格式。

## 隐私与运行时行为

默认不采集正文：提示词、回复、工具 schema、参数和结果不会进入 span，但结构元数据和 token 用量仍会
上报。启用 `captureContent`，或将正文采集环境变量设为 `SPAN_ONLY` / `SPAN_AND_EVENT` 后，源码、凭据、
个人数据或其他敏感内容可能被发送到已配置后端；启用前应先确认后端的留存和访问控制策略。如果某个
profile 必须忽略进程环境并始终禁止正文采集，请显式配置 `captureContent: false`。

插件持有私有 OpenTelemetry Provider，不会替换 DSH 或其他库的全局 Provider；监听器和 Provider
也会随 DSH 插件生命周期释放和 flush。插件附加到已运行或 HMR 重载的 profile 时，只接管现有会话的
身份，并从下一次原生 `turn/start` 开始采集，不会重放历史事件或生成重复链路。

## 开发

需要 Node.js 22.19 或更高版本以及 pnpm。

```sh
pnpm install
pnpm run check
pnpm test
pnpm run build
pnpm pack
```

实现约束与发布检查清单见[贡献指南](CONTRIBUTING.zh-CN.md)。

## 许可证

[Apache-2.0](LICENSE)
