$ErrorActionPreference='Stop'
$pidFile=Join-Path $PSScriptRoot 'state\gateway.pid'
if(!(Test-Path -LiteralPath $pidFile)){'No saved gateway process';return}
$taskPid=[int](Get-Content -LiteralPath $pidFile -Raw)
$p=Get-CimInstance Win32_Process -Filter "ProcessId=$taskPid"
if($p){
 if($p.ExecutablePath -ne 'D:\360Downloads\node.exe' -or $p.CommandLine -notlike '*workbuddy-gateway*gateway.cjs*'){throw 'PID identity mismatch'}
 & taskkill.exe /PID $taskPid /T /F | Out-Null
 if($LASTEXITCODE -ne 0){throw 'Gateway stop failed'}
}
Remove-Item -LiteralPath $pidFile -Force
'WorkBuddy gateway stopped'
