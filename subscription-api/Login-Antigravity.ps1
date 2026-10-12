$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$exe = Join-Path $root 'cli-proxy-api.exe'
$config = Join-Path $root 'config.yaml'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "Executable missing: $exe" }
if (-not (Test-Path -LiteralPath $config -PathType Leaf)) { throw "Config missing: $config" }
Push-Location $root
try {
    & $exe -config $config -antigravity-login
    if ($LASTEXITCODE -ne 0) { throw "Antigravity login exited with code $LASTEXITCODE." }
} finally {
    Pop-Location
}
