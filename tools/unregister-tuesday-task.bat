@echo off
rem Removes the scheduled task created by register-tuesday-task.bat
schtasks /Delete /F /TN "InventoryCheck"
pause
