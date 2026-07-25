@echo off
rem ============================================
rem  Start huijin-tracker dashboard (port 8300)
rem  Double-click to launch, browser opens automatically.
rem  Close: run stop_server.bat, or press Ctrl+C here.
rem ============================================
cd /d "%~dp0"
set PY=C:\Users\weiqi\.workbuddy\binaries\python\versions\3.13.12\python.exe
if not exist "%PY%" set PY=python
echo Starting dashboard server at http://127.0.0.1:8300 ...
"%PY%" serve.py
pause
