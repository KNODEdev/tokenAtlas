@echo off
setlocal enabledelayedexpansion
title tokenAtlas - Dump
cd /d "%~dp0"

REM --- Locations come from the app (Settings), never from defaults repeated here ---
where bun >nul 2>&1 || (echo [X] Bun not found in PATH & pause & exit /b 1)
set "DB_PATH="
for /f "delims=" %%p in ('bun scripts\dev\active-paths.ts database') do set "DB_PATH=%%p"
if not defined DB_PATH (echo [X] Cannot resolve the active database & pause & exit /b 1)
set "CONFIG_ROOT="
for /f "delims=" %%p in ('bun scripts\dev\active-paths.ts config') do set "CONFIG_ROOT=%%p"
if not defined CONFIG_ROOT (echo [X] Cannot resolve the configuration directory & pause & exit /b 1)

REM Config files go to OneDrive (a few KB, hand-maintained, irreplaceable).
REM The database snapshot stays next to the database: it is derived data, rebuildable
REM with _sync.bat, and not worth re-uploading on every dump. Override with TOKENATLAS_DUMP_DIR.
set "CONFIG_DUMP_DIR=%OneDrive%\_Hub\_DB\tokenAtlas\config"
for %%d in ("!DB_PATH!") do set "DB_DUMP_DIR=%%~dpdbackups"
if defined TOKENATLAS_DUMP_DIR set "DB_DUMP_DIR=%TOKENATLAS_DUMP_DIR%"

echo === tokenAtlas - Dump ===
echo.
echo   Database:  !DB_PATH!
echo   DB dump:   !DB_DUMP_DIR!
echo   Config:    !CONFIG_ROOT!
echo   Backup:    !CONFIG_DUMP_DIR!
echo.

echo [1/2] Snapshotting database ^(VACUUM INTO - safe while the server runs^)...
if not exist "!DB_PATH!" (
  echo [X] Database not found: !DB_PATH!
  echo [X] Build the index first with _sync.bat.
  pause
  exit /b 1
)
if not exist "!DB_DUMP_DIR!" mkdir "!DB_DUMP_DIR!" >nul 2>&1
call bun scripts\dev\db-backup.ts "!DB_PATH!" "!DB_DUMP_DIR!\atlas.sqlite"
if errorlevel 1 (echo [X] Database snapshot failed & pause & exit /b 1)
echo [OK] Database snapshot written.
echo.

echo [2/2] Backing up config files...
if not exist "!CONFIG_ROOT!" (echo [X] Configuration directory not found: !CONFIG_ROOT! & pause & exit /b 1)
if not exist "!CONFIG_DUMP_DIR!" mkdir "!CONFIG_DUMP_DIR!" >nul 2>&1
for %%f in ("!CONFIG_ROOT!\*.json") do (
  copy /y "%%f" "!CONFIG_DUMP_DIR!\%%~nxf" >nul
  if errorlevel 1 (echo [X] Config backup failed on %%~nxf & pause & exit /b 1)
  echo   - %%~nxf
)
echo [OK] Config backed up to: !CONFIG_DUMP_DIR!

echo.
echo On this PC: _restore.bat brings both back.
echo On another PC: config arrives through OneDrive, then _sync.bat rebuilds the index
echo ^(the DB snapshot is local only, by design^).
pause
