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
| 认证 | **已启用且 fail-closed**（`-e REQUIRE_ADMIN_AUTH=1` + `--env-file` 注入 `ADMIN_PASSWORD`）。用户名 `browser_admin`，密码离线告知，不入本文档、不写进命令历史。未登录访问 /api/* 一律 401，页面 302 到 /login |

## AI 配置（demo 当前值）

- base_url: `http://127.0.0.1:8317/v1`（host 网络直通 homePC 本地 CPA）
- model: `MiniMax-M3`（快、不限流；luna 因 ikuncode 上游限流暂不作默认）
- api_protocol: openai；window_tier: balanced（400k/15%/1024·1280·768）
- context_window_tokens: 400000（显式）；图片边长/视觉预算未显式设置 → 按档位推导
- 修改入口（需登录）：`PUT http://127.0.0.1:18080/api/ai/config`（经 SSH 隧道；不要走公网 HTTP）

## 公网入口（当前不可用于带密码测试）

- **`http://117.72.24.99:41083` 是明文 HTTP**：登录密码和 session cookie 无传输层保护。匿名 401 已生效，但强密码不能防止链路窃听或中间人攻击。
- 链路：jdcloud frps-web（allowPorts 已加 41083）← homePC frpc-svs-demo（TCP 47001）← 容器 18080。
- frpc 配置：`~/.config/frp/frpc-svs-demo.toml`（nohup 后台跑，未做 systemd——重启 homePC 后需手动拉起）。
- **公网测试 GO 条件**：先套 HTTPS，或改走 SSH/VPN/Tailscale 等可信隧道。在此之前不要用 41083 登录。

### 明天测试：SSH 隧道（推荐）

管理端 gunicorn 与 sidecar 的 `/internal/ai/*` 回调同端口 HTTP，不宜在 gunicorn 上直接终止 TLS（sidecar 会连不上）。公网测试前走本机隧道：

```sh
# 本机另开终端，保持隧道
ssh -N -L 18080:127.0.0.1:18080 homePC

# 浏览器只访问隧道，不要打开 41083
open http://127.0.0.1:18080/login
```

测试期间可停掉 frpc-svs-demo，避免公网入口仍可被连上：

```sh
ssh homePC 'pkill -f frpc-svs-demo || true'
```

### 长期 HTTPS

在 jdcloud frps-web 前加 Caddy/nginx 终止 TLS（域名 + 证书），对内仍转发到 homePC:18080 的 HTTP。不要把证书挂到 gunicorn 同一端口，以免打断 sidecar 回调。外部 HTTPS 部署时在 admin.env 设 `ADMIN_SESSION_COOKIE_SECURE=1`（SSH 隧道 HTTP 不要设，否则 cookie 发不出去）。

## 重建/重启命令

密码通过受限 env 文件注入（`chmod 600`），不要写在命令行或本文档里。

在 homePC 上准备（一次性）：

```sh
umask 077
cat > ~/svs-viewer-demo-data/admin.env <<'EOF'
REQUIRE_ADMIN_AUTH=1
ADMIN_PASSWORD=<REPLACE_WITH_STRONG_PASSWORD>
# SSH 隧道 HTTP：不要设 ADMIN_SESSION_COOKIE_SECURE
# Caddy/nginx 终止 TLS 后取消下一行注释
# ADMIN_SESSION_COOKIE_SECURE=1
EOF
chmod 600 ~/svs-viewer-demo-data/admin.env
```

`<REPLACE_WITH_STRONG_PASSWORD>` 是占位 sentinel，原样复制会令 entrypoint / Flask 拒绝启动。必须换成真实强密码后再 `podman run`。

重建：

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
  --env-file ~/svs-viewer-demo-data/admin.env \
  svs-viewer-demo:latest"
```

注意：

- **必须**带 `REQUIRE_ADMIN_AUTH=1` 和真实 `ADMIN_PASSWORD`。缺密码、仍是 `<...>`、或仍是文档 sentinel `<REPLACE_WITH_STRONG_PASSWORD>` 时 entrypoint / Flask 会直接退出，避免再次公网免认证。
- 不要把密码写进 `podman run -e`：会进 shell history。
- AI_FLASK_URL 不需要显式传，entrypoint 会按 PORT 推导。

## 已知待办

1. **frpc-svs-demo 未纳入 systemd**：homePC 重启后 frp 隧道不自动恢复（其余 frpc 实例同为 nohup，习惯一致；可后续统一改 systemd user unit）。
2. **CPA 本地监听 127.0.0.1**：host 网络是当前的解法；若改回 bridge 网络需让 CPA 监听局域网或加 proxy 进程。
3. **模型**：demo 现用 MiniMax-M3。luna 限流恢复后如需换回，登录后 `PUT /api/ai/config {"model":"gpt-5.6-luna"}`。
4. **HTTPS**：公网长期开放必须在 frps 前终止 TLS；当前公网 41083 仅 HTTP，带密码测试请走 SSH 隧道。

## 验证记录（2026-08-13 晚，配置链 P1 修复后）

- 未登录：/ → 302 /login；/api/slides、/api/ai/config → 401 ✓
- 登录后 GET /api/ai/config：window_tier=balanced、ctx=400000、预算/图片边长 null（推导态）✓
- 真实 AI run（公网链路，synth-sparse.tiff，MiniMax-M3）：slide_opened → snapshot 1024×1024（balanced 概览边长推导生效）→ observation → finished ✓
  —— 即 review 复现的 "visual_context_budget_tokens 需为正整数" 400 不再出现；sidecar 回调 18080 正常（AI_FLASK_URL 推导生效）✓
- sidecar /healthz：200 ✓
- **2026-08-13 补充**：公网 HTTP 登录未 GO。后续带密码测试改走 `ssh -L 18080:127.0.0.1:18080 homePC`。
