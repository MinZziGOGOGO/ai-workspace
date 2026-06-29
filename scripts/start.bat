@echo off
:: AI Workspace launcher — double-click this to open the app.
:: Automatically restores the Electron binary if npm install ate it.

:: Move to the project root regardless of where the shortcut calls from.
cd /d "%~dp0.."

echo [start] Verifying Electron install...
:: Always run the fixer — it checks BOTH the binary and path.txt and
:: self-exits instantly when healthy. (The binary can be present while
:: path.txt is missing, which still breaks launch.)
node scripts\fix-electron.js
if errorlevel 1 (
    echo.
    echo [start] FAILED to repair Electron install. See error above.
    pause
    exit /b 1
)

echo [start] Building and launching AI Workspace...
set ELECTRON_DISABLE_GPU=1
npm run dev
