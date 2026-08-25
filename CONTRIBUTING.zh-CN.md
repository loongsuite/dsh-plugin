# 贡献指南

[English](CONTRIBUTING.md) | 简体中文

感谢改进这个独立的 DeepSeek Harness 可观测插件。本包运行在 DSH 进程内并直接向 OTLP 后端发送
遥测数据，必须保持对外部采集器、文件采集点和厂商专用上报 API 的独立性。

## 仓库结构

| 路径 | 作用 |
| --- | --- |
| `cordis.patch.yml` | 插入插件 row 的 DSH bundle 层。 |
| `src/index.ts` | Cordis 入口、监听器注册和生命周期清理。 |
| `src/coordinator.ts` | DSH 生命周期到 GenAI span 树的协调。 |
| `src/mapping.ts` | DSH 消息、工具、结束原因、用量和正文映射。 |
| `src/telemetry.ts` | 私有 OpenTelemetry Provider 与 OTLP Exporter。 |
| `src/config.ts` | 对外配置 Schema 和默认值。 |
| `tests/` | 映射、协调器、包结构和真实 OTLP 传输测试。 |

## 实现不变量

- `package.json#dsh.bundle.patch` 必须保持指向 `./cordis.patch.yml`，patch row ID 必须保持为
  `loongsuite-observability`。
- 按 Cordis 约定导出具名的 `name`、`inject`、`Config` 与 `apply`；当前 DSH Loader 契约和包测试
  已固定这一形式。
- `llm/stream` waterfall 必须且只能调用一次 `next()`，下游异常必须原样抛出。遥测故障可以告警，
  但不能改变 DSH 的模型或工具执行行为。
- 每个 DSH 实时 turn 建立一棵 `ENTRY → AGENT → STEP → LLM/TOOL` 树。每次重试都是独立的 LLM
  子 span，不能从已持久化的 assistant chunk 反推 LLM span。
- LLM 正文输入只能包含当前 turn 内观测到的事件，后续 trace 不得重复之前 turn 的会话历史；跨 step
  保留当前 turn 的工具上下文，ENTRY 和 AGENT 只暴露最终 stop 回复（没有 stop 时回退到最后一条输出）。
- OpenTelemetry Provider 必须私有，不能调用全局 Provider 注册 API。
- 正文采集默认保持关闭。未配置 `captureContent` 时，只有文档约定的 `SPAN_ONLY` 与
  `SPAN_AND_EVENT` 环境变量模式可以开启 span 正文；显式配置 `captureContent: false` 时必须始终
  覆盖进程环境。
- 结构 span 使用 DSH 事件时间戳；LLM 首 token 延迟使用单调时钟。
- 接管已有会话时不能重放 `session.events`；HMR 不能制造重复 trace。
- 先关闭未完成的子 span，再关闭父 span；插件卸载时释放全部监听器和 Provider。
- 输出保持后端无关：只使用标准 OTLP/HTTP Protobuf 和标准 OTel 环境变量。

## 开发流程

使用 Node.js 22.19 或更高版本：

```sh
pnpm install
pnpm run check
pnpm test
pnpm run build
pnpm pack
```

测试必须覆盖成功和失败路径。生命周期映射发生变化时，至少应验证父子 ID、单一 trace ID、重试与错误
状态、token 记账、默认隐私关闭行为和 Provider shutdown。传输层变化必须保留本地 HTTP 测试，确保
`/v1/traces` 与 `/v1/metrics` 收到非空 Protobuf 请求。

提交发布变更前，应把打包后的 tarball 安装进一个隔离的当前版本 DSH profile，检查
`dsh --profile <name> --dump-config`，并确认插件激活时没有由本插件造成的 peer dependency 或安装脚本
必需授权错误。

## 发布与市场收录

每次 npm 发布前：

1. 将 `package.json` 与 `src/version.ts` 更新为同一版本，然后在受支持的 Node.js 版本和干净
   checkout 中运行 `pnpm run release:check`。
2. 检查 tarball：应包含构建后的 `dist/`、bundle patch、package 元数据、许可证和两份 README，不能
   包含源码测试或 `node_modules`。
3. 把这个精确的 tarball 安装进 DSH 最新受支持版本的隔离 `web` 与 `headless` profile，验证插件激活、
   正常关闭、OTLP trace 与 metric，以及默认不采集正文。
4. 以 public access 和预期的 npm dist-tag 发布 `@loongsuite/dsh-plugin`。
5. 为稳定版本创建同版本的 Git tag 和非预发布 GitHub Release。
6. 确认 DSH 社区插件列表仍能解析 npm 包和安装命令；本仓库已经完成收录并配置了 `dsh-plugin` topic。

中英文用户文档应保持行为含义一致。Harness 本身的问题请到
[DeepSeek Harness Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions)，插件缺陷请在
本仓库反馈。
