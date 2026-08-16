# Quickstart: DSH traces in Jaeger, in three commands

English | [简体中文](README.zh-CN.md)

This directory brings up a local trace backend so you can see what the plugin
produces without signing up for anything. It runs an OpenTelemetry Collector on
`localhost:4318` and Jaeger on `localhost:16686`; traces are stored in memory and
disappear when the containers stop.

Prerequisites: Docker (or Podman) with Compose, `dsh` installed, and Node.js
22.19 or newer.

## Run it

```sh
docker compose -f examples/quickstart/docker-compose.yml up -d

dsh plugin --profile web add @loongsuite/dsh-plugin@beta

OTEL_SERVICE_NAME=dsh-agent OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 dsh --profile web
```

Ask the agent to do something that takes a few steps — "summarize this
repository and list its dependencies" is enough — then open
<http://localhost:16686>, pick the `dsh-agent` service and open the newest trace.

## What you should see

One trace per turn, shaped like this:

```text
ENTRY  enter_ai_application_system
└── AGENT  invoke_agent standard
    ├── STEP  react step
    │   ├── LLM   chat <model>
    │   └── TOOL  <tool name>
    └── STEP  react step
        └── LLM   chat <model>
```

Worth clicking into:

- an `LLM` span's attributes — `gen_ai.usage.input_tokens`,
  `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.output_tokens` and
  `gen_ai.response.time_to_first_token`;
- a `STEP` that contains several `LLM` spans — that is a retry, each attempt kept
  separate;
- a failed tool call — the error status lands on the `TOOL` span rather than in a
  log somewhere.

Token totals are reported on the `AGENT` span for the whole turn as well as on
each `LLM` span. When a backend sums usage across every span in a trace, the
trace-level figure counts the agent aggregate twice — read the `AGENT` span, or
add up the `LLM` spans.

Metrics have nowhere to go in this setup, so the collector prints them:

```sh
docker compose -f examples/quickstart/docker-compose.yml logs otel-collector | grep -A3 gen_ai.client
```

## Stop it

```sh
docker compose -f examples/quickstart/docker-compose.yml down
```

## Notes

**Content is not captured by default.** Prompts, responses, tool arguments and
tool results stay out of the spans. To see them in Jaeger for a local
experiment, add `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=SPAN_ONLY`
to the third command.

**Jaeger alone is enough for traces.** Jaeger v2 accepts OTLP directly, so you
can drop the collector and point the plugin at `http://localhost:4318` on a
published Jaeger port instead — but set `exportMetrics: false` in the plugin
config, because Jaeger has no metrics endpoint and the export would keep
failing (harmlessly, but noisily).

**Pointing at Langfuse instead.** Replace the endpoint with
`http://localhost:3000/api/public/otel` (self-hosted) or
`https://cloud.langfuse.com/api/public/otel`, add
`Authorization: Basic $(echo -n "pk-lf-…:sk-lf-…" | base64)` and
`x-langfuse-ingestion-version: 4` to the plugin's `headers`, and set
`exportMetrics: false` — Langfuse's OTLP endpoint accepts traces only.

**Port conflicts.** If 4318 or 16686 are taken, change the left-hand side of the
port mappings in `docker-compose.yml`, and point `OTEL_EXPORTER_OTLP_ENDPOINT`
at whatever you chose.

**No spans showing up?** The plugin logs its destination when it loads — look for
`[loongsuite-observability] loaded; traces=…` in the DSH output. If that line is
missing the bundle was not enabled for the profile you started; if it shows a
different endpoint, the profile config is overriding the environment variable.
