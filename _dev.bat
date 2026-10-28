@echo off
title tokenAtlas - DEV
cd /d "%~dp0"

REM tokenAtlas: Bun + SQLite, no Docker, no compose. The server binds 127.0.0.1
REM (src/server/api.ts -> startServer) and serves both /api/* and public/index.html.

REM --- Port: default lives in code; .env is optional and wins if present ---
set "PORT_APP=7331"
for /f "tokens=1,* delims==" %%a in ('findstr /B "PORT=" .env 2^>nul') do set "PORT_APP=%%b"
set "PORT=%PORT_APP%"

echo === tokenAtlas - DEV ===
echo.

REM --- Prerequisites ---
REM The official Bun (%USERPROFILE%\.bun\bin, installed if missing) goes first in PATH: a copy from
REM another installer earlier in PATH may be older (winget 1.4.0 ran the app while tests used 1.4.2).
call :install_bun || (pause & exit /b 1)
for /f "delims=" %%v in ('bun --version') do set "BUN_VERSION=%%v"
echo [0] Bun %BUN_VERSION%
where curl >nul 2>&1 || (echo [X] curl not found in PATH & pause & exit /b 1)

REM --- Reuse dependencies only when inputs and actual imports are healthy ---
set "NEED_INSTALL=0"
set "LOCK_NEWER="
set "PKG_NEWER="
set "DEPENDENCIES_REPAIRED=0"

if not exist "node_modules" set "NEED_INSTALL=1"
if not exist ".dev-cache\bun-install.stamp" set "NEED_INSTALL=1"
if "%NEED_INSTALL%"=="1" goto do_install

for /f "delims=" %%i in ('powershell -NoProfile -Command "[int]((Get-Item bun.lock).LastWriteTime -gt (Get-Item .dev-cache\bun-install.stamp).LastWriteTime)"') do set "LOCK_NEWER=%%i"
if "%LOCK_NEWER%"=="1" goto do_install

for /f "delims=" %%i in ('powershell -NoProfile -Command "[int]((Get-Item package.json).LastWriteTime -gt (Get-Item .dev-cache\bun-install.stamp).LastWriteTime)"') do set "PKG_NEWER=%%i"
if "%PKG_NEWER%"=="1" goto do_install

call :check_dependencies >nul 2>&1
if errorlevel 1 goto repair_install

echo [1] Dependencies up-to-date - skipping install.
goto after_install

:repair_install
echo [1] Dependencies missing or damaged - rebuilding with a fresh cache and file copies...
set "DEPENDENCIES_REPAIRED=1"
call bun scripts\dev\repair-dependencies.ts
if errorlevel 1 (echo [X] Dependency repair failed - see the error above. & pause & exit /b 1)
goto verify_dependencies

:do_install
echo [1] Installing dependencies...
if not exist .dev-cache mkdir .dev-cache
if exist ".dev-cache\bun-install.stamp" del /q ".dev-cache\bun-install.stamp"
call bun install --frozen-lockfile --backend=copyfile
if errorlevel 1 (echo [X] bun install failed & pause & exit /b 1)

:verify_dependencies
call :check_dependencies
if not errorlevel 1 goto dependencies_ready
if "%DEPENDENCIES_REPAIRED%"=="0" goto repair_install
echo [X] Dependency checks still fail after repair - see the error above.
pause
exit /b 1

:dependencies_ready
echo. > ".dev-cache\bun-install.stamp"

:after_install
echo.

echo [2] Checking accounts v2 configuration...
call bun scripts\dev\assert-accounts-v2.ts
if errorlevel 1 (echo [X] Account preflight failed - see the error above. & pause & exit /b 1)

echo [2] Stopping the previous tokenAtlas instance on port %PORT_APP%...
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\free-port.ps1 -Port %PORT_APP% -ProjectRoot "%CD%"
if errorlevel 1 (pause & exit /b 1)
echo.

REM --- Native parser, required (no TS fallback, decision 03.10): built when Rust + MSVC are installed (from
REM PowerShell, so Git's link.exe cannot shadow MSVC), otherwise downloaded from the GitHub release for these
REM sources and checked against the SHA-256 in native\tokenatlas-parse\release.json (Rust R0) ---
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\build-native-parser.ps1
if errorlevel 1 (echo [X] Native parser unavailable - see above. & pause & exit /b 1)
if not exist "native\tokenatlas-parse\target\release\tokenatlas-parse.exe" (echo [X] Native parser missing: sign in with HTTPS Git or the GitHub CLI ^(gh auth login^) so it can be downloaded, or install Rust and the MSVC build tools, then run _dev.bat again. & pause & exit /b 1)

REM --- Database: the location chosen in Settings, shared by every step below ---
set "DB_PATH="
for /f "delims=" %%p in ('bun scripts\dev\active-paths.ts database') do set "DB_PATH=%%p"
if not defined DB_PATH (echo [X] Cannot resolve the active database & pause & exit /b 1)
set "TOKENATLAS_DB=%DB_PATH%"

REM --- Front-end bundle -------------------------------------------------
REM The server serves public/assets/*, NOT src/web - so a source change is
REM invisible until this runs. Skipping it once cost an afternoon of "the new
REM code is not there": the API answered with new data, the page was the old
REM build. It takes ~0.2 s, so it runs every time rather than guessing.
REM public\assets is wiped first because vite hashes filenames and
REM emptyOutDir is off (legacy.html lives in public\), so stale bundles would
REM pile up there forever.
echo [3] Rebuilding the web bundle...
if exist "public\assets" rd /s /q "public\assets"
call bun run build:web
if errorlevel 1 (echo [X] build:web failed - fix the error above, the page would stay on the previous bundle & pause & exit /b 1)
echo [OK] Bundle rebuilt.
echo.

echo [4] Opening the application - database preparation appears there...
start "" /B cmd /c "scripts\dev\wait-and-open.bat %PORT_APP%"
echo.
echo [5] Preparing the database and checking configuration...
call bun scripts\dev\prepare-app.ts
if errorlevel 1 (
  echo [X] Preparation stopped - see the specific error above and the application.
  pause
  exit /b 1
)
echo.
echo [6] Starting tokenAtlas server on http://127.0.0.1:%PORT_APP% ...
echo     ^(Ctrl+C to stop^)
echo.
call bun run serve
pause
goto :eof

REM --- Official Bun installation and stable update ------------------------
REM The official installer puts bun.exe in %BUN_INSTALL%\bin (default %USERPROFILE%\.bun\bin)
REM and adds it to the user PATH, which this window only sees after it is reopened - so the
REM folder is added to this window's PATH directly. PATH stays outside ( ) blocks because
REM "Program Files (x86)" in it would end such a block early.
:install_bun
set "BUN_BIN=%USERPROFILE%\.bun\bin"
if defined BUN_INSTALL set "BUN_BIN=%BUN_INSTALL%\bin"
if exist "%BUN_BIN%\bun.exe" goto bun_path
echo [0a] Bun not found - installing it from https://bun.sh ...
:bun_path
call powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\dev\update-bun.ps1" -BunBin "%BUN_BIN%"
if errorlevel 1 exit /b 1
if not exist "%BUN_BIN%\bun.exe" (
  echo [X] Bun installation failed - retry _dev.bat.
  exit /b 1
)
set "PATH=%BUN_BIN%;%PATH%"
exit /b 0

REM No application imports here: this must work before configuration and database preparation.
:check_dependencies
call bun -e "import 'drizzle-orm/bun-sqlite'; import 'react'; import 'react-dom/client'; import 'vite'; import '@vitejs/plugin-react'; import '@tailwindcss/vite';"
if errorlevel 1 exit /b 1
REM Imports do not exercise Bun's Windows bin metadata used by build:web.
call bun run vite --version
exit /b %errorlevel%

