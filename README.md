# pilot-dsh

English | [简体中文](README.zh-CN.md)

The [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin for
[LoongSuite Pilot](https://github.com/alibaba/loongsuite-pilot) — published to npm as
`dsh-plugin-loongsuite`.

> **Status: prerelease.** The plugin is implemented and can be installed from a local checkout.
> The npm package has not been published yet.

## What it does

The plugin is a **tap**, not a collector. It subscribes to the harness's `session/created` and
`session/event` streams and appends each event to a per-session JSONL file on the local machine.
Everything downstream — normalizing events into the GenAI schema, building OpenTelemetry traces,
computing token usage and cost, exporting to files / SLS / HTTP / OTLP — happens in the
LoongSuite Pilot collector, which reads those files.

```
dsh session events ──▶ this plugin ──▶ ~/.loongsuite-pilot/logs/dsh/dsh-<sid>.jsonl
                                                   │
                                                   ▼
                                        LoongSuite Pilot collector
                                     (GenAI events, OTLP traces, dashboard)
```

Splitting it this way keeps the in-process footprint at one file-append listener with no
dependencies, and keeps the collector's lifecycle independent of any single `dsh` session.

## Install

Until the first npm release, install a local checkout:

```sh
dsh plugin --profile web add /path/to/pilot-dsh
```

After publication, the package install is:

```sh
dsh plugin --profile web add dsh-plugin-loongsuite
```

Then install the collector, which turns the recorded events into traces and a local dashboard:

```sh
curl -fsSL https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh \
  -o /tmp/loongsuite-pilot-installer.sh && bash /tmp/loongsuite-pilot-installer.sh install
```

Users who install the collector first do not need this package: Pilot deploys an equivalent tap
itself through its `dsh-yaml-patch` strategy. This package exists so that the plugin is
discoverable and installable from inside the harness — via
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) and the
[dsh-market](https://github.com/dsh-market/dsh-market) plugin market — without requiring the
collector to be present first.

## Repository layout

| Path | Purpose |
| --- | --- |
| `package.json` | Must declare `dsh.bundle` pointing at `./cordis.patch.yml`. Without it, `dsh plugin add` cannot install the package and the plugin cannot be listed in awesome-dsh-plugin. |
| `cordis.patch.yml` | The configuration layer applied when a profile enables this bundle. Its row `id` **must** be `loongsuite-pilot-observability`. |
| `index.mjs` | The plugin entry — a Cordis plugin that registers the two listeners and appends to JSONL. Zero runtime dependencies, no build step, no install scripts. |
| `test/plugin.test.mjs` | Node built-in tests for file format, permissions, redaction, duplicate loading, collector detection, and write-failure isolation. |

The event format matches
[`assets/plugins/dsh/plugin.mjs`](https://github.com/alibaba/loongsuite-pilot/blob/main/assets/plugins/dsh/plugin.mjs)
in the collector repository. A process-wide guard prevents plugin copies that use the same shared
marker from recording the same event twice. When the collector is absent, the plugin logs one
installation hint. Event-file write failures are reported and contained after the plugin has
loaded, so observability cannot interrupt a session.

## Data and privacy

- **Local only.** The plugin writes files under `$LOONGSUITE_PILOT_DATA_DIR` (default
  `~/.loongsuite-pilot/`) and opens no network connection. Nothing leaves the machine unless the
  collector is installed and explicitly configured with an export destination.
- **Permissions.** The log directory is created `0700` and each file is `0600`.
- **Redaction at capture.** Object keys matching `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`,
  `COOKIE`, or `API_KEY` are dropped before anything is written.
- **What is recorded.** Session, turn, model-step and tool events, including prompt and tool
  payloads. This is what makes traces useful, and it is also why the files are local-only and
  mode-restricted. Content-capture policy and secret masking on export are configured in the
  collector — see its [masking guide](https://github.com/alibaba/loongsuite-pilot/blob/main/docs/masking.md).
- **Not registered as a harness telemetry backend.** This plugin listens to the event bus instead of
  registering as the harness's `sessionTelemetry` backend. It therefore coexists with telemetry
  backends such as the official OTLP-logs one, but it does not appear in the harness's own sharing
  disclosure. Treat this document as the disclosure.

## Related

- [alibaba/loongsuite-pilot](https://github.com/alibaba/loongsuite-pilot) — the collector: agent
  discovery, unified GenAI event schema, JSONL / SLS / HTTP / OTLP output, local dashboard
- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — the harness
  this plugin observes
- [Contributing guide](CONTRIBUTING.md) — the constraints an implementation has to satisfy

## License

[Apache-2.0](LICENSE)
