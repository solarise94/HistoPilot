# homePC Demo 部署记录（2026-08-13）

> 面向 PathTogether/HistoPilot 拆分演示的独立部署。生产版（lxbio）未动。

## 现状

| 项 | 值 |
|---|---|
| 主机 | homePC（SSH 别名 `homePC`，192.168.3.223） |
| 代码目录 | `~/svs-viewer-demo/`（rsync 自工作区，不含 .git/node_modules/.venv） |
| 镜像 | `localhost/svs-viewer-demo:latest`（podman build，Containerfile 多阶段） |
| 容器 | `svs-viewer-demo`，`--network host` + `--restart unless-stopped` |
| 端口 | Flask/gunicorn **8000**（docker_entry.sh 硬编码，PORT env 对 gunicorn 无效——待修） |
| sidecar | 127.0.0.1:8055（容器内同起，healthz 200） |
| 数据卷 | `~/svs-viewer-demo-data/{uploads,share}`（3 张合成切片 synth-{dense,heterogeneous,sparse}.tiff） |

## AI 配置（demo 临时值）

- base_url: `http://127.0.0.1:8317/v1`（host 网络直通 homePC 本地 CPA）
- model: `deepseek-v4-pro`（**临时**——gpt-5.6-luna 因 ikuncode 上游 auth_unavailable 暂不可用，恢复后换回 luna）
- api_protocol: openai；window_tier: balanced（400k/15%/1024·1280·768）
- 修改入口：`PUT http://<host>:8000/api/ai/config`

## 已知待办

1. **frp 公网入口（阻塞，等 sudo）**：jdcloud（117.72.24.99）frps-web 的 `allowPorts` 白名单只有 `[41081, 41082, 45495]`，新增高位端口需要 `sudo` 改 `/etc/frp/frps-web.toml` + 重启 frps-web，再在 homePC 起对应 frpc 隧道。主 frps（47000）是 QUIC-only，已被电信 UDP QoS 限速（这就是 46450 时断时续的根因）。
2. **docker_entry.sh PORT 硬编码**：gunicorn 写死 8000，`PORT` env 无效；改 `-b 0.0.0.0:${PORT:-8000}` 后重建镜像。
3. **CPA 本地监听 127.0.0.1**：host 网络是当前的解法；若改回 bridge 网络需让 CPA 监听局域网或加 proxy 进程。
4. 重建命令：`rsync 工作区 → homePC:~/svs-viewer-demo && podman build -t svs-viewer-demo:latest ~/svs-viewer-demo && podman rm -f svs-viewer-demo && podman run -d --name svs-viewer-demo --network host -v ~/svs-viewer-demo-data/uploads:/data/uploads -v ~/svs-viewer-demo-data/share:/data/share --restart unless-stopped svs-viewer-demo:latest`

## 验证记录

- 切片列表 API：3 张合成切片 ✓
- sidecar /healthz：200 ✓
- internal token 链路（slide_info）：fingerprint/尺寸正确 ✓
- AI 配置 PUT/GET：持久化 ✓（prompt_cache_mode 落为 auto，explicit 待查）
