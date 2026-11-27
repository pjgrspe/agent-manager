$ErrorActionPreference = "Stop"

$AppDir = (Resolve-Path $PSScriptRoot).Path
$ElectronExe = Join-Path $AppDir "node_modules\electron\dist\electron.exe"

if (-not (Test-Path $ElectronExe)) {
    throw "Electron binary not found at $ElectronExe. Run 'npm install' first."
}

$StartMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$ShortcutPath = Join-Path $StartMenuDir "Agent Manager.lnk"

$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $ElectronExe
$Shortcut.Arguments = "`"$AppDir`""
$Shortcut.WorkingDirectory = $AppDir
$Shortcut.Description = "Agent Manager — Multi-Project Command Center"
$Shortcut.Save()

Write-Host "Created Start Menu shortcut: $ShortcutPath" -ForegroundColor Green
Write-Host "Press Windows key, search 'Agent Manager', right-click -> 'Pin to taskbar'." -ForegroundColor Cyan
