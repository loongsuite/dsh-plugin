# 贡献指南

[English](CONTRIBUTING.md) | 简体中文

感谢参与这个插件的建设。仓库刻意保持很小：一个 Cordis 插件、一个 patch 文件、一份 manifest。难点
基本不在代码量，而在下面这些约束上，实现前请先读一遍。

## 硬性要求

**1. `package.json` 必须声明 `dsh.bundle`。**

```jsonc
{
  "name": "dsh-plugin-loongsuite",
  "type": "module",
  "main": "index.mjs",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

没有 `dsh.bundle`，包只会作为普通依赖安装、不激活任何配置层，`dsh plugin add` 也无法启用它。只声明
`dsh.client` 是社区插件列表最常见的被拒原因——那是给带前端 UI 的包用的，单独存在无法安装。

**2. `repository.url` 必须指向本仓库。**

```jsonc
"repository": { "type": "git", "url": "git+https://github.com/loongsuite/pilot-dsh.git" }
```

社区列表会拿这里声明的包名去 npm 查，只有当已发布包的 `repository` 字段指回本 GitHub 仓库时才认。
对不上会让用户静默降级为下载整个仓库的 GitHub tarball 安装。

**3. patch row 的 id 必须是 `loongsuite-pilot-observability`。**

```yaml
- insert:
    - id: loongsuite-pilot-observability
      name: dsh-plugin-loongsuite
```

这个 id 与采集器共享：`alibaba/loongsuite-pilot` 的 `agents.d/dsh.json` 里 `dshYamlPatch.entryId`
就是同一个值。这里改掉，就意味着采集器注入的那份和市场安装的那份不再认得对方是同一行。

**4. 零运行时依赖、无构建步骤、无安装脚本。**

pnpm 10 起默认阻止安装期构建脚本，插件市场会把它变成一次需要用户逐包授权的确认。需要 `postinstall`、
原生模块或编译步骤的插件，会把一键安装变成弹窗，也过不了社区列表的自动安装测试。这个采集点只需要
`node:fs`、`node:path`、`node:os`。

**5. 落盘格式要与采集器保持兼容。**

采集器读取 `$LOONGSUITE_PILOT_DATA_DIR/logs/dsh/` 下的 `dsh-*.jsonl`，期望的是
[`assets/plugins/dsh/plugin.mjs`](https://github.com/alibaba/loongsuite-pilot/blob/main/assets/plugins/dsh/plugin.mjs)
产出的 `sid` / `seq` / `time` / `type` / `data` 结构。要改字段名或结构，得先在采集器侧改
`src/inputs/dsh-log/` 和 `src/inputs/dsh/dsh-event-transform.ts` 并先合并。

**6. 沿用已验证的插件导出形式。**

采集器那份采集点用的是 `export default function apply(ctx) { … }`，这个形式已经在真实 `dsh` 运行下
验证过。请沿用它，不要未经测试就换成对象插件形式（`export const name` + `export function apply`）。

## 移植时需要补的两处

**重复加载守卫。** 同一个采集点可能通过两条独立路径被加载两次：采集器往机器级的
`~/.dsh/cordis.patch.yml` 写一个带 marker 的块、其 row 指向本地 `file://` 路径；而市场安装会在
profile 层加一行指向 npm 包名。这是两个不同的模块 specifier，模块内的标志位抓不到——要用进程级标记
（例如 `globalThis[Symbol.for('...')]`），第二次加载时打一条 warning 并空转返回。少了这个，两个实例
会往同一个会话文件里追加：`(sid, seq)` 出现重复行，下游 token 统计翻倍。

**采集器缺失时的提示。** 从插件市场装进来的人通常还没有采集器。插件会老老实实记录没人消费的事件，
用户的体感就是"装了没反应"。请探测采集器（数据目录或命令），缺失时打**一条**日志（只打一次，不要每
会话都打），说明输出目录和采集器的安装命令。

## 本地验证

```sh
dsh plugin --profile web add /path/to/pilot-dsh   # 或已发布的包名
dsh web
```

然后确认：

- 插件有加载日志，日志目录存在且权限为 `0700`
- 会话过程中 `~/.loongsuite-pilot/logs/dsh/dsh-<sid>.jsonl` 在增长，文件权限为 `0600`
- 同时装了采集器时，没有重复的 `(sid, seq)` 行
- 键名匹配 `TOKEN` / `SECRET` / `PASSWORD` / `CREDENTIAL` / `COOKIE` / `API_KEY` 的字段从不出现
- `dsh plugin --profile web remove …` 之后没有残留

长会话值得单独测一次：采集点会记录每一条事件（包含全部 assistant chunk），要看清 JSONL 的增长速度，
并确认你对外给出的数字。

## 提交收录（首个 npm 版本发布之后）

进入 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 列表是插件能在
harness 内置市场里被安装的前提。做法是提一个 PR，在 `README.md` 与 `README.zh.md` **两个文件**的
`Development & Runtime` / `开发与运行时` 分类下各加一行：

```markdown
- [loongsuite/pilot-dsh](https://github.com/loongsuite/pilot-dsh) — 一句话描述，以句号结尾。
```

URL 是关联两个语言文件的键，必须逐字符一致，否则对方的构建会失败。描述只说功能——该列表拒绝营销词。
仓库还需要 `dsh-plugin` topic，建议在 `package.json` 存在之后再加：生态里的自动扫描器会把"有该
topic 但没有插件 manifest"的仓库判为非插件。

## 问题反馈

关于本插件的问题请在本仓库提 issue。采集器的事件模型、导出器、大盘相关问题请提到
[alibaba/loongsuite-pilot](https://github.com/alibaba/loongsuite-pilot/issues)；harness 本身的问题
请去它的 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions)——那个项目
关闭了 issues，也不接受外部 pull request。
