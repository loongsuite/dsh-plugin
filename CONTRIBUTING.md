# Contributing

English | [简体中文](CONTRIBUTING.zh-CN.md)

Thank you for improving the standalone DeepSeek Harness observability plugin. This package runs in
the DSH process and sends telemetry directly to an OTLP backend. It must remain independent of
external collectors, file taps, and vendor-specific ingestion APIs.

## Repository layout

| Path | Purpose |
| --- | --- |
| `cordis.patch.yml` | DSH bundle layer that inserts the plugin row. |
| `src/index.ts` | Cordis entry point, listener registration, and lifecycle cleanup. |
| `src/coordinator.ts` | DSH lifecycle to GenAI span-tree coordination. |
| `src/mapping.ts` | DSH message, tool, finish-reason, usage, and content mapping. |
| `src/telemetry.ts` | Private OpenTelemetry providers and OTLP exporters. |
| `src/config.ts` | Public configuration schema and defaults. |
| `tests/` | Mapping, coordinator, package, and real OTLP transport tests. |

## Implementation invariants

- Keep `package.json#dsh.bundle.patch` pointing to `./cordis.patch.yml`, and keep the patch row ID
  `loongsuite-observability`.
- Export Cordis's named `name`, `inject`, `Config`, and `apply` bindings. The current DSH loader
  contract and package test pin this shape.
- The `llm/stream` waterfall must call `next()` exactly once and must rethrow downstream errors
  unchanged. Telemetry failures may warn, but must never change DSH model or tool behavior.
- Build one `ENTRY → AGENT → STEP → LLM/TOOL` tree per live DSH turn. Each retry is a separate LLM
  child; do not infer LLM spans from persisted assistant chunks.
- Keep OpenTelemetry providers private. Do not call global provider registration APIs.
- Leave content capture off by default. When `captureContent` is omitted, only the documented
  `SPAN_ONLY` and `SPAN_AND_EVENT` environment modes may enable span content. An explicit
  `captureContent: false` must always override the process environment.
- Use DSH event timestamps for structural spans and monotonic timing for LLM first-token latency.
- Do not replay `session.events` when adopting an existing session; HMR must not duplicate traces.
- Close incomplete children before parents, and dispose every listener and provider on plugin
  shutdown.
- Keep output backend-neutral: standard OTLP/HTTP protobuf only, with standard OTel environment
  variables.

## Development workflow

Use Node.js 22.19 or newer:

```sh
pnpm install
pnpm run check
pnpm test
pnpm run build
pnpm pack
```

Tests must cover both successful and failed paths. At minimum, changes to lifecycle mapping should
verify parent/child IDs, a single trace ID, retry/error status, token accounting, privacy-off
behavior, and provider shutdown. Transport changes must retain the local HTTP test that receives
non-empty protobuf requests on `/v1/traces` and `/v1/metrics`.

Before submitting a release change, install the packed tarball into an isolated current DSH
profile, inspect `dsh --profile <name> --dump-config`, and confirm the package activates without
peer-dependency errors or required install-script approvals attributable to this plugin.

## Publishing and market submission

Before every npm release:

1. Update `package.json` and `src/version.ts` to the same version, then run `pnpm run release:check`
   from a clean checkout on a supported Node.js version.
2. Inspect the tarball: it should contain built `dist/`, the bundle patch, package metadata,
   license, and both READMEs, but not source tests or `node_modules`.
3. Install that exact tarball into isolated `web` and `headless` profiles on the latest supported
   DSH version. Verify activation, clean shutdown, OTLP traces and metrics, and content-off privacy.
4. Publish `@loongsuite/dsh-plugin` with public access and the intended npm dist-tag.
5. Create the matching Git tag and non-prerelease GitHub Release for a stable version.
6. Confirm the DSH community registry still resolves the npm package and install command. The
   repository is already registered and has the `dsh-plugin` GitHub topic.

Keep English and Chinese user-facing documentation behaviorally equivalent. Harness questions
belong in the [DeepSeek Harness Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions);
plugin defects belong in this repository.
