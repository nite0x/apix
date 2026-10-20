param([string]$DataDirectory)
$ErrorActionPreference = 'Stop'
$taskRuntime = Join-Path $PSScriptRoot 'apix-runtime.exe'
if (-not (Test-Path -LiteralPath $taskRuntime)) {
    $taskRuntime = Join-Path (Split-Path -Parent $PSScriptRoot) 'release\apix-runtime.exe'
}
if (-not (Test-Path -LiteralPath $taskRuntime)) { throw 'Build the backend first: pnpm build:runtime' }
if (-not $DataDirectory) { $DataDirectory = Join-Path (Split-Path -Parent $taskRuntime) 'data' }
New-Item -ItemType Directory -Path $DataDirectory -Force | Out-Null
if (-not $env:APIX_DB_PATH) { $env:APIX_DB_PATH = Join-Path $DataDirectory 'apix.db' }
if (-not $env:APIX_LOG_PATH) { $env:APIX_LOG_PATH = Join-Path $DataDirectory 'runtime.log' }
$taskAddress = if ($env:APIX_ADDR) { $env:APIX_ADDR } else { '127.0.0.1:4317' }
Write-Host "Activity: http://$taskAddress/  MCP: http://$taskAddress/mcp  Ctrl+C stops it."
& $taskRuntime
exit $LASTEXITCODE
