@echo off
rem ============================================
rem  Stop huijin-tracker dashboard (port 8300)
rem  Double-click to close the local server.
rem ============================================
setlocal
echo Stopping dashboard server on port 8300 ...
set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8300" ^| findstr "LISTENING"') do (
  set FOUND=1
  taskkill /PID %%a /F >nul 2>&1
  echo   killed PID %%a
)
if "%FOUND%"=="0" echo   Server is not running (port 8300 is free).
echo Done. You can close this window.
pause
