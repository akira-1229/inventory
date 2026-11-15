@echo off
rem Removes the launcher added by install-tuesday-startup.bat
set "LAUNCHER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\inventory-tuesday.cmd"
if exist "%LAUNCHER%" (
  del "%LAUNCHER%"
  echo Removed: %LAUNCHER%
) else (
  echo Not installed.
)
pause
