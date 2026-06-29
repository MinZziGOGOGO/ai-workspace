# Creates a desktop shortcut that opens AI Workspace by double-clicking.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/create-shortcut.ps1

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$batPath     = Join-Path $projectRoot "scripts\start.bat"
$iconPath    = Join-Path $projectRoot "resources\icon.ico"
$desktop     = [System.Environment]::GetFolderPath("Desktop")
$shortcut    = Join-Path $desktop "AI Workspace.lnk"

$shell = New-Object -ComObject WScript.Shell
$lnk   = $shell.CreateShortcut($shortcut)

$lnk.TargetPath       = "cmd.exe"
$lnk.Arguments        = "/c `"$batPath`""
$lnk.WorkingDirectory = $projectRoot.ToString()
$lnk.Description      = "AI Workspace - local-first AI workspace"
$lnk.WindowStyle      = 1

if (Test-Path $iconPath) { $lnk.IconLocation = $iconPath }

$lnk.Save()
Write-Host "Shortcut created: $shortcut" -ForegroundColor Green
Write-Host "Double-click it to open AI Workspace." -ForegroundColor Cyan
