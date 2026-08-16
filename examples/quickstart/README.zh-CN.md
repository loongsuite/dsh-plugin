# 快速开始：三条命令在 Jaeger 里看 DSH 调用链

[English](README.md) | 简体中文

这个目录起一个本地后端，让你不用注册任何服务就能看到插件产出的数据。它跑一个
OpenTelemetry Collector（`localhost:4318`）和 Jaeger（`localhost:16686`）；调用链存在内存里，
容器停掉就没了。

前置条件：装了 Compose 的 Docker（或 Podman）、`dsh`、Node.js 22.19 或更高版本。

## 跑起来

```sh
docker compose -f examples/quickstart/docker-compose.yml up -d

dsh plugin --profile web add @loongsuite/dsh-plugin@beta

OTEL_SERVICE_NAME=dsh-agent OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 dsh --profile web
```

让 agent 做一件需要几步的事——"总结这个仓库并列出它的依赖"就够了——然后打开
<http://localhost:16686>，选 `dsh-agent` 服务，点开最新的那条 trace。

## 应该看到什么

每一轮对话一条 trace，结构是这样：

```text
ENTRY  enter_ai_application_system
└── AGENT  invoke_agent standard
    ├── STEP  react step
    │   ├── LLM   chat <模型>
    │   └── TOOL  <工具名>
    └── STEP  react step
        └── LLM   chat <模型>
```

值得点进去看的：

- 某个 `LLM` span 的属性——`gen_ai.usage.input_tokens`、
  `gen_ai.usage.cache_read.input_tokens`、`gen_ai.usage.output_tokens`、
  `gen_ai.response.time_to_first_token`；
- 一个包含多个 `LLM` span 的 `STEP`——那是重试，每次尝试都单独保留；
- 一次失败的工具调用——错误状态落在对应的 `TOOL` span 上，不用去日志里翻。

token 用量既在每个 `LLM` span 上，也在 `AGENT` span 上（整轮聚合）。当后端把 trace 内所有
span 的用量求和时，trace 级数字会把 agent 聚合算两遍——**看 `AGENT` span，或者自己把
`LLM` span 加起来**。

指标在这套环境里没有存储去处，所以由 collector 打到日志：

```sh
docker compose -f examples/quickstart/docker-compose.yml logs otel-collector | grep -A3 gen_ai.client
```

## 停掉

```sh
docker compose -f examples/quickstart/docker-compose.yml down
```

## 几点说明

**正文默认不采集。** 提示词、回复、工具参数与结果不会进入 span。本地实验想在 Jaeger 里看到它们，
在第三条命令上加 `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=SPAN_ONLY`。

**只看调用链的话，Jaeger 一个就够。** Jaeger v2 原生接收 OTLP，可以去掉 collector、把插件直接指向
Jaeger 的 4318——但要在插件配置里设 `exportMetrics: false`，因为 Jaeger 没有指标端点，
不关掉会一直有导出失败（不影响 agent，但日志噪音）。

**想改成发 Langfuse。** endpoint 换成 `http://localhost:3000/api/public/otel`（自建）或
`https://cloud.langfuse.com/api/public/otel`，在插件的 `headers` 里加
`Authorization: Basic $(echo -n "pk-lf-…:sk-lf-…" | base64)` 和
`x-langfuse-ingestion-version: 4`，并设 `exportMetrics: false`——Langfuse 的 OTLP 端点只收 trace。

**端口冲突。** 4318 或 16686 被占的话，改 `docker-compose.yml` 里端口映射的左半边，
同时把 `OTEL_EXPORTER_OTLP_ENDPOINT` 指到你改成的端口。

**没有 span？** 插件加载时会打出目标地址——在 DSH 输出里找
`[loongsuite-observability] loaded; traces=…`。这行不存在说明 bundle 没在你启动的这个 profile 上启用；
地址不对说明 profile 配置覆盖了环境变量。
