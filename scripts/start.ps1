# PowerShell launcher — used by "npm run start:win".
# For a desktop shortcut, use start.bat (or run create-shortcut.ps1 once).

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $projectRoot

Write-Host "Verifying Electron install..." -ForegroundColor Cyan
# Always run the fixer — it checks BOTH the binary and path.txt and self-exits
# instantly when healthy. (The binary can be present while path.txt is missing,
# which still breaks launch.)
node scripts\fix-electron.js
if ($LASTEXITCODE -ne 0) {
    Write-Host "FAILED to repair Electron install" -ForegroundColor Red
    exit 1
}

# Start Ollama if it isn't already running, so one click starts everything.
# Mirrors the host normalization in src/main/ollama.ts (scheme + 0.0.0.0).
$ollamaHost = $env:OLLAMA_HOST
if ([string]::IsNullOrEmpty($ollamaHost)) { $ollamaHost = "127.0.0.1:11434" }
if ($ollamaHost -notmatch '^https?://') { $ollamaHost = "http://$ollamaHost" }
$ollamaHost = $ollamaHost -replace '0\.0\.0\.0', '127.0.0.1'

Write-Host "Checking Ollama at $ollamaHost..." -ForegroundColor Cyan
$ollamaUp = $false
try {
    Invoke-WebRequest -Uri "$ollamaHost/api/tags" -UseBasicParsing -TimeoutSec 2 | Out-Null
    $ollamaUp = $true
} catch {}

if ($ollamaUp) {
    Write-Host "Ollama already running." -ForegroundColor DarkGray
} else {
    $ollamaCmd = Get-Command ollama -ErrorAction SilentlyContinue
    if ($null -eq $ollamaCmd) {
        # Non-fatal: the app degrades gracefully (keyword search, no chat models)
        # and its model list polls, so a manually started Ollama is picked up.
        Write-Host "Ollama not found on PATH - chat models will be unavailable." -ForegroundColor Yellow
    } else {
        Write-Host "Starting ollama serve in the background..." -ForegroundColor Cyan
        Start-Process -FilePath $ollamaCmd.Source -ArgumentList "serve" -WindowStyle Hidden
        # The app polls for models every 3s, so no need to block on readiness.
    }
}

Write-Host "Starting AI Workspace..." -ForegroundColor Cyan
$env:ELECTRON_DISABLE_GPU = 1
npm run dev
