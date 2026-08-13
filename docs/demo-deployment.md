# homePC Demo 部署记录（2026-08-13）

> 面向 PathTogether/HistoPilot 拆分演示的独立部署。生产版（lxbio）未动。

## 现状

| 项 | 值 |
|---|---|
| 主机 | homePC（SSH 别名 `homePC`，192.168.3.223） |
| 代码目录 | `~/svs-viewer-demo/`（rsync 自工作区，不含 .git/node_modules/.venv） |
| 镜像 | `localhost/svs-viewer-demo:latest`（podman build，Containerfile 多阶段） |
| 容器 | `svs-viewer-demo`，`--network host` + `--restart unless-stopped` |
| 端口 | Flask/gunicorn **18080**（`-e PORT=18080`，docker_entry.sh 尊重 PORT） |
| sidecar | 127.0.0.1:8055（容器内同起，healthz 200）；回调地址由 entrypoint 按 PORT 推导为 `http://127.0.0.1:18080`（AI_FLASK_URL 显式设置时优先，Containerfile 不再写死 8000） |
| 数据卷 | `~/svs-viewer-demo-data/{uploads,share}`（3 张合成切片 synth-{dense,heterogeneous,sparse}.tiff） |
| 认证 | **已启用**（`-e ADMIN_PASSWORD`，2026-08-13 晚加固；此前公网无认证暴露为 P0）。用户名 `browser_admin`，密码离线告知，不入本文档。未登录访问 /api/* 一律 401，页面 302 到 /login |

## AI 配置（demo 当前值）

- base_url: `http://127.0.0.1:8317/v1`（host 网络直通 homePC 本地 CPA）
- model: `MiniMax-M3`（快、不限流；luna 因 ikuncode 上游限流暂不作默认）
- api_protocol: openai；window_tier: balanced（400k/15%/1024·1280·768）
- context_window_tokens: 400000（显式）；图片边长/视觉预算未显式设置 → 按档位推导
- 修改入口（需登录）：`PUT http://<host>:18080/api/ai/config`

## 公网入口

- **`http://117.72.24.99:41083`** ← jdcloud frps-web（allowPorts 已加 41083）← homePC frpc-svs-demo（TCP 47001）← 容器 18080。
- frpc 配置：`~/.config/frp/frpc-svs-demo.toml`（nohup 后台跑，未做 systemd——重启 homePC 后需手动拉起，记入待办）。
- 仅 HTTP。公网 + 密码登录的场景建议后续加 HTTPS（当前为内网穿透 demo，知悉风险）。

## 重建/重启命令

```sh
rsync -az --delete --exclude .git --exclude node_modules --exclude .venv \
  --exclude __pycache__ --exclude '*.pyc' ./ homePC:~/svs-viewer-demo/
ssh homePC 'cd ~/svs-viewer-demo && podman build -t svs-viewer-demo:latest .'
ssh homePC "podman rm -f svs-viewer-demo && podman run -d --name svs-viewer-demo \
  --network host \
  -v ~/svs-viewer-demo-data/uploads:/data/uploads \
  -v ~/svs-viewer-demo-data/share:/data/share \
  --restart unless-stopped \
  -e PORT=18080 \
  -e ADMIN_PASSWORD='<强密码，必填！公网暴露不得为空>' \
  svs-viewer-demo:latest"
```

注意：**重建命令必须带 ADMIN_PASSWORD**（曾因此导致公网无认证 P0）。AI_FLASK_URL 不需要显式传，entrypoint 会按 PORT 推导。

## 已知待办

1. **frpc-svs-demo 未纳入 systemd**：homePC 重启后 frp 隧道不自动恢复（其余 frpc 实例同为 nohup，习惯一致；可后续统一改 systemd user unit）。
2. **CPA 本地监听 127.0.0.1**：host 网络是当前的解法；若改回 bridge 网络需让 CPA 监听局域网或加 proxy 进程。
3. **模型**：demo 现用 MiniMax-M3。luna 限流恢复后如需换回，登录后 `PUT /api/ai/config {"model":"gpt-5.6-luna"}`。
4. **HTTPS**：公网长期开放建议套 TLS（可在 jdcloud frps-web 前加 Caddy/nginx 终止）。

## 验证记录（2026-08-13 晚，配置链 P1 修复后）

- 未登录：/ → 302 /login；/api/slides、/api/ai/config → 401 ✓
- 登录后 GET /api/ai/config：window_tier=balanced、ctx=400000、预算/图片边长 null（推导态）✓
- 真实 AI run（公网链路，synth-sparse.tiff，MiniMax-M3）：slide_opened → snapshot 1024×1024（balanced 概览边长推导生效）→ observation → finished ✓
  —— 即 review 复现的 "visual_context_budget_tokens 需为正整数" 400 不再出现；sidecar 回调 18080 正常（AI_FLASK_URL 推导生效）✓
- sidecar /healthz：200 ✓
