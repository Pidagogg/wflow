@echo off
title W FLOW - Workflow Builder
cd /d "%~dp0"

echo.
echo   ============================================
echo    W FLOW - self-hosted workflow builder
echo   ============================================
echo.

REM --- 1. Check Node.js is installed ---
where node >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] Node.js is not installed.
  echo   Install it from https://nodejs.org  then run this file again.
  echo.
  pause
  exit /b 1
)

REM --- 2. Already running? Then just open the browser ---
netstat -ano 2>nul | findstr /c:":3001 " | findstr /c:"LISTENING" >nul
if not errorlevel 1 (
  echo   The app is already running. Opening browser...
  start "" http://localhost:3001
  exit /b 0
)

REM --- 3. First-time setup (downloads + build) ---
if not exist node_modules (
  echo   First run: installing dependencies...
  call npm install
  if errorlevel 1 (
    echo   [ERROR] npm install failed.
    pause
    exit /b 1
  )
)
if not exist dist (
  echo   First run: building the website...
  call npm run build
  if errorlevel 1 (
    echo   [ERROR] build failed.
    pause
    exit /b 1
  )
)

REM --- 4. Start the server in its own window ---
echo   Starting the server...
start "W FLOW - server (keep this window open)" cmd /k "npm start"

REM --- 5. Wait until the server answers, then open the browser ---
set /a tries=0
:waitloop
ping -n 2 127.0.0.1 >nul
curl -s -o nul http://localhost:3001/api/nodes
if not errorlevel 1 goto ready
set /a tries+=1
if %tries% lss 25 goto waitloop

echo   [WARN] The server did not answer in time - opening the browser anyway.
goto open

:ready
echo   Server is up!
:open
start "" http://localhost:3001
echo.
echo   Your browser should now show the workflow builder.
echo   Tip: close the "W FLOW - server" window to stop the app.
ping -n 6 127.0.0.1 >nul
exit /b 0
