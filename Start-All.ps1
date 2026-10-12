$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)

Write-Host "================ 启动本地账号池系统 ================" -ForegroundColor Cyan

# 1. 启动 WorkBuddy Gateway (端口 8318)
$wbStart = Join-Path $root 'workbuddy-gateway\Start-Gateway.ps1'
if (Test-Path -LiteralPath $wbStart) {
    Write-Host "[1/2] 正在启动 WorkBuddy 网关 (8318)..." -ForegroundColor Yellow
    & $wbStart
} else {
    Write-Warning "未找到: $wbStart"
}

# 2. 启动 CLIProxyAPI 统一账号池后端 (端口 8317)
$cpaStart = Join-Path $root 'subscription-api\Start-CLIProxyAPI.ps1'
if (Test-Path -LiteralPath $cpaStart) {
    Write-Host "[2/2] 正在启动 统一账号池后端 (8317)..." -ForegroundColor Yellow
    & $cpaStart
} else {
    Write-Warning "未找到: $cpaStart"
}

Write-Host "================ 服务启动检查完成 ================" -ForegroundColor Green
Write-Host "OpenAI 兼容接口: http://127.0.0.1:8317/v1"
Write-Host "Web 管理面板:   http://127.0.0.1:8317/v8/management"
