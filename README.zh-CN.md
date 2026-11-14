# Model Dock

[English](README.md) | **简体中文**

**Your models. Connected.** 本地优先的模型网关，配套独立接入端 demo。

把自己的模型 API、Ollama 和已登录的 Codex CLI 接入同一个地址，由服务端统一管理模型供给、凭证、发布、项目授权和调用控制；接入应用管理自己的功能、分组与模型偏好。网关、管理台和 demo 无需运行时第三方依赖；核心、协议和适配器放在同一仓库中维护。

## 快速开始

需要 **Node.js 22.12+**，推荐 Node.js 24 LTS。

```sh
git clone https://github.com/idea007/model-dock.git
cd model-dock
npm ci
npm start
```

管理台默认位于 **http://127.0.0.1:4317**，API Base URL 为 **http://127.0.0.1:4317/v1**。

启动服务后会在默认浏览器中自动打开并登录管理台，无需额外操作。仅运行服务、不打开浏览器时，使用 `npm start -- --no-open`。原有的 `--open` 参数仍然兼容。网关只监听本机地址。

服务运行期间可用 `npm run console` 重新打开并登录管理台。如需在指定浏览器中打开，运行 `npm run --silent console -- --print`，把生成的一次性链接粘贴到地址栏。同一浏览器中打开相同地址会沿用登录状态，最长有效期为 7 天；重启网关会自动打开管理台并重新登录（使用 `--no-open` 时除外）。

1. 在「连接与凭证」添加模型来源，点击「发现模型」。
2. 在「模型与服务」启用要发布的模型。模型声明了思考深度时，可选择开放等级，并点击图钉设为默认。点击「保存更改」生效。新发现的模型默认不发布。
3. 在「项目访问」创建项目密钥，选择允许访问的模型。
4. 在「调用测试」验证真实请求，再把网关地址、项目密钥和带来源前缀的模型 ID 填入应用。

## 体验独立接入端 demo

```sh
# 使用服务端创建的项目密钥连接 Model Dock
npm run demo -- --open
```

接入端默认运行于 **http://127.0.0.1:4318**，可以直接打开，无需填写本地会话令牌。左侧「接入设置」页面提供服务端 API 地址和项目密钥输入框；粘贴在服务端「项目访问」创建的 `md_key_…` 密钥后读取授权模型。未连接时模型目录为空，不提供模拟数据。接入端有独立进程和数据目录，包含对话/提取功能、内容处理与开发助手分组，支持单模型、多候选、独立默认模型、思考深度继承和流式体验。

「功能与模型」已迁入这里。按凭证 / 按功能查看、搜索、展开分组、调整列宽、保存/撤销及草稿恢复都只影响此应用。后端使用项目密钥获取授权目录并发起真实推理，不调用管理接口。左侧独立的「接入设置」页面可更换地址与密钥。「刷新模型」会同步服务端的模型开关、能力和思考深度；重新打开页面也会更新目录。详见 [接入端启动说明](docs/client-demo.zh-CN.md) 与 [功能设置说明](docs/model-settings.zh-CN.md)。

| 服务端管理台 · 4317 | 接入端 demo · 4318 |
| --- | --- |
| 模型来源和上游凭证 | 项目连接与授权目录 |
| 模型发布与项目访问范围 | 应用模型选择、功能分组与默认值 |
| 并发、超时、撤权及请求记录 | 提示模板、功能思考偏好与用户交互 |

已有服务端别名及其项目调用继续兼容；新业务功能由接入端维护，网关不再创建全局业务别名。

## 接入自己的项目

```sh
export MODEL_DOCK_API_KEY='从管理台创建的项目密钥'
export MODEL_DOCK_MODEL='connection-id/model-id'
node examples/chat.mjs
```

不依赖特定 SDK；任何能使用本项目兼容范围内 Chat Completions 协议的客户端都可以接入。

```js
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:4317/v1',
  apiKey: process.env.MODEL_DOCK_API_KEY,
});
const result = await client.chat.completions.create({
  model: 'connection-id/model-id',
  messages: [{ role: 'user', content: '你好' }],
});
console.log(result.choices[0].message.content);
```

[原生 JavaScript 示例](examples/chat.mjs)、[Python SDK 示例](examples/chat.py)、[应用工具调用示例](examples/tools.mjs)。示例密钥应放在应用服务端环境变量中，不放在公开网页脚本中。

## 三种模型来源

| 来源 | 连接方式 | 管理能力 |
| --- | --- | --- |
| 自有 API | OpenAI-compatible Base URL + API Key | 多连接、发现或手动添加模型、发布、项目授权 |
| Ollama | 本机原生 HTTP API | 已安装模型发现、能力与上下文元数据、文本推理、流式、JSON、模型支持的工具调用 |
| Codex（实验性） | 本机已安装并登录的 CLI / App Server | 模型目录、文本推理与工具调用、单张文生图 |

Ollama 需另行安装、启动并下载模型，例如 `ollama pull <model>`。本项目不会在启动或检查状态时自动下载权重。上下文元数据用于展示，推理不会擅自把 `num_ctx` 调到模型最大值。

Codex 使用原生 JSON-RPC，按请求创建临时线程；Shell、浏览器、插件、宿主 MCP 等能力被隔离。应用工具调用会返回调用方执行，网关不会替应用执行工具。它是真实模型桥接，使用 Codex 配置的账号/上游及对应额度；`model/list` 只是目录，不能证明当前账号有某个模型的推理权限。

在 Codex 连接点击「发现模型」，然后在「模型与服务 → 图片生成」发布 `codex-imagegen`。在「调用测试」可以添加最多 5 张参考图、选择期望画幅、请求透明背景，或将生成结果用于「继续编辑」。也可以为项目密钥授权后，通过 `POST /v1/images/generations` 调用。生成使用本机 Codex 账号的额度。[请求与返回格式](docs/api.md#inference)

Codex 会继承启动网关时的 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`。未显式设置代理时，macOS 会读取系统已启用的本机 HTTP/HTTPS 代理，仅传给 Codex 子进程，不修改系统配置。PAC 和非本机代理不会自动导入；其他平台或特殊网络请显式设置环境变量。模型列表正常但推理长时间重连时，先检查 CLI 的代理连接。

Codex 内置认证的适用范围与托管服务不同。商业/托管场景需要另行评估正式 API 或 Sign in with ChatGPT 接入。本版本没有实现后者，也不提供共享账号转售或公网代理部署。[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server#auth-endpoints) · [Sign in with ChatGPT](https://developers.openai.com/siwc)

## 兼容范围

- `GET /v1/models`
- `POST /v1/chat/completions`：文本消息、非流式 JSON、SSE、工具调用与结果回传。
- `POST /v1/images/generations` 支持 Codex 文生图和参考图编辑，每次返回一张 Base64 图片及实际宽高。
- 上游实际报告的 Token 用量；缺失用量保留未知，不伪造为零。
- 客户端断开/取消、请求超时、并发上限、项目密钥撤销。
- 管理 API：连接、目录、模型发布、项目密钥、在途请求取消。

**这是明确子集的兼容实现。** 不支持的参数显式报错。Codex 无法保证 `temperature`、`max_tokens` 等语义，所以不会默默接收后忽略。完整参数矩阵见 [兼容性说明](docs/compatibility.md)，管理接口见 [API 文档](docs/api.md)。

后续规划包括语音、视频、远程设备配对以及 Ollama 模型管理。[路线图](docs/roadmap.md)

## 数据与配置

默认数据位于当前用户的 `~/.model-dock`，可以用 `MODEL_DOCK_HOME` 指定专用目录。每个目录只允许一个网关进程写入。

- `state.json`：连接、模型、兼容的旧别名、哈希后的项目密钥，以及 AES-256-GCM 加密的上游密钥。
- `master.key`：解密密钥；`admin.token`：本机管理令牌。
- 文件权限在 POSIX 上为 `0600`，目录为 `0700`。Windows 需使用当前用户专有目录并配置相应 ACL。
- 原子写入和修订号防止并发覆盖。读取不会重置损坏配置。
- 默认只在内存保留最近 100 条调用元数据，不保存提示词和回答；重启清空。

备份应整体备份数据目录。加密密钥与数据保存在同一台机器上，不能抵御已经取得当前系统账号权限的攻击者。不要把此目录放入 Git、同步给不受信任的账号或公开共享。

```sh
# macOS / Linux
MODEL_DOCK_PORT=4320 MODEL_DOCK_HOME=/path/to/private/data npm start
```

PowerShell 可使用 `$env:MODEL_DOCK_PORT='4320'` 设置变量。`.env.example` 仅说明配置项；应用不会隐式读取 `.env`。

## 开发与打包

```sh
npm ci
npm run verify       # 语法、协议边界、HTTP 集成、官方 SDK 与 DOM 交互测试
npm run pack:check   # 打包、在隔离目录安装、运行安装后的 CLI 与静态页面
npm pack
```

安装本地构建的发行包：

```sh
npm install --global ./lab-model-dock-0.1.0.tgz
model-dock serve
model-dock-demo --open
```

源码仓库：[idea007/model-dock](https://github.com/idea007/model-dock)。npm 包名为 `lab-model-dock`，尚未发布到 npm；上述安装命令使用本地生成的 tarball。构建不需要博客仓库、数据库或其环境文件。

自动测试使用本机 HTTP/JSON-RPC fixtures，不读取真实 Codex 账号，也不调用付费模型。CI 配置覆盖 macOS、Linux、Windows 上的 Node 22/24；实际执行结果以 CI 为准。

首次交付的实际测试结果、真实 Ollama/Codex 调用和未验证边界见 [验证记录](docs/verification.md)。

```text
apps/gateway/       CLI、HTTP 和静态资源入口
apps/console/       无构建步骤的服务端管理台
apps/demo/          独立接入应用、偏好存储和真实网关交互
packages/core/      配置持久化、授权、目录、路由、调用治理
packages/protocol/  校验、错误与流式协议
packages/providers/ OpenAI-compatible、Ollama、Codex
examples/           可独立接入的客户端示例
tests/              离线协议与集成测试
```

详见 [架构与迁移边界](docs/architecture.md)、[贡献说明](CONTRIBUTING.md) 和 [安全说明](SECURITY.md)。

## License

MIT。来源与提取范围见 [NOTICE](NOTICE)。本项目不分发 Codex、Ollama 或任何模型权重，它们各自的许可和服务条件独立适用。
