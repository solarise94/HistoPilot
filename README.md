# HistoPilot

面向大型病理切片（WSI）的自主导航服务。HistoPilot 负责低倍概览、高倍确认、坐标语义、快照观察、AI 标注、分支会话、上下文压缩和视觉预算；切片、Viewer 与协作数据由独立的 [PathTogether](https://github.com/solarise94/PathTogether) 平台提供。

> Early-stage research software. Not for clinical diagnosis.

## 拆分后的边界

- HistoPilot 拥有：Agent loop、tools、prompt、session/event、SSE、compaction、Prompt Cache、视觉上下文实验和 provider 接入。
- PathTogether 拥有：WSI 文件、region 生成、Viewer、标注、评论、分享、用户权限和审计。
- 两边只通过版本化 `/api/plugin/v1` 契约通信；HistoPilot 不读取平台数据库或 WSI 路径。
- `integrations/pathtogether/` 是可独立安装的 UI bundle，不需要复制 HistoPilot 源码进平台仓库。

## 本地开发

```bash
npm ci
npm run build
npm test
```

启动前需要一个可访问的 PathTogether 实例，以及由平台生成的 installation credential：

```bash
export PATHTOGETHER_URL=http://127.0.0.1:8000
export PLUGIN_INSTALLATION_ID=<installation-id>
export PLUGIN_HISTOPILOT_SECRET=<secret>
export HISTOPILOT_INTERNAL_TOKEN=<random-secret>
export HISTOPILOT_SESSIONS_DIR=$PWD/.data/sessions
npm start
```

服务默认监听 `127.0.0.1:8055`。非 loopback 监听必须设置 `HISTOPILOT_INTERNAL_TOKEN`，否则启动失败。

## 容器

```bash
podman build -t histopilot -f Containerfile .
podman run --rm \
  --network pathology \
  -e PATHTOGETHER_URL=http://pathtogether:8000 \
  -e PLUGIN_INSTALLATION_ID=<installation-id> \
  -e PLUGIN_HISTOPILOT_SECRET=<secret> \
  -e HISTOPILOT_INTERNAL_TOKEN=<random-secret> \
  -v histopilot-sessions:/data/sessions \
  -v histopilot-config:/data/config \
  histopilot
```

不要把 8055 直接暴露到公网。PathTogether 与 HistoPilot 应位于私有网络，并由 PathTogether 的认证网关向浏览器提供访问。

## PathTogether UI bundle

```bash
npm run bundle:pathtogether
```

产物为 `release/histopilot-pathtogether-plugin-<version>.tar.gz`。把它解压到 PathTogether 的 `${PLUGIN_BUNDLES_DIR}/histopilot/`。详见 [PathTogether 集成](docs/pathtogether-integration.md)。

## HistoPilot-DSH

[HistoPilot-DSH](https://github.com/solarise94/HistoPilot-DSH) 把本服务注册为 DSH 的高层病理导航工具。DSH 负责委托和对话编排；goto、snapshot、zoom 与标注策略仍由 HistoPilot 执行，避免产生两套导航 Agent。

## 服务 API

除 `/healthz` 外，所有端点在配置 token 后都要求 `X-AI-Internal-Token`：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/healthz` | 健康检查 |
| `POST` | `/run` | 新建或继续导航 run，SSE 响应 |
| `POST` | `/continue` | 继续 paused run |
| `POST` | `/ask` | 对现有会话追问 |
| `POST` | `/branch` | 从标注/会话创建分支 |
| `POST` | `/cancel` | 取消运行 |
| `GET` | `/sessions` | 列出会话 |
| `GET` | `/session/:id` | 获取 transcript |
| `GET` | `/session/:id/stream` | SSE 重连/重放 |

模型配置由受信任的调用方按 run 注入，不写入 canonical transcript。session 数据只落在 `HISTOPILOT_SESSIONS_DIR`。

## 环境变量

| 变量 | 默认值 | 用途 |
|---|---|---|
| `HISTOPILOT_HOST` | `127.0.0.1` | 监听地址 |
| `HISTOPILOT_PORT` | `8055` | 监听端口 |
| `HISTOPILOT_INTERNAL_TOKEN` | — | 服务入站鉴权 |
| `HISTOPILOT_SESSIONS_DIR` | `~/.histopilot/sessions` | session/event 数据 |
| `HISTOPILOT_CONFIG_DIR` | `~/.histopilot` | 服务配置和 credential 文件 |
| `HISTOPILOT_ALLOW_UNAUTH` | `0` | 仅开发：允许非 loopback 无令牌监听 |
| `PATHTOGETHER_URL` | `http://127.0.0.1:8000` | 平台地址 |
| `PLUGIN_INSTALLATION_ID` | — | PathTogether installation id |
| `PLUGIN_HISTOPILOT_SECRET` | — | PathTogether installation secret |
| `HISTOPILOT_ALLOW_LEGACY_ADAPTER` | `0` | 显式启用旧 `/internal/ai/*` 迁移适配器 |

旧 `AI_*` 变量仅作为一个兼容周期的别名保留。

## 实验

`experiments/` 保存视觉上下文窗口、图片预算和缓存策略的可复现实验工具。正式采数前请阅读 [实验说明](experiments/README.md)。

## License

MIT

---

HistoPilot is an agentic navigation service for whole-slide pathology images. It is independently versioned from its WSI host, PathTogether.
