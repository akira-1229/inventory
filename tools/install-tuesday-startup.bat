@echo off
rem ============================================================
rem  Opens the inventory app in Microsoft Edge when Windows starts
rem  (at sign-in), on Tuesdays only.
rem  Adds a small launcher to this user's Startup folder.
rem  No administrator rights needed. Double-click to install.
rem ============================================================
setlocal
set "APP_URL=https://akira-1229.github.io/inventory/"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LAUNCHER=%STARTUP%\inventory-tuesday.cmd"

if not exist "%STARTUP%" (
  echo [ERROR] Startup folder not found: %STARTUP%
  pause
  exit /b 1
)

> "%LAUNCHER%" echo @echo off
>> "%LAUNCHER%" echo rem Opens the inventory app on Tuesdays. Installed by install-tuesday-startup.bat
>> "%LAUNCHER%" echo powershell -NoProfile -WindowStyle Hidden -Command "if ((Get-Date).DayOfWeek -eq 'Tuesday') { Start-Process 'msedge' '%APP_URL%' }"

rem Remove the older 9:00 scheduled task if it was registered
schtasks /Query /TN "InventoryCheck" >nul 2>&1 && schtasks /Delete /F /TN "InventoryCheck" >nul 2>&1

echo OK: On Tuesdays, Edge will open the app when you sign in to Windows.
echo     %APP_URL%
echo     Launcher: %LAUNCHER%
echo To remove it, run uninstall-tuesday-startup.bat
pause
