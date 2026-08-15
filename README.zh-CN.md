# pilot-dsh

[English](README.md) | 简体中文

[LoongSuite Pilot](https://github.com/alibaba/loongsuite-pilot) 的
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）插件，npm 包名为
`dsh-plugin-loongsuite`。

> **当前状态：预发布。** 插件已经实现，可以从本地 checkout 安装；npm 包尚未发布。

## 它做什么

这个插件是一个**采集点（tap）**，不是采集器。它订阅 harness 的 `session/created` 与
`session/event` 事件流，把每条事件按会话追加写入本机的 JSONL 文件。后续处理包括归一成 GenAI
事件模型、构建 OpenTelemetry trace、统计 token 与成本、导出到文件 / SLS / HTTP / OTLP。这些处理
都由 LoongSuite Pilot collector 完成，collector 会读取本插件生成的文件。

```
dsh 会话事件 ──▶ 本插件 ──▶ ~/.loongsuite-pilot/logs/dsh/dsh-<sid>.jsonl
                                        │
                                        ▼
                              LoongSuite Pilot collector
                        （GenAI 事件、OTLP trace、本地 dashboard）
```

这种分工使进程内仅包含一个文件追加监听器且没有依赖，采集器的生命周期也独立于任何一个 `dsh`
会话。

## 安装

首个 npm 版本发布前，可以安装本地 checkout：

```sh
dsh plugin --profile web add /path/to/pilot-dsh
```

发布后的包安装命令为：

```sh
dsh plugin --profile web add dsh-plugin-loongsuite
```

然后安装 collector，它负责把记录下来的事件转换成 trace 和本地 dashboard：

```sh
curl -fsSL https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh \
  -o /tmp/loongsuite-pilot-installer.sh && bash /tmp/loongsuite-pilot-installer.sh install
```

已经安装 collector 的用户不需要这个包：Pilot 会通过自己的 `dsh-yaml-patch` 部署策略添加一份等价的
tap。本包使插件可以在 harness 内部通过以下项目被发现和安装：
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 列表和
[dsh-market](https://github.com/dsh-market/dsh-market) 插件市场。用户不必先安装 collector。

## 仓库目录

| 路径 | 作用 |
| --- | --- |
| `package.json` | 必须声明 `dsh.bundle` 并指向 `./cordis.patch.yml`。缺少它，`dsh plugin add` 无法安装插件，awesome-dsh-plugin 也不会收录。 |
| `cordis.patch.yml` | profile 启用该 bundle 时应用的配置层。其中的 row `id` **必须**是 `loongsuite-pilot-observability`。 |
| `index.mjs` | 插件入口。它是一个 Cordis 插件，注册两个监听器并追加写 JSONL。零运行时依赖、无构建步骤、无安装脚本。 |
| `test/plugin.test.mjs` | 使用 Node 内置测试框架校验文件格式、权限、脱敏、重复加载、采集器探测与写入失败隔离。 |

事件格式与采集器仓库中的
[`assets/plugins/dsh/plugin.mjs`](https://github.com/alibaba/loongsuite-pilot/blob/main/assets/plugins/dsh/plugin.mjs)
保持一致。进程级保护会阻止使用相同共享标记的插件副本重复记录同一事件；collector 不存在时，插件
只记录一次安装提示。插件完成加载后，事件文件写入失败只会产生 warning，不会中断会话。

## 数据与隐私

- **只写本地。** 插件把文件写在 `$LOONGSUITE_PILOT_DATA_DIR`（默认 `~/.loongsuite-pilot/`）下，
  不发起任何网络连接。除非用户安装了采集器并显式配置了导出目标，数据不会离开本机。
- **文件权限。** 日志目录以 `0700` 创建，每个文件为 `0600`。
- **写入前脱敏。** 键名匹配 `TOKEN`、`SECRET`、`PASSWORD`、`CREDENTIAL`、`COOKIE`、`API_KEY`
  的字段在写入文件前被丢弃。
- **记录了什么。** 会话、轮次、模型步骤与工具事件，其中包含 prompt 和工具参数正文。这正是 trace
  有价值的原因，也正是这些文件只留本地并限制权限的原因。内容采集策略与导出时的密钥脱敏在 collector
  中配置，见其[脱敏文档](https://github.com/alibaba/loongsuite-pilot/blob/main/docs/masking.md)。
- **未注册为 harness telemetry backend。** 本插件监听事件总线，而不是注册成 harness 的
  `sessionTelemetry` 后端。因此它可以与官方 OTLP-logs 等遥测后端共存，但也不会出现在 harness
  自己的数据共享声明里。请把本文档视为该声明。

## 相关项目

- [alibaba/loongsuite-pilot](https://github.com/alibaba/loongsuite-pilot)：collector，负责 agent 发现、
  统一 GenAI 事件模型、JSONL / SLS / HTTP / OTLP 输出和本地 dashboard
- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)：本插件所观测的 harness
- [贡献指南](CONTRIBUTING.md)：实现必须满足的要求

## 许可证

[Apache-2.0](LICENSE)
