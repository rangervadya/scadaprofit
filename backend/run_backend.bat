@echo off
cd /d "%~dp0"
set VDGO_HOST=127.0.0.1
set VDGO_PORT=8765
set VDGO_NO_BROWSER=1
.venv\Scripts\python.exe app.py
