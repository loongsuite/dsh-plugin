# Contributing

English | [简体中文](CONTRIBUTING.zh-CN.md)

Thanks for helping maintain this plugin. The repository is intentionally small: one Cordis plugin,
one patch file, one manifest. Read these interoperability and packaging requirements before
changing the implementation.

## Hard requirements

**1. `package.json` must declare `dsh.bundle`.**

```jsonc
{
  "name": "dsh-plugin-loongsuite",
  "type": "module",
  "main": "index.mjs",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

Without `dsh.bundle` the package installs as a plain dependency, activates no configuration layer,
and `dsh plugin add` cannot enable it. Declaring only `dsh.client` is the single most common reason
plugin submissions are rejected from the community registry — `dsh.client` is for packages that
ship browser UI, and on its own it is not installable.

**2. `repository.url` must point at this repository.**

```jsonc
"repository": { "type": "git", "url": "git+https://github.com/loongsuite/pilot-dsh.git" }
```

The community registry probes npm for the package name declared here and accepts it only when the
published package's `repository` field points back at this GitHub repository. A mismatch silently
downgrades users to a full-repository GitHub tarball install.

**3. The patch row id must be `loongsuite-pilot-observability`.**

```yaml
- insert:
    - id: loongsuite-pilot-observability
      name: dsh-plugin-loongsuite
```

This id is shared with the collector: `agents.d/dsh.json` in `alibaba/loongsuite-pilot` sets
`dshYamlPatch.entryId` to the same value. Changing it here means the collector-injected tap and the
market-installed tap no longer recognize each other as the same row.

**4. Zero runtime dependencies, no build step, no install scripts.**

pnpm 10 and later block install-time build scripts by default, and the plugin market surfaces that
as an explicit per-package approval the user has to grant. A plugin that needs `postinstall`, native
modules, or a compile step turns a one-click install into a prompt, and fails the community
registry's automated install test. The tap needs only `node:fs`, `node:path` and `node:os`.

**5. Keep the on-disk format compatible with the collector.**

The collector consumes `dsh-*.jsonl` from `$LOONGSUITE_PILOT_DATA_DIR/logs/dsh/` and expects the
`sid` / `seq` / `time` / `type` / `data` shape produced by
[`assets/plugins/dsh/plugin.mjs`](https://github.com/alibaba/loongsuite-pilot/blob/main/assets/plugins/dsh/plugin.mjs).
Renaming or restructuring those fields requires a matching change to `src/inputs/dsh-log/` and
`src/inputs/dsh/dsh-event-transform.ts` in the collector, landed first.

**6. Mirror the proven plugin export shape.**

The collector's tap uses `export default function apply(ctx) { … }` and that form has been validated
against a real `dsh` run. Use the same shape rather than switching to the object-plugin form
(`export const name` + `export function apply`) without testing it.

## Required integration behavior

**Keep the duplicate-load guard aligned.** The same tap can be loaded twice through two independent paths: the
collector writes a marked block into the machine-wide `~/.dsh/cordis.patch.yml` whose row points at
a local `file://` path, while a market install adds a profile-level row that points at the npm
package name. Those are two different module specifiers, so a module-scoped flag will not catch it.
Both this package and the collector-managed copy must use the same process-wide marker through
`globalThis[Symbol.for('...')]`; the second load logs a warning and registers no listeners. Without
the shared marker, both instances append to the same per-session file, producing duplicate
`(sid, seq)` lines and double-counted token usage.

**Keep the collector-absent hint.** Someone installing from the plugin market usually does not have the
collector yet. The plugin will faithfully record events that nothing consumes, which reads as "I
installed it and nothing happened". The plugin detects the collector by its data directory or
command and, when missing, logs one line per plugin load that names the output directory and the
collector install command.

## Verifying a change locally

```sh
dsh plugin --profile web add /path/to/pilot-dsh   # or the published package name
dsh web
```

Then confirm:

- the plugin logs that it loaded, and the log directory exists with mode `0700`
- `~/.loongsuite-pilot/logs/dsh/dsh-<sid>.jsonl` grows during a session, files are `0600`
- no duplicate `(sid, seq)` lines when the collector is also installed
- keys matching `TOKEN` / `SECRET` / `PASSWORD` / `CREDENTIAL` / `COOKIE` / `API_KEY` never appear
- `dsh plugin --profile web remove …` leaves no residue

A long session is worth one explicit check: the tap records every event including all assistant
chunks, so watch how fast the JSONL grows and confirm the numbers you report to users.

## Registry submission (after the first npm release)

Listing in [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) is what
makes the plugin installable from the in-harness market, and it is a pull request that adds one line
to **both** `README.md` and `README.zh.md`, under `Development & Runtime` / `开发与运行时`:

```markdown
- [loongsuite/pilot-dsh](https://github.com/loongsuite/pilot-dsh) - Description ending with a period.
```

The URL is the key that joins the two language files, so it has to match character for character or
their build fails. Descriptions state what the plugin does — the list rejects superlatives and
marketing. The repository also needs the `dsh-plugin` topic, which should be added once
`package.json` exists: the ecosystem's automated scanner treats a repository carrying that topic
without a plugin manifest as a non-plugin.

## Reporting problems

Open an issue here for anything about this plugin. Questions about the collector's event schema,
exporters, or dashboard belong in
[alibaba/loongsuite-pilot](https://github.com/alibaba/loongsuite-pilot/issues); questions about the
harness itself belong in its
[GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) — that project has
issues disabled and does not accept external pull requests.
