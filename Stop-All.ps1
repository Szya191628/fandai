$ErrorActionPreference = 'SilentlyContinue'
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)

Write-Host "================ 停止本地账号池系统 ================" -ForegroundColor Cyan

# 1. 停止 CLIProxyAPI
$cpaStop = Join-Path $root 'subscription-api\Stop-CLIProxyAPI.ps1'
if (Test-Path -LiteralPath $cpaStop) {
    Write-Host "[1/2] 正在停止 统一账号池后端 (8317)..." -ForegroundColor Yellow
    & $cpaStop
}

# 2. 停止 WorkBuddy Gateway
$wbStop = Join-Path $root 'workbuddy-gateway\Stop-Gateway.ps1'
if (Test-Path -LiteralPath $wbStop) {
    Write-Host "[2/2] 正在停止 WorkBuddy 网关 (8318)..." -ForegroundColor Yellow
    & $wbStop
}

Write-Host "================ 全部服务已停止 ================" -ForegroundColor Green
