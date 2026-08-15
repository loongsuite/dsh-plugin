# pilot-dsh

[English](README.md) | 简体中文

[LoongSuite Pilot](https://github.com/alibaba/loongsuite-pilot) 的
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）插件，npm 包名为
`dsh-plugin-loongsuite`。

> **当前状态：仅有脚手架。** 本仓库目前只包含项目元数据，插件实现尚未提交。提 PR 前请先看
> [目录规划](#目录规划) 和 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 它做什么

这个插件是一个**采集点（tap）**，不是采集器。它订阅 harness 的 `session/created` 与
`session/event` 事件流，把每条事件按会话追加写入本机的 JSONL 文件。后续的一切——归一成 GenAI
事件模型、构建 OpenTelemetry 调用链、统计 token 与成本、导出到文件 / SLS / HTTP / OTLP——都由
LoongSuite Pilot 采集器完成，它读取这些文件。

```
dsh 会话事件 ──▶ 本插件 ──▶ ~/.loongsuite-pilot/logs/dsh/dsh-<sid>.jsonl
                                        │
                                        ▼
                              LoongSuite Pilot 采集器
                        （GenAI 事件、OTLP 调用链、本地大盘）
```

这样切分的好处：进程内只留一个文件追加监听器、零依赖；采集器的生命周期也不会被绑死在某一个
`dsh` 会话上。

## 安装

> 尚未发布。下面的命令会在实现和首个 npm 版本落地后生效，此处先记录下来以固定对外接口。

```sh
dsh plugin --profile web add dsh-plugin-loongsuite
```

然后安装采集器，它负责把记录下来的事件变成调用链和本地大盘：

```sh
curl -fsSL https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh \
  -o /tmp/loongsuite-pilot-installer.sh && bash /tmp/loongsuite-pilot-installer.sh install
```

已经先装了采集器的用户不需要这个包：Pilot 会通过自己的 `dsh-yaml-patch` 部署策略注入一份等价的
采集点。本包存在的意义是让插件能在 harness 内部被发现和安装——通过
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 列表和
[dsh-market](https://github.com/dsh-market/dsh-market) 插件市场——而不必先装采集器。

## 目录规划

| 路径 | 作用 |
| --- | --- |
| `package.json` | 必须声明 `dsh.bundle` 并指向 `./cordis.patch.yml`。缺少它，`dsh plugin add` 装不上，awesome-dsh-plugin 也不会收录。 |
| `cordis.patch.yml` | profile 启用该 bundle 时应用的配置层。其中的 row `id` **必须**是 `loongsuite-pilot-observability`。 |
| `index.mjs` | 插件入口——一个 Cordis 插件，注册两个监听器并追加写 JSONL。零运行时依赖、无构建步骤、无安装脚本。 |

需要移植的行为在采集器仓库的
[`assets/plugins/dsh/plugin.mjs`](https://github.com/alibaba/loongsuite-pilot/blob/main/assets/plugins/dsh/plugin.mjs)，
那份代码已经在真实 `dsh` 运行下验证过。此外这里还需要两处补充，细节见
[CONTRIBUTING.md](CONTRIBUTING.md)：重复加载守卫，以及采集器缺失时的引导提示。

## 数据与隐私

- **只写本地。** 插件把文件写在 `$LOONGSUITE_PILOT_DATA_DIR`（默认 `~/.loongsuite-pilot/`）下，
  不发起任何网络连接。除非用户安装了采集器并显式配置了导出目标，数据不会离开本机。
- **文件权限。** 日志目录以 `0700` 创建，每个文件为 `0600`。
- **采集即脱敏。** 键名匹配 `TOKEN`、`SECRET`、`PASSWORD`、`CREDENTIAL`、`COOKIE`、`API_KEY`
  的字段在落盘前被丢弃。
- **记录了什么。** 会话、轮次、模型步骤与工具事件，其中包含 prompt 和工具参数正文。这正是调用链
  有价值的原因，也正是这些文件只留本地并限制权限的原因。内容采集策略与导出侧的密钥脱敏在采集器中
  配置，见其[脱敏文档](https://github.com/alibaba/loongsuite-pilot/blob/main/docs/masking.md)。
- **未占用 harness 的 telemetry seam。** 本插件监听事件总线，而不是注册成 harness 的
  `sessionTelemetry` 后端。因此它可以与官方 OTLP-logs 等遥测后端共存，但也不会出现在 harness
  自己的数据共享声明里。请把本文档视为该声明。

## 相关项目

- [alibaba/loongsuite-pilot](https://github.com/alibaba/loongsuite-pilot) —— 采集器：agent 发现、
  统一 GenAI 事件模型、JSONL / SLS / HTTP / OTLP 输出、本地大盘
- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) —— 本插件所观测的 harness
- [贡献指南](CONTRIBUTING.md) —— 实现必须满足的约束

## 许可证

[Apache-2.0](LICENSE)
