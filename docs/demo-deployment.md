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

## 公网入口（2026-08-13 已通）

- **`http://117.72.24.99:41083`** ← jdcloud frps-web（allowPorts 已加 41083，`frps-web.toml.bak.add41083_*` 备份）← homePC frpc-svs-demo（TCP 47001）← 容器 18080。
- frpc 配置：`~/.config/frp/frpc-svs-demo.toml`（nohup 后台跑，未做 systemd——重启 homePC 后需手动拉起，记入待办）。

## 已知待办

1. **frpc-svs-demo 未纳入 systemd**：homePC 重启后 frp 隧道不自动恢复（其余 frpc 实例同为 nohup，习惯一致；可后续统一改 systemd user unit）。
2. **docker_entry.sh PORT**：已修（gunicorn 尊重 PORT env，`d96968a`）。
3. **CPA 本地监听 127.0.0.1**：host 网络是当前的解法；若改回 bridge 网络需让 CPA 监听局域网或加 proxy 进程。
4. **模型**：demo 现用 MiniMax-M3（快、不限流）。luna 限流恢复后如需换回，`PUT http://127.0.0.1:18080/api/ai/config {"model":"gpt-5.6-luna"}`。
5. 重建命令：`rsync 工作区 → homePC:~/svs-viewer-demo && podman build -t svs-viewer-demo:latest ~/svs-viewer-demo && podman rm -f svs-viewer-demo && podman run -d --name svs-viewer-demo --network host -v ~/svs-viewer-demo-data/uploads:/data/uploads -v ~/svs-viewer-demo-data/share:/data/share --restart unless-stopped -e PORT=18080 svs-viewer-demo:latest`

## 验证记录

- 切片列表 API：3 张合成切片 ✓
- sidecar /healthz：200 ✓
- internal token 链路（slide_info）：fingerprint/尺寸正确 ✓
- AI 配置 PUT/GET：持久化 ✓（prompt_cache_mode 落为 auto，explicit 待查）
