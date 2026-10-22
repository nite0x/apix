param(
    [string]$SourceDirectory = $PSScriptRoot,
    [switch]$NoLaunch
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This installer runs on Windows. Build the package in Ubuntu WSL.' }
$taskSource = (Resolve-Path -LiteralPath $SourceDirectory).ProviderPath
$taskInstall = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\Apix'))
$taskDesktop = [IO.Path]::GetFullPath([Environment]::GetFolderPath('Desktop'))
$taskBackups = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Apix\backups'))
$taskBackup = Join-Path $taskBackups ('desktop-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$taskFiles = @('THIRD-PARTY-NOTICES.txt', 'executors\linux-amd64\apix-executor', 'executors\linux-amd64\apix-executor.sha256', 'executors\linux-arm64\apix-executor', 'executors\linux-arm64\apix-executor.sha256', 'Apix.exe', 'apix-runtime.exe', 'Apix.exe.sha256', 'apix-runtime.exe.sha256', 'README-Windows.md', 'LICENSE')

foreach ($taskName in @('Apix.exe', 'apix-runtime.exe', 'executors\linux-amd64\apix-executor', 'executors\linux-arm64\apix-executor')) {
    $taskBinary = Join-Path $taskSource $taskName
    $taskChecksum = (Get-Content -LiteralPath ($taskBinary + '.sha256') -Raw).Trim().Split(' ')[0]
    if ((Get-FileHash -LiteralPath $taskBinary -Algorithm SHA256).Hash -ne $taskChecksum) {
        throw "Checksum verification failed: $taskName"
    }
}
# Detect the shared Evergreen Runtime before installing the desktop shell.
# Installing the Edge browser alone does not satisfy this dependency.
$taskWebView2Ready = $false
foreach ($taskRegistry in @(
    'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)) {
    $taskVersion = (Get-ItemProperty -LiteralPath $taskRegistry -Name pv -ErrorAction SilentlyContinue).pv
    if ($taskVersion -and $taskVersion -ne '0.0.0.0') { $taskWebView2Ready = $true }
}
if (-not $taskWebView2Ready) {
    throw 'Microsoft Edge WebView2 Runtime is required. Install Evergreen Runtime from https://developer.microsoft.com/microsoft-edge/webview2/ then run Install.ps1 again.'
}
New-Item -ItemType Directory -Path $taskInstall -Force | Out-Null
foreach ($taskName in $taskFiles) {
    $taskFrom = Join-Path $taskSource $taskName
    $taskTo = Join-Path $taskInstall $taskName
    if ([IO.Path]::GetFullPath($taskFrom) -ne [IO.Path]::GetFullPath($taskTo)) {
        New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($taskTo)) -Force | Out-Null
        Copy-Item -LiteralPath $taskFrom -Destination $taskTo -Force
    }
}

# Keep prior desktop distributions recoverable and keep all their data together.
$taskLegacyItems = Get-ChildItem -LiteralPath $taskDesktop -Force | Where-Object {
    $_.Name -match '(?i)^Apix[-_].*(portable|setup\.exe)(\.sha256)?$'
}
foreach ($taskItem in $taskLegacyItems) {
    $taskLegacy = [IO.Path]::GetFullPath($taskItem.FullName)
    if ([IO.Path]::GetDirectoryName($taskLegacy) -ne $taskDesktop) { throw 'Unexpected legacy desktop path.' }
    $taskDestination = [IO.Path]::GetFullPath((Join-Path $taskBackup $taskItem.Name))
    if (-not $taskDestination.StartsWith($taskBackups + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Backup destination is outside the Apix backup directory.'
    }
    New-Item -ItemType Directory -Path $taskBackup -Force | Out-Null
    Move-Item -LiteralPath $taskLegacy -Destination $taskDestination
}
$taskShell = New-Object -ComObject WScript.Shell
$taskLinkPath = Join-Path $taskDesktop 'Apix.lnk'
$taskLink = $taskShell.CreateShortcut($taskLinkPath)
$taskLink.TargetPath = Join-Path $taskInstall 'Apix.exe'
$taskLink.WorkingDirectory = $taskInstall
$taskLink.Description = 'Apix - Go + Microsoft Edge WebView2'
$taskLink.IconLocation = (Join-Path $taskInstall 'Apix.exe') + ',0'
$taskLink.Save()

Write-Output "Installed: $taskInstall"
Write-Output "Desktop shortcut: $taskLinkPath"
Write-Output "Data: $(Join-Path $env:LOCALAPPDATA 'Apix\data')"
Write-Output 'Desktop: Microsoft Edge WebView2 (backend http://127.0.0.1:4319/)'
if ($taskLegacyItems) { Write-Output "Previous desktop packages preserved: $taskBackup" }
if (-not $NoLaunch) {
    Start-Process -FilePath (Join-Path $taskInstall 'Apix.exe') -WorkingDirectory $taskInstall -WindowStyle Normal
}
