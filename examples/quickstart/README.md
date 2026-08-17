# Quickstart: DSH traces in Jaeger

English | [简体中文](README.zh-CN.md)

This directory brings up a local trace backend so you can see what the plugin
produces without signing up for anything. Jaeger v2 receives OTLP directly, so
that is the only service: it listens on `localhost:4318` and serves its UI on
`localhost:16686`. Traces live in memory and disappear when the container stops.

Prerequisites: Docker or Podman with Compose, `dsh`, and Node.js 22.19 or newer.

## Run it

```sh
docker compose -f examples/quickstart/docker-compose.yml up -d

dsh plugin --profile web add @loongsuite/dsh-plugin
```

Jaeger has no metrics endpoint, so the start command turns metrics off with
the standard `OTEL_METRICS_EXPORTER=none` — otherwise the metric exporter keeps
failing against `/v1/metrics`. The failures are isolated and never affect the
agent, but they are noise:

```sh
OTEL_SERVICE_NAME=dsh-agent OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 OTEL_METRICS_EXPORTER=none dsh --profile web
```

Ask the agent to do something that takes a few steps — "summarize this
repository and list its dependencies" is enough — then open
<http://localhost:16686>, pick the `dsh-agent` service and open the newest trace.

## What you should see

One trace per turn. A two-step turn produces eight spans:

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

Worth clicking into:

- an `LLM` span's attributes — `gen_ai.usage.input_tokens`,
  `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.output_tokens`,
  `gen_ai.usage.reasoning_tokens` and `gen_ai.response.time_to_first_token`;
- a `STEP` holding several `LLM` spans — that is a retry, each attempt kept
  separate;
- a failed tool call — the error status lands on the `TOOL` span rather than in a
  log somewhere.

Two invariants you can check on any `LLM` span: `cache_read.input_tokens` is
included in `input_tokens` (not a sibling of it), and
`input_tokens + output_tokens == total_tokens`. Reasoning tokens are reported
separately and are already part of `output_tokens`.

Token totals also appear on the `AGENT` span for the whole turn. When a backend
sums usage across every span in a trace, the trace-level figure counts that
aggregate twice — read the `AGENT` span, or add up the `LLM` spans.

### Verify from the terminal

```sh
curl -s "http://localhost:16686/api/services" | jq -r '.data[]'

curl -s "http://localhost:16686/api/traces?service=dsh-agent&limit=1" | jq -r '
  .data[0].spans | sort_by(.startTime) | .[] |
  "\((.tags[]|select(.key=="gen_ai.span.kind")|.value))  \(.operationName)  \((.duration/1000)|floor)ms"'
```

## Stop it

```sh
docker compose -f examples/quickstart/docker-compose.yml down
```

## Notes

**Content is not captured by default.** Prompts, responses, tool arguments and
tool results stay out of the spans. To see them in Jaeger for a local
experiment, add `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=SPAN_ONLY`
to the last command.

**Pointing at Langfuse instead.** Replace the endpoint with
`http://localhost:3000/api/public/otel` (self-hosted) or
`https://cloud.langfuse.com/api/public/otel`, and add
`Authorization: Basic $(echo -n "pk-lf-…:sk-lf-…" | base64)` plus
`x-langfuse-ingestion-version: 4` to the plugin's `headers`. Keep
`OTEL_METRICS_EXPORTER=none` — Langfuse's OTLP endpoint accepts traces only.

**Adding a collector.** Nothing here needs one, but if you want to fan traces
out to several backends, sample, or actually store metrics, put an
OpenTelemetry Collector on 4318 and point it at Jaeger's `4317` instead.

**Port conflicts.** If 4318 or 16686 are taken, change the left-hand side of the
port mappings in `docker-compose.yml` and point `OTEL_EXPORTER_OTLP_ENDPOINT` at
whatever you chose.

**No spans showing up?** The plugin logs its destination when it loads — look for
`[loongsuite-observability] loaded; traces=…` in the DSH output. If that line is
missing, the bundle was not enabled for the profile you started; if it names a
different endpoint, the profile config is overriding the environment variable.
