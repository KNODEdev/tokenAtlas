@echo off
title tokenAtlas - Sync
cd /d "%~dp0"

REM Compatibility entry point only. The application and this wrapper both enter
REM src/sync/coordinator.ts through src/sync/cli.ts.
call bun run sync -- %*
set "SYNC_EXIT=%ERRORLEVEL%"

set "AUTO="
for %%A in (%*) do if /I "%%~A"=="auto" set "AUTO=1"
if not "%SYNC_EXIT%"=="0" echo [X] Sync failed with exit code %SYNC_EXIT%.
if not defined AUTO pause
exit /b %SYNC_EXIT%
