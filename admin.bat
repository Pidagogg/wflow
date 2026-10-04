@echo off
title W FLOW - ADMIN
cd /d "%~dp0"

echo.
echo   ============================================
echo    W FLOW - ADMIN PANEL
echo    Restricted area - login required
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
netstat -ano 2>nul | findstr /c:":3002 " | findstr /c:"LISTENING" >nul
if not errorlevel 1 (
  echo   The admin panel is already running. Opening browser...
  start "" http://localhost:3002
  exit /b 0
)

REM --- 3. Install dependencies if this is a first run ---
if not exist node_modules (
  echo   First run: installing dependencies...
  call npm install
  if errorlevel 1 (
    echo   [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

REM --- 4. Start the admin server in its own window ---
echo   Starting the admin server...
start "W FLOW - ADMIN server (keep this window open)" cmd /k "node server/admin.js"

REM --- 5. Wait until the server answers, then open the browser ---
set /a tries=0
:waitloop
ping -n 2 127.0.0.1 >nul
curl -s -o nul http://localhost:3002/
if not errorlevel 1 goto ready
set /a tries+=1
if %tries% lss 25 goto waitloop

echo   [WARN] The admin server did not answer in time - opening the browser anyway.
goto open

:ready
echo   Admin server is up!
:open
start "" http://localhost:3002
echo.
echo   Log in with your admin credentials to reach the panel.
echo   Tip: close the "W FLOW - ADMIN server" window to stop it.
ping -n 6 127.0.0.1 >nul
exit /b 0