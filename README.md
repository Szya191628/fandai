# 账号池系统（Account Pool）

本机 AI 模型账号池的部署与启动脚本集合，包含三个部分：

| 目录 | 说明 | 端口 |
|---|---|---|
| `subscription-api/` | [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 统一账号池后端（含本地启动/停止脚本与脱敏配置模板） | 8317 |
| `subscription-api-ui/` | [Cli-Proxy-API-Management-Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center) 管理面板（基于上游克隆，含少量本地定制） | - |
| `workbuddy-gateway/` | WorkBuddy 网关（Node.js，`gateway.cjs`），将 WorkBuddy 登录账号暴露为 OpenAI 兼容接口 | 8318 |

## 一键启停

```powershell
# 启动全部（网关 8318 + 账号池 8317，自带防重复启动保护）
.\Start-All.ps1

# 停止全部
.\Stop-All.ps1
```

- OpenAI 兼容接口：`http://127.0.0.1:8317/v1`
- Web 管理面板：`http://127.0.0.1:8317/v8/management`

## 部署要点

1. 下载 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI/releases) 的 `cli-proxy-api.exe` 放入 `subscription-api/`（二进制不入库）。
2. 复制 `subscription-api/config.local.example.yaml` 为 `config.yaml`，填入自己的 API Key 与代理地址。
3. 运行 `subscription-api/Login-Antigravity.ps1` 完成 OAuth 登录，凭据 JSON 会生成在 `auth/` 目录（不入库）。
4. `workbuddy-gateway` 启动时从 `state/gateway-key.txt` 读取网关密钥（不入库）。
5. 上游出网代理统一走 `requests.proxy-url`（本机为 `http://127.0.0.1:7990`）。

> **注意**：上游请求必须经过位于 Gemini/Antigravity 支持地区的出口节点，否则会报
> `User location is not supported for the API use`（400 FAILED_PRECONDITION）。
> 部分主机商（如 AS26383 Baxet Group）的 IP 虽然 GeoIP 显示在支持地区，
> 但 Google 按注册信息判定归属，会被拒绝。

## 安全说明

本仓库为公开仓库，以下内容**已排除、仅保留在本机**：

- OAuth 凭据（`subscription-api/auth/*.json`）
- API Key 与管理密钥（`config.yaml`、`connection.txt`）
- 网关密钥与运行日志（`workbuddy-gateway/state/`）
- 二进制与依赖（`cli-proxy-api.exe`、`node_modules/`）
