@echo off
:: Existing installations show preparation progress; a first run waits for its setup API.
:: /api/health builds a database diagnostic report and must never gate the browser.
:: Usage: start "" /B cmd /c "scripts\dev\wait-and-open.bat <port> [setup]"
::
:: 127.0.0.1 on purpose: the server binds 127.0.0.1, so "localhost" can resolve to ::1
:: and never connect. Bounded at 90 tries (~3 min) so a failed start does not spin forever.

set "PORT=%~1"
if "%PORT%"=="" exit /b 1
set "READY_PATH=/"
if "%~2"=="setup" set "READY_PATH=/api/setup?summary=1"

set /a TRY=0
:loop
curl -s -o nul -f --max-time 2 "http://127.0.0.1:%PORT%%READY_PATH%"
if not errorlevel 1 goto open
set /a TRY+=1
if %TRY% geq 90 exit /b 1
timeout /t 2 /nobreak >nul
goto loop

:open
start "" "http://127.0.0.1:%PORT%/"
exit /b 0
