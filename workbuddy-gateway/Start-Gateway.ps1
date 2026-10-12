$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($PSScriptRoot)
$gateway=Join-Path $root 'gateway.cjs'
$node='D:\360Downloads\node.exe'
$state=Join-Path $root 'state'
if(!(Test-Path -LiteralPath $gateway)){throw 'Gateway code missing'}
$listener=Get-NetTCPConnection -LocalPort 8318 -State Listen -ErrorAction SilentlyContinue
if($listener){
  $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($listener[0].OwningProcess)"
  if($p.ExecutablePath -eq $node -and $p.CommandLine -like '*workbuddy-gateway*gateway.cjs*'){'WorkBuddy gateway already running';return}
  throw 'Port 8318 belongs to another service'
}
$env:WORKBUDDY_GATEWAY_KEY=(Get-Content -LiteralPath (Join-Path $state 'gateway-key.txt') -Raw).Trim()
$env:WB_NODE_PATH=$node
foreach($name in @('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY')){[Environment]::SetEnvironmentVariable($name,[Environment]::GetEnvironmentVariable($name,'User'),'Process')}
$p=Start-Process -FilePath $node -ArgumentList @($gateway) -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $state 'service.log') -RedirectStandardError (Join-Path $state 'service-error.log')
Start-Sleep -Seconds 1
$p.Refresh()
if($p.HasExited){throw 'Gateway exited during startup'}
[IO.File]::WriteAllText((Join-Path $state 'gateway.pid'),[string]$p.Id)
'WorkBuddy gateway started on localhost:8318'
