# PathTogether 集成

## 准备平台凭证

在 PathTogether 的插件管理中找到 `histopilot` installation，创建或轮换 secret。只把 installation id 和 secret 放进 HistoPilot 服务端环境变量。

```bash
PATHTOGETHER_URL=http://pathtogether:8000
PLUGIN_INSTALLATION_ID=<installation-id>
PLUGIN_HISTOPILOT_SECRET=<secret>
```

HistoPilot 会用 secret 换取短期 scoped JWT，再调用 `/api/plugin/v1` 获取切片 metadata/region、读取变更和写入标注。secret 和 JWT 都不得下发浏览器。

## 安装 UI bundle

```bash
npm run bundle:pathtogether
tar -xzf release/histopilot-pathtogether-plugin-0.1.0.tar.gz \
  -C /path/to/pathtogether/plugin-bundles
```

PathTogether 的 `PLUGIN_BUNDLES_DIR` 指向上述 `plugin-bundles`。重启平台后，它会从外部目录发现 `histopilot/manifest.json`，而不是从平台源码加载。

## 兼容网关

当前 UI bundle 通过 PathTogether 的同源 `/api/ai/*` 兼容网关调用 HistoPilot。平台的 `HISTOPILOT_URL` 应指向 HistoPilot 服务，双方设置相同的内部 token：

```bash
# PathTogether
HISTOPILOT_URL=http://histopilot:8055
HISTOPILOT_INTERNAL_TOKEN=<random-secret>

# HistoPilot
HISTOPILOT_INTERNAL_TOKEN=<random-secret>
```

兼容网关将在后续 contract major 中替换为通用 plugin BFF；这不影响仓库、进程、数据和产品版本已经独立。

PathTogether 的旧变量 `AI_SIDECAR_URL`、`AI_INTERNAL_TOKEN` 仍支持一个迁移周期。

## 验收

1. HistoPilot 停止时 PathTogether 人工读片仍正常。
2. bundle 未安装时 PathTogether 不显示 AI 入口。
3. installation disable 后已有 JWT 也立即失效。
4. HistoPilot 只持久化自己的 session，不挂载 PathTogether share-data。
