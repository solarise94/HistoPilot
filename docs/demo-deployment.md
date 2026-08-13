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

## 分离部署（Stage 4-3 可选形态）

> 同容器（`ROLE=all`，上文默认命令）仍是**默认且受支持**的部署形态。本节是
> **可选**的拆分形态：把平台（Flask/gunicorn）与 AI sidecar 拆成两个容器。
> 红线：同容器模式必须继续工作——分离只是形态选择，不是强制。

### 会话目录分离（同容器也生效）

Stage 4-3 起 sidecar 会话不再与平台 `SHARE_DATA_DIR` 混放，而是用独立目录：

- 目录解析优先级：`AI_SESSIONS_DIR`（env）> 缺省 `~/.svs-sidecar/sessions`。
- 同容器（`ROLE=all`）`docker_entry.sh` 显式 `export AI_SESSIONS_DIR=/data/sidecar-sessions`，
  Containerfile 已声明并 `mkdir` 该目录；容器加一个可选卷挂载点即可持久化：
  `-v ~/svs-viewer-demo-data/sidecar-sessions:/data/sidecar-sessions`。
- **一次性迁移**：`docker_entry.sh` 启动时若新目录为空且旧目录
  `SHARE_DATA_DIR/ai_sessions` 存在，则把旧内容 `mv` 进新目录（仅 once）。

```sh
# 同容器 + 会话独立卷（在既有重建命令基础上加一行卷挂载）：
podman run -d --name svs-viewer-demo \
  --network host \
  -v ~/svs-viewer-demo-data/uploads:/data/uploads \
  -v ~/svs-viewer-demo-data/share:/data/share \
  -v ~/svs-viewer-demo-data/sidecar-sessions:/data/sidecar-sessions \
  ...
```

### 两容器命令

**平台容器**（`ROLE=platform`，只 gunicorn）：

```sh
podman run -d --name svs-platform \
  --network host \
  -v ~/svs-viewer-demo-data/uploads:/data/uploads \
  -v ~/svs-viewer-demo-data/share:/data/share \
  --restart unless-stopped \
  -e PORT=18080 -e ROLE=platform \
  --env-file ~/svs-viewer-demo-data/admin.env \
  svs-viewer-demo:latest
```

**sidecar 容器**（`ROLE=sidecar`，只 sidecar）。需要：
- `AI_FLASK_URL` 指向平台容器的可达地址（host 网络下即 `http://127.0.0.1:18080`）；
- `PLUGIN_INSTALLATION_ID` / `PLUGIN_HISTOPILOT_SECRET`（或挂载平台凭证文件）——见下节；
- `AI_SESSIONS_DIR` 指向 sidecar 专属卷。

```sh
podman run -d --name svs-sidecar \
  --network host \
  -v ~/svs-viewer-demo-data/sidecar-sessions:/data/sidecar-sessions \
  --restart unless-stopped \
  -e ROLE=sidecar \
  -e AI_FLASK_URL=http://127.0.0.1:18080 \
  -e AI_SESSIONS_DIR=/data/sidecar-sessions \
  -e PLUGIN_INSTALLATION_ID=pin_xxxx \
  -e PLUGIN_HISTOPILOT_SECRET=<secret-from-platform> \
  svs-viewer-demo:latest
```

### 凭证从哪来

平台容器引导会写 `SHARE_DATA_DIR/plugin-secret-histopilot.txt`（JSON
`{installation_id, secret}`，0600）。sidecar 容器与平台不同卷，**读不到该文件**，
必须把凭证配进 sidecar 容器 env：

```sh
# 在平台容器上读取引导凭证：
podman exec svs-platform cat /data/share/plugin-secret-histopilot.txt
# 把 JSON 里的 installation_id / secret 填到 sidecar 容器的
# PLUGIN_INSTALLATION_ID / PLUGIN_HISTOPILOT_SECRET env 后启动。
```

平台侧「插件管理」UI 里点「轮换凭证」后，新明文**只展示一次**，同样需要手工
回填到 sidecar 容器 env 并重启 sidecar（凭证不自动同步，见上文已知限制）。

### 启动顺序

sidecar 依赖平台先就绪（否则回调失败）。`ROLE=sidecar` 的 entrypoint 在起
sidecar 前会轮询 `AI_FLASK_URL/login` 可达（最多 30s，超时退出）。建议先起
平台容器，再起 sidecar 容器。

### 健康检查

- 平台 `GET /healthz`：`{"ok":true,"backend":"json|postgres","sidecar":"reachable|unreachable"}`。
  `sidecar` 字段只上报可达性，**不可达不导致 503**（platform 角色无 sidecar 也健康）。
- sidecar `GET /healthz`：`{"ok":true}`（已有）。
- 降级可观测：平台 `/api/admin/plugins` 列表项的 `health` 字段 = sidecar 可达性快照
  （reachable/unreachable），替代此前的占位 "unknown"。

## PostgreSQL 模式（Stage 3b-3）

Stage 3b 把存储层从 JSON 文件迁到 PostgreSQL（最终唯一存储，决策 #8）。过渡期
`STORAGE_BACKEND` 三态：`json`（默认，零变化）/ `dual`（expand 形态：读 json 权威、
写镜像 pg）/ `postgres`（pg 唯一存储）。demo 切换流程如下。

### 架构

- demo app 容器（本镜像）+ 同机一个 `postgres:16` 容器，host 网络下走
  `127.0.0.1:5433`（避开本机 5432）。
- app 容器经 `DATABASE_URL` 连库；`docker_entry.sh` 与 `app.py` 启动期都会
  `ensure_schema`（幂等 + pg_advisory_lock 串行化多 worker），连不上/迁移失败即
  fail-fast 退出，绝不带病启动。

### DATABASE_URL 形态

```
DATABASE_URL=postgresql://svs:STRONG_PASSWORD@127.0.0.1:5433/svsviewer
```

（host 网络下 app 容器直连 127.0.0.1；bridge 网络下改成 postgres 容器名。）

### 迁移命令序列（停写窗口执行）

迁移工具 `scripts/migrate_json_to_pg.py` 只读 json（不经 dispatcher，与当前
`STORAGE_BACKEND` 无关），所有写落 pg。**迁移期间必须停 json 写路径**（关停
gunicorn / share_server）。

```sh
# 1) 起 postgres:16 容器（host 网络，5433）并建库/建用户（略）

# 2) 只读核对：看将导入多少实体 + 潜在问题（不碰 pg）
DATABASE_URL=postgresql://svs:...@127.0.0.1:5433/svsviewer \
  python3 scripts/migrate_json_to_pg.py dry-run

# 3) 执行导入（单事务、幂等；自动备份源 json + 写 mapping.json 到备份目录）
DATABASE_URL=postgresql://svs:...@127.0.0.1:5433/svsviewer \
  python3 scripts/migrate_json_to_pg.py apply

# 4) 双读核对 json vs pg（0 差异为 OK；有差异 exit 2）
DATABASE_URL=postgresql://svs:...@127.0.0.1:5433/svsviewer \
  python3 scripts/migrate_json_to_pg.py verify

# 5) 切 STORAGE_BACKEND=postgres 重启 app（json 写路径此后停用）
STORAGE_BACKEND=postgres DATABASE_URL=postgresql://svs:... ...
```

### 回滚路径

```sh
# 从 apply 生成的备份目录把 json 拷回 SHARE_DATA_DIR
python3 scripts/migrate_json_to_pg.py rollback --backup-dir <备份目录> --yes
# 然后 STORAGE_BACKEND=json（或取消该 env）并重启服务。
# PG 中的导入数据仍保留；如需清空可手动 TRUNCATE 业务表。
```

### 已知限制

- json 写路径 contract（删除 json 写、pg 成为唯一存储）留后续 Stage 3b contract
  阶段；当前 `dual` 仍保留 json 写路径，仅 expand 形态读 json。
- `change_seq`：json 是 per-slide 计数器，pg 是 `change_log` 全局 bigserial，数值
  不 1:1 保留（`share_store_pg` 已声明的允许实现差；单调/按 slide 过滤语义一致）。
- `ai_config.json`（平台 AI 配置）**不在迁移范围**：它是平台配置而非用户数据，
  仍留文件（owner 读写，见 app.py `_load_ai_config`）。
- **sidecar 插件凭证轮转**（Stage 4-1b）：`POST /api/admin/plugins/<installation_id>/rotate-secret`
  返回的新明文**仅一次**，且**不会自动同步**到 sidecar 可见的凭证文件/环境
  （`plugin-secret-histopilot.txt` 或 `PLUGIN_HISTOPILOT_SECRET`/`PLUGIN_INSTALLATION_ID`）。
  轮换后旧的 sidecar 缓存 token 会 401 unauthorized（token 换取失败）而无法换新——
  需手工把新明文写回 sidecar 可见的文件（或更新 env）并重启 sidecar。当前 demo 里
  Flask 与 sidecar 同容器同卷（`SHARE_DATA_DIR` 共享），故引导写入的文件天然对
  sidecar 可见、无感；一旦二者拆开（不同容器/主机），轮换后必须同步更新 sidecar
  侧的凭证来源。插件管理 UI（owner）点轮换后会把新明文**展示一次**并提供复制按钮 +
  分发到 sidecar 容器 env 的提示。

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

## 验证记录（2026-08-14，Stage 3a 全部落地后重建）

- 未登录：/ → 302；/api/slides、/api/ai/config → 401 ✓
- owner（browser_admin）登录：/api/auth/info 返回 role=owner；/api/ai/config 返回 using=platform、platform_configured=true、window_tier=balanced ✓
- 插件 bundle 7 个 js 全 200（/plugins/histopilot/ui/*）✓
- 用户管理：owner 建 user（smoke@test.local）✓；user 登录后 config 视角 use_platform=true/using=platform；user 改调优字段 → 403 ✓；user 切片列表为空（无自有/公开/分享切片）✓；user 跑 owner 切片 AI → 403 ✓；user 拉他人切片 sessions → 403 ✓
- 真实 AI run（synth-dense.tiff，MiniMax-M3，fresh）：slide_opened → snapshot → 中文描述 → session_ended finished ✓；owner 名下会话 owner=None（设计：owner 不注入 session_owner，user 过滤自然不可见）✓
- 冒烟用户已禁用（disable → 登录 401）✓；**注意**：/api/admin/users 暂无 DELETE，只有 disable/enable/password
- 本次重建曾暴露 Containerfile 漏 COPY user_store.py（gunicorn worker 起不来），已修（c79e688）并加静态守卫测试 test_containerfile_ships_app_modules


### 切换演练记录（2026-08-14，demo 已切 postgres 为终态）

1. `postgres:16` 容器 `svs-pg`：host 网络、`127.0.0.1:5433`、数据卷 `~/svs-pg-data`、
   `--restart unless-stopped`；账号 `svs` / 库 `svs_demo`，密码与 DATABASE_URL 在
   `~/svs-viewer-demo-data/pg.env`（0600，含 `STORAGE_BACKEND=postgres`）。
2. 迁移：dry-run（users 2，其余 0——demo 数据极简）→ apply（备份 +
   mapping.json 在 `/data/share/migration-backup-*/`）→ verify 0 差异 ✓
3. 切后端：demo 容器加 `--env-file pg.env` 重启 → 启动期 ensure_schema 过、
   gunicorn 正常 ✓
4. PG 后端公网冒烟：登录 302（PG verify_user）✓；slides 列表 ✓；建分享 +
   管理员标注落 PG（psql 直查 shares/rois 表确认）✓；真实 M3 AI run finished ✓
5. 回滚演练：摘 STORAGE_BACKEND 重启 → json 后端登录正常 ✓；回切 postgres →
   PG 时代建的分享仍在 ✓（注意：切换后回滚会丢 PG 时代的写——json 与 pg 自此
   发散，故 verify 通过应立即切换，勿长时双轨）
6. 冒烟数据已清理（分享吊销、标注删除）。demo 现以 **postgres 为唯一存储**运行；
   json 文件保留为迁移备份。

### 双容器分离演练记录（2026-08-14 晚，Stage 4-3 验收）

demo 当前拓扑（终态）：

- `svs-viewer-demo`（ROLE=platform）：卷 uploads + share；env admin.env + pg.env；
  无 sidecar 进程、无 sessions 卷
- `svs-sidecar`（ROLE=sidecar）：仅卷 sidecar-sessions；env plugin-sidecar.env
  （PLUGIN_INSTALLATION_ID + PLUGIN_HISTOPILOT_SECRET，0600，从平台引导的
  plugin-secret-histopilot.txt 提取）+ AI_FLASK_URL=http://127.0.0.1:18080
- 两容器 host 网络经 loopback 互调；**平台与插件不共享卷/数据库** ✓
- 验收：AI run 跨容器 finished ✓；停 svs-sidecar → 平台 /healthz 200
  （sidecar:unreachable 不 fail）、slides/标注正常、AI 503 ✓；重启 sidecar →
  reachable 自动恢复 ✓
- 修复记录：/healthz 曾遭 _require_auth 302（8bf2c20 修复 + 回归测试）；
  会话目录一次性迁移 entry 日志确认（ai_sessions → /data/sidecar-sessions）

### Stage 5（通用插件 SDK）部署记录（2026-08-14 清晨）

- 镜像重建（含 5-1/5-2/5-3），双容器（svs-viewer-demo=platform / svs-sidecar）
  均 rm -f + run 重建（podman restart 不吃新镜像，老坑）。
- 平台容器新增 `-e SAMPLE_PLUGIN_ENABLED=1`：示例插件面板在 demo 默认开启，
  便于验收「非 HistoPilot 最小插件」；关闭去掉该 env 重建即可。
- 烟雾（公网 http://117.72.24.99:41083 全链路）：
  - /healthz ok（backend=postgres，sidecar=reachable）；sidecar /healthz ok；
  - 插件资产 200：histopilot/ui/main.js、sample-annotator/ui/main.js、
    sdk/ui/bridge-client.js、sample-annotator/ui/index.html（.html 白名单）、
    static/bridge-version.js、static/plugin-permissions.js；
  - /api/plugin/v1/capabilities：无 token 401 unauthorized；容器内铸 HS256
    plugin JWT（key=sha256("plugin-jwt:"+ai_secret.key) **raw digest**，不是
    hexdigest——第一次铸错教训）→ 200，返回 contract/bridge 版本 + majors；
  - 路径穿越 --path-as-is /plugins/../../app.py → 404；
  - 登录（browser_admin）后 / 注入 SVS_PLUGIN_PERMISSIONS=
    {"sample-annotator":[slide:metadata:read,viewer:navigate,annotation:write]}；
  - 真实 AI run（synth-dense，fresh，公网 SSE）：148 事件 finished ✓。
- 烟雾抓出并修复的两个 5-2 遗留 bug（24be69a）：
  1. SDK 资产原放 plugins/sdk/bridge-client.js（无 ui/ 层）→ 通用路由
     /plugins/<id>/ui/<file> 匹配不到 404；移入 plugins/sdk/ui/ 后 200；
  2. 插件静态白名单仅 .js/.css → manifest ui.entry 的独立页 .html 403；
     白名单加 .html（send_from_directory 原样返回，不经模板渲染）。
  另有嵌入模式面板 DOM 自举修复（0779942）。
- 来源策略 plugins/source-policy.json 随 COPY plugins/ 进镜像；改 manifest 后
  必须重算 sha256 同步该文件（仓库有防漂移守卫测试）。
