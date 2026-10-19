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
$taskFiles = @('Apix.exe', 'apix-runtime.exe', 'Apix.exe.sha256', 'apix-runtime.exe.sha256', 'README-Windows.md', 'LICENSE')

foreach ($taskName in @('Apix.exe', 'apix-runtime.exe')) {
    $taskBinary = Join-Path $taskSource $taskName
    $taskChecksum = (Get-Content -LiteralPath ($taskBinary + '.sha256') -Raw).Trim().Split(' ')[0]
    if ((Get-FileHash -LiteralPath $taskBinary -Algorithm SHA256).Hash -ne $taskChecksum) {
        throw "Checksum verification failed: $taskName"
    }
}
New-Item -ItemType Directory -Path $taskInstall -Force | Out-Null
foreach ($taskName in $taskFiles) {
    $taskFrom = Join-Path $taskSource $taskName
    $taskTo = Join-Path $taskInstall $taskName
    if ([IO.Path]::GetFullPath($taskFrom) -ne [IO.Path]::GetFullPath($taskTo)) {
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
$taskLink.Description = 'Apix - Local API workspace'
$taskLink.IconLocation = (Join-Path $taskInstall 'Apix.exe') + ',0'
$taskLink.Save()

Write-Output "Installed: $taskInstall"
Write-Output "Desktop shortcut: $taskLinkPath"
Write-Output "Data: $(Join-Path $env:LOCALAPPDATA 'Apix\data')"
Write-Output 'Workspace: http://127.0.0.1:4319/'
if ($taskLegacyItems) { Write-Output "Previous desktop packages preserved: $taskBackup" }
if (-not $NoLaunch) {
    Start-Process -FilePath (Join-Path $taskInstall 'Apix.exe') -WorkingDirectory $taskInstall -WindowStyle Hidden
}
