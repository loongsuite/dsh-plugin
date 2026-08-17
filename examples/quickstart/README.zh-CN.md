# 快速开始：在 Jaeger 里看 DSH 调用链

[English](README.md) | 简体中文

这个目录起一个本地后端，让你不用注册任何服务就能看到插件产出的数据。Jaeger v2 原生接收 OTLP，
所以只有一个服务：它监听 `localhost:4318`，UI 在 `localhost:16686`。调用链存在内存里，容器停掉就没了。

前置条件：装了 Compose 的 Docker 或 Podman、`dsh`、Node.js 22.19 或更高版本。

## 跑起来

```sh
docker compose -f examples/quickstart/docker-compose.yml up -d

dsh plugin --profile web add @loongsuite/dsh-plugin
```

Jaeger 没有指标端点，所以启动命令里用标准的 `OTEL_METRICS_EXPORTER=none` 把指标关掉，
否则指标导出会一直打 `/v1/metrics` 然后失败——失败是被隔离的、绝不影响 agent，但会有日志噪音：

```sh
OTEL_SERVICE_NAME=dsh-agent OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 OTEL_METRICS_EXPORTER=none dsh --profile web
```

让 agent 做一件需要几步的事——"总结这个仓库并列出它的依赖"就够了——然后打开
<http://localhost:16686>，选 `dsh-agent` 服务，点开最新那条 trace。

## 应该看到什么

每一轮对话一条 trace。一个两步的 turn 会产生 8 个 span：

```text
ENTRY  enter_ai_application_system              605ms
└── AGENT  invoke_agent standard                605ms
    ├── STEP  react step                        255ms
    │   ├── LLM   chat deepseek-v4-pro           81ms
    │   └── TOOL  execute_tool read_file         40ms
    └── STEP  react step                        330ms
        ├── LLM   chat deepseek-v4-pro           81ms
        └── TOOL  execute_tool bash             120ms
```

值得点进去看的：

- 某个 `LLM` span 的属性——`gen_ai.usage.input_tokens`、
  `gen_ai.usage.cache_read.input_tokens`、`gen_ai.usage.output_tokens`、
  `gen_ai.usage.reasoning_tokens`、`gen_ai.response.time_to_first_token`；
- 一个包含多个 `LLM` span 的 `STEP`——那是重试，每次尝试都单独保留；
- 一次失败的工具调用——错误状态落在 `TOOL` span 上，不用去日志里翻。

任意 `LLM` span 上都可以验两条不变量：`cache_read.input_tokens` 是**包含在** `input_tokens` 里的
（不是它的兄弟项），以及 `input_tokens + output_tokens == total_tokens`。reasoning token 单独上报，
并且已经包含在 `output_tokens` 里。

`AGENT` span 上还有整轮的聚合用量。当后端把 trace 内所有 span 的用量求和时，trace 级数字会把这份
聚合算两遍——**看 `AGENT` span，或者自己把 `LLM` span 加起来**。

### 用命令行验证

```sh
curl -s "http://localhost:16686/api/services" | jq -r '.data[]'

curl -s "http://localhost:16686/api/traces?service=dsh-agent&limit=1" | jq -r '
  .data[0].spans | sort_by(.startTime) | .[] |
  "\((.tags[]|select(.key=="gen_ai.span.kind")|.value))  \(.operationName)  \((.duration/1000)|floor)ms"'
```

## 停掉

```sh
docker compose -f examples/quickstart/docker-compose.yml down
```

## 几点说明

**正文默认不采集。** 提示词、回复、工具参数与结果不会进入 span。本地实验想在 Jaeger 里看到它们，
在最后那条命令上加 `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=SPAN_ONLY`。

**想改成发 Langfuse。** endpoint 换成 `http://localhost:3000/api/public/otel`（自建）或
`https://cloud.langfuse.com/api/public/otel`，并在插件的 `headers` 里加
`Authorization: Basic $(echo -n "pk-lf-…:sk-lf-…" | base64)` 和
`x-langfuse-ingestion-version: 4`。`OTEL_METRICS_EXPORTER=none` 要保留——Langfuse 的 OTLP 端点只收 trace。

**要加 collector 吗。** 这套环境不需要。但如果你想把链路分发到多个后端、做采样，或者真的想存指标，
就在 4318 前面放一个 OpenTelemetry Collector，让它转发到 Jaeger 的 `4317`。

**端口冲突。** 4318 或 16686 被占的话，改 `docker-compose.yml` 里端口映射的左半边，
同时把 `OTEL_EXPORTER_OTLP_ENDPOINT` 指到你改成的端口。

**没有 span？** 插件加载时会打出目标地址——在 DSH 输出里找
`[loongsuite-observability] loaded; traces=…`。这行不存在说明 bundle 没在你启动的 profile 上启用；
地址不对说明 profile 配置覆盖了环境变量。
