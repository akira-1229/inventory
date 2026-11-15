@echo off
rem ============================================================
rem  Registers a Windows scheduled task that opens the inventory
rem  app in Microsoft Edge every Tuesday.
rem  Usage: double-click, or run with a start time, e.g.
rem         register-tuesday-task.bat 08:30
rem ============================================================
setlocal
set "APP=%~dp0..\index.html"
for %%I in ("%APP%") do set "APP=%%~fI"
set "START_AT=%~1"
if "%START_AT%"=="" set "START_AT=09:00"
set "TASK_NAME=InventoryCheck"

if not exist "%APP%" (
  echo [ERROR] index.html not found: %APP%
  pause
  exit /b 1
)

schtasks /Create /F /SC WEEKLY /D TUE /ST %START_AT% /TN "%TASK_NAME%" /TR "cmd /c start \"\" msedge \"%APP%\""
if errorlevel 1 (
  echo [ERROR] Failed to register the task.
  pause
  exit /b 1
)
echo.
echo OK: "%TASK_NAME%" will open the app every Tuesday at %START_AT%.
echo     %APP%
echo To remove it, run unregister-tuesday-task.bat
pause
