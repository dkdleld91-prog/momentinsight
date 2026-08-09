@echo off
setlocal
cd /d "%~dp0"

echo Moment Insight N Shopping Windows worker installer
echo Run this file as the Windows user that owns the Chrome profile.
echo.

"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" ^
  -NoProfile ^
  -ExecutionPolicy Bypass ^
  -File "%~dp0scripts\install-naver-shopping-chrome-bridge-windows.ps1"

set "MI_INSTALL_EXIT=%ERRORLEVEL%"
echo.
if not "%MI_INSTALL_EXIT%"=="0" (
  echo Installation did not finish. Keep this window open and report the error code above.
) else (
  echo Installation files are ready. Complete Load unpacked in the Chrome window that opened.
)
pause
exit /b %MI_INSTALL_EXIT%
