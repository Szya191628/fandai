$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$exe = [System.IO.Path]::GetFullPath((Join-Path $root 'cli-proxy-api.exe'))
$config = [System.IO.Path]::GetFullPath((Join-Path $root 'config.yaml'))
$state = Join-Path $root 'state'
$pidFile = Join-Path $state 'cliproxyapi.pid'
$lockPath = Join-Path $state 'start.lock'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "Executable missing: $exe" }
if (-not (Test-Path -LiteralPath $config -PathType Leaf)) { throw "Config missing: $config" }
New-Item -ItemType Directory -Path $state -Force | Out-Null
try { $lock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None) }
catch { throw 'Another start operation is running; retry shortly.' }
try {
    if (Test-Path -LiteralPath $pidFile) {
        $savedPid = 0
        $pidText = (Get-Content -LiteralPath $pidFile -Raw).Trim()
        if (-not [int]::TryParse($pidText, [ref]$savedPid)) { throw 'PID file is invalid; refusing to start.' }
        try { $existing = [System.Diagnostics.Process]::GetProcessById($savedPid) } catch { $existing = $null }
        if ($null -ne $existing -and -not $existing.HasExited) {
            try { $existingPath = [System.IO.Path]::GetFullPath($existing.MainModule.FileName) } catch { throw 'Cannot verify the process in the PID file; refusing to start.' }
            if ([string]::Equals($existingPath, $exe, [System.StringComparison]::OrdinalIgnoreCase)) {
                Write-Output "CLIProxyAPI is already running (PID $savedPid)."
                return
            }
            throw 'PID file refers to a different executable; refusing to overwrite it.'
        }
        Remove-Item -LiteralPath $pidFile -Force
    }
    foreach ($candidate in @(Get-Process -Name 'cli-proxy-api' -ErrorAction SilentlyContinue)) {
        try { $candidatePath = [System.IO.Path]::GetFullPath($candidate.Path) } catch { continue }
        if ([string]::Equals($candidatePath, $exe, [System.StringComparison]::OrdinalIgnoreCase)) {
            [System.IO.File]::WriteAllText($pidFile, [string]$candidate.Id, [System.Text.Encoding]::ASCII)
            Write-Output "CLIProxyAPI is already running (PID $($candidate.Id))."
            return
        }
    }
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 8317 -ErrorAction SilentlyContinue)
    if ($listeners.Count -gt 0) { throw 'Local port 8317 is already in use; refusing to start a duplicate or unrelated listener.' }
    $process = Start-Process -FilePath $exe -ArgumentList @('-config', $config) -WorkingDirectory $root -WindowStyle Hidden -PassThru
    Start-Sleep -Milliseconds 500
    $process.Refresh()
    if ($process.HasExited) { throw "CLIProxyAPI exited during startup (exit code $($process.ExitCode))." }
    [System.IO.File]::WriteAllText($pidFile, [string]$process.Id, [System.Text.Encoding]::ASCII)
    Write-Output "CLIProxyAPI started in a hidden window (PID $($process.Id))."
} finally {
    $lock.Dispose()
}
