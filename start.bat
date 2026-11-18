@echo off
title Ticket Tracking For Finance
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies, please wait...
  call npm install --no-audit --no-fund
)
rem Stop an older copy of this app that is still holding port 4500 (only Node.js processes).
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":4500 .*LISTENING"') do (
  tasklist /fi "pid eq %%p" | find /i "node.exe" >nul && (
    echo Stopping previous Ticket Tracking server, PID %%p ...
    taskkill /pid %%p /f >nul
  )
)
echo.
echo Starting Ticket Tracking For Finance...
echo Open http://localhost:4500 in your browser. Close this window to stop the server.
echo.
start "" http://localhost:4500
call npm start
pause
