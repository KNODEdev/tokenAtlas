@echo off
setlocal
cd /d "%~dp0.."
title tokenAtlas - Remote archive collection
REM Uses the same collectors as local sync, including Desktop and OpenCode.
REM Configure TOKENATLAS_ARCHIVE in the environment or this installation's .env.
REM OneDrive is optional. Keep this script inside the tokenAtlas installation.
set "TASKNAME=tokenAtlas remote mirror"
if /I "%~1"=="uninstall" (
  schtasks /Delete /F /TN "%TASKNAME%"
  if errorlevel 1 exit /b 1
  exit /b 0
)
if /I "%~1"=="install" (
  schtasks /Create /F /TN "%TASKNAME%" /SC HOURLY /TR "\"%~f0\" auto"
  if errorlevel 1 exit /b 1
)
where bun >nul 2>&1
if errorlevel 1 (
  echo [X] Bun is required for consistent SQLite snapshots and retained source versions.
  echo Install Bun on this computer and run this collector again.
  exit /b 1
)
if not exist "src\sync\collector.ts" (
  echo [X] Keep scripts\remote-mirror.bat inside the tokenAtlas installation.
  exit /b 1
)
bun run src\sync\collector.ts
if errorlevel 1 (
  echo [X] Collection failed. Preserved versions remain available; inspect source errors.
  exit /b 1
)
echo [OK] Local archive collection finished. Remote delivery is not confirmed here.
exit /b 0
