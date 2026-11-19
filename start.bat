@echo off
setlocal
cd /d "%~dp0"
if exist "dist/NetSpace.exe" (
    start "" "%~dp0dist/NetSpace.exe"
    exit /b 0
)
where py >nul 2>nul
if not errorlevel 1 (
    py -3 app.py
    if errorlevel 1 pause
    exit /b
)
where python >nul 2>nul
if not errorlevel 1 (
    python app.py
    if errorlevel 1 pause
    exit /b
)
echo Please run dist/NetSpace.exe or install Python 3.8 or later.
pause
