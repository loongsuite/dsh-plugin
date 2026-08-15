# `@loongsuite/otel-util-genai` OpenTelemetry 2.x peer dependency compatibility

## Resolution

Resolved by `@loongsuite/otel-util-genai@0.1.1`, published with the following peer range:

```json
{
  "peerDependencies": {
    "@opentelemetry/api": "^1.9.0",
    "@opentelemetry/sdk-trace-base": "^1.30.0 || ^2.10.0"
  }
}
```

`@loongsuite/dsh-plugin` was upgraded to `^0.1.1`. A packed plugin was installed with pnpm in a
clean consumer project against `@opentelemetry/sdk-trace-base@2.10.0`; dependency resolution
selected SDK `0.1.1`, reused the consumer's OTel `2.10.0` peer, and emitted no peer dependency
warning.

## Request

Please publish a new `@loongsuite/otel-util-genai` version that officially supports the
OpenTelemetry 2.x trace SDK used by `@loongsuite/dsh-plugin`.

The DSH plugin currently uses one coherent OpenTelemetry 2.10 stack:

- `@opentelemetry/api@1.9.x`
- `@opentelemetry/sdk-trace-base@2.10.x`
- `@opentelemetry/sdk-metrics@2.10.x`
- `@opentelemetry/resources@2.10.x`
- OTLP exporters `0.221.x`

Its runtime traces and metrics work correctly, but every clean plugin installation reports:

```text
@loongsuite/otel-util-genai 0.1.0
└── unmet peer @opentelemetry/sdk-trace-base@^1.30.0
    found 2.10.0
```

This warning is caused by the SDK's current peer range:

```json
{
  "peerDependencies": {
    "@opentelemetry/api": "^1.9.0",
    "@opentelemetry/sdk-trace-base": "^1.30.0"
  }
}
```

## Relevant SDK usage

Most GenAI handler paths depend only on `@opentelemetry/api` interfaces supplied by the
consumer. The optional event-log helper `convertEventLogToReadableSpans()` additionally imports
`BasicTracerProvider`, `InMemorySpanExporter`, `SimpleSpanProcessor`, and the
`ReadableSpan` type from `@opentelemetry/sdk-trace-base`.

Because that helper exercises concrete trace SDK APIs, the peer range should only be widened after
both supported major versions pass the SDK test suite.

## Recommended change

If the SDK passes against both OTel 1.30 and OTel 2.x, update the peer dependency to:

```json
{
  "peerDependencies": {
    "@opentelemetry/api": "^1.9.0",
    "@opentelemetry/sdk-trace-base": "^1.30.0 || ^2.0.0"
  },
  "peerDependenciesMeta": {
    "@opentelemetry/sdk-trace-base": {
      "optional": true
    }
  }
}
```

Keep the peer optional: the long-lived Handler API does not require the concrete SDK package, while
`convertEventLogToReadableSpans()` already produces a targeted runtime error when it is absent.

If the event-log helper cannot support both majors with one implementation, publish an SDK version
that explicitly targets OTel 2.x instead of silently widening the range.

## Required verification

Run the following matrix before publishing:

| Scenario | OTel 1.30.x | OTel 2.10.x |
| --- | --- | --- |
| TypeScript declaration build | Must pass | Must pass |
| `ExtendedTelemetryHandler` with a consumer-owned provider | Must pass | Must pass |
| LLM/Agent/STEP/TOOL span creation and parent context | Must pass | Must pass |
| GenAI duration and token metrics | Must pass | Must pass |
| `convertEventLogToReadableSpans()` | Must pass | Must pass |
| Provider force-flush and shutdown | Must pass | Must pass |

Also test a packed SDK in a clean consumer project. Installing the DSH plugin with the new SDK
must no longer emit an unmet peer warning.

## Acceptance criteria

- A new `@loongsuite/otel-util-genai` version is published.
- OTel 1.30 compatibility is retained if the published peer range still declares it.
- OTel 2.10 trace and metric behavior is covered by CI.
- `@loongsuite/dsh-plugin` can install its OTel 2.10 stack without peer dependency warnings.
- No global TracerProvider or MeterProvider is registered by the SDK.

## Consumer follow-up

After the SDK release, `@loongsuite/dsh-plugin` should upgrade its SDK dependency, refresh the
lockfile, rerun its checks/tests/build, and repeat a clean `dsh plugin add` installation.

Do not use package-manager peer warning suppression as the final fix: it only hides the warning for
one workspace and does not establish compatibility for downstream plugin users.
