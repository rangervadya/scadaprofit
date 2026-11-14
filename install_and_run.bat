@echo off
setlocal
cd /d "%~dp0"
where docker >nul 2>nul
if not errorlevel 1 (
  docker compose version >nul 2>nul
  if not errorlevel 1 (
    docker info >nul 2>nul
    if not errorlevel 1 (
      echo Starting Docker Compose at http://localhost:8080
      docker compose up --build
      goto :end
    ) else (
      echo Docker Desktop is installed but the engine is not running. Falling back to native launch.
    )
  )
)
where python >nul 2>nul || (echo Python 3.12+ was not found. Install Python or Docker Desktop.& pause & exit /b 1)
where node >nul 2>nul || (echo Node.js 24+ was not found. Install Node.js or Docker Desktop.& pause & exit /b 1)
if not exist backend\.venv\Scripts\python.exe python -m venv backend\.venv
backend\.venv\Scripts\python.exe -m pip install --disable-pip-version-check -r backend\requirements.txt
start "ВДГО Backend" /min "%~dp0backend\run_backend.bat"
cd frontend
if not exist node_modules npm install --no-audit --no-fund
start "ВДГО Frontend" cmd /k "npm run dev -- --host 127.0.0.1 --open"
echo Frontend: http://127.0.0.1:5173/
:end
pause
