@echo off
setlocal enabledelayedexpansion

if not exist "%~dp0secrets.env" (
    echo [!] secrets.env not found. Copy secrets.env.example to secrets.env and fill in values.
    pause
    exit /b 1
)
for /f "usebackq tokens=1* delims==" %%A in ("%~dp0secrets.env") do (
    set "_ln=%%A"
    if not "!_ln:~0,1!"=="#" if not "!_ln!"=="" set "%%A=%%B"
)

set "ADB=%ANDROID_HOME%\platform-tools\adb.exe"
set "EMULATOR=emulator-5554"
set "PACKAGE=com.alertsua.app"

if not exist "%ADB%" (
    echo [!] adb not found: %ADB%
    echo     Check ANDROID_HOME in secrets.env.
    pause
    exit /b 1
)

echo [*] Checking emulator connection...
"%ADB%" -s %EMULATOR% get-state >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [!] Emulator %EMULATOR% is not running. Start it with start-emulator.bat first.
    pause
    exit /b 1
)

echo [*] Streaming filtered logcat for %PACKAGE%...
echo     Matches: %PACKAGE%, AndroidRuntime, FATAL EXCEPTION, Process: %PACKAGE%
echo     Press Ctrl+C to stop.
"%ADB%" -s %EMULATOR% logcat -v time | findstr /i /l /c:"%PACKAGE%" /c:"AndroidRuntime" /c:"FATAL EXCEPTION" /c:"Process: %PACKAGE%"

endlocal