@echo off
setlocal enabledelayedexpansion
title tokenAtlas - Restore
cd /d "%~dp0"

where bun >nul 2>&1 || (echo [X] Bun not found in PATH & pause & exit /b 1)
set "DB_PATH="
for /f "delims=" %%p in ('bun scripts\dev\active-paths.ts database') do set "DB_PATH=%%p"
if not defined DB_PATH (echo [X] Cannot resolve the active database & pause & exit /b 1)
set "CONFIG_ROOT="
for /f "delims=" %%p in ('bun scripts\dev\active-paths.ts config') do set "CONFIG_ROOT=%%p"
if not defined CONFIG_ROOT (echo [X] Cannot resolve the configuration directory & pause & exit /b 1)

set "CONFIG_DUMP_DIR=%OneDrive%\_Hub\_DB\tokenAtlas\config"
for %%d in ("!DB_PATH!") do set "DB_DUMP_DIR=%%~dpdbackups"
if defined TOKENATLAS_DUMP_DIR set "DB_DUMP_DIR=%TOKENATLAS_DUMP_DIR%"

REM Same port rule as _dev.bat: the code default, overridden by PORT in .env.
set "PORT_APP=7331"
for /f "tokens=1,* delims==" %%a in ('findstr /B "PORT=" .env 2^>nul') do set "PORT_APP=%%b"

echo === tokenAtlas - Restore ===
echo.
echo   DB dump:  !DB_DUMP_DIR!\atlas.sqlite
echo   Target:   !DB_PATH!
echo   Config:   !CONFIG_DUMP_DIR! -^> !CONFIG_ROOT!
echo.

if not exist "!DB_DUMP_DIR!\atlas.sqlite" (
  echo [i] No database snapshot found - rebuild the index with _sync.bat instead.
  goto skip_db
)

netstat -ano | findstr ":!PORT_APP! .*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [X] Something is listening on !PORT_APP! - the tokenAtlas server is probably running.
  echo [X] Stop it first, otherwise the running process keeps the old database open
  echo [X] and writes its WAL back over the restored file.
  pause
  exit /b 1
)

echo UWAGA: To nadpisze baze !DB_PATH!
choice /c YN /m "Kontynuowac"
if errorlevel 2 goto skip_db

echo.
echo [1/2] Restoring database...
for %%d in ("!DB_PATH!") do if not exist "%%~dpd" mkdir "%%~dpd" >nul 2>&1
copy /y "!DB_DUMP_DIR!\atlas.sqlite" "!DB_PATH!" >nul
if errorlevel 1 (echo [X] Database restore failed & pause & exit /b 1)
REM A stale WAL/SHM from the replaced database would be replayed onto the restored file.
del /q "!DB_PATH!-wal" >nul 2>&1
del /q "!DB_PATH!-shm" >nul 2>&1
echo [OK] Database restored.
goto config_restore

:skip_db
echo [i] Skipping database restore.

:config_restore
echo.
if not exist "!CONFIG_DUMP_DIR!" goto done
echo [2/2] Restoring config files...
set "CFG_OVERWRITE=0"
echo Overwrite existing local config files with the backup?
echo   Y = replace all   N = only restore files that are missing locally
choice /c YN /m "Overwrite existing"
if not errorlevel 2 set "CFG_OVERWRITE=1"

if not exist "!CONFIG_ROOT!" mkdir "!CONFIG_ROOT!" >nul 2>&1
for %%f in ("!CONFIG_DUMP_DIR!\*.json") do (
  set "DO_COPY=1"
  if exist "!CONFIG_ROOT!\%%~nxf" if "!CFG_OVERWRITE!"=="0" set "DO_COPY=0"
  if "!DO_COPY!"=="1" (
    copy /y "%%f" "!CONFIG_ROOT!\%%~nxf" >nul
    if errorlevel 1 (echo [X] Config restore failed on %%~nxf & pause & exit /b 1)
    echo   - %%~nxf  ^(restored^)
  ) else (
    echo   - %%~nxf  ^(exists, kept^)
  )
)
echo [OK] Config restore finished.

:done
echo.
echo [OK] Restore finished.
pause
