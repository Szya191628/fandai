$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$exe = [System.IO.Path]::GetFullPath((Join-Path $root 'cli-proxy-api.exe'))
$pidFile = Join-Path $root 'state\cliproxyapi.pid'
$targets = @()
if (Test-Path -LiteralPath $pidFile) {
    $savedPid = 0
    $pidText = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    if (-not [int]::TryParse($pidText, [ref]$savedPid)) { throw 'PID file is invalid; refusing to stop any process.' }
    try { $process = [System.Diagnostics.Process]::GetProcessById($savedPid) } catch { $process = $null }
    if ($null -ne $process -and -not $process.HasExited) {
        try { $processPath = [System.IO.Path]::GetFullPath($process.MainModule.FileName) } catch { throw 'Cannot verify the PID file process path; refusing to stop it.' }
        if (-not [string]::Equals($processPath, $exe, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'PID file process path does not match this deployment; refusing to stop it.'
        }
        $targets += $process
    }
} else {
    foreach ($candidate in @(Get-Process -Name 'cli-proxy-api' -ErrorAction SilentlyContinue)) {
        try { $candidatePath = [System.IO.Path]::GetFullPath($candidate.Path) } catch { continue }
        if ([string]::Equals($candidatePath, $exe, [System.StringComparison]::OrdinalIgnoreCase)) { $targets += $candidate }
    }
}
if ($targets.Count -eq 0) {
    if (Test-Path -LiteralPath $pidFile) { Remove-Item -LiteralPath $pidFile -Force }
    Write-Output 'CLIProxyAPI is not running.'
    return
}
foreach ($process in $targets) {
    try { $currentPath = [System.IO.Path]::GetFullPath($process.MainModule.FileName) } catch { throw 'Cannot re-verify process path; refusing to stop it.' }
    if (-not [string]::Equals($currentPath, $exe, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Process path changed; refusing to stop it.' }
    $id = $process.Id
    $process.Kill()
    if (-not $process.WaitForExit(10000)) { throw "CLIProxyAPI PID $id did not exit within 10 seconds." }
    Write-Output "Stopped CLIProxyAPI (PID $id)."
}
if (Test-Path -LiteralPath $pidFile) { Remove-Item -LiteralPath $pidFile -Force }
