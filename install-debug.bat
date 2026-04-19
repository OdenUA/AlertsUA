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
set "APK=%~dp0android-app\app\build\outputs\apk\debug\app-debug.apk"
set "PACKAGE=com.alertsua.app"
set "EMULATOR=emulator-5554"

if not exist "%APK%" (
    echo [!] APK not found: %APK%
    echo     Run build-debug.bat first.
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

echo [*] Installing APK on %EMULATOR%...
"%ADB%" -s %EMULATOR% shell pm clear com.alertsua.app
"%ADB%" -s %EMULATOR% shell pm clear com.scmv.android.debug
"%ADB%" -s %EMULATOR% install -r "%APK%"
if %ERRORLEVEL% neq 0 (
    echo [!] Installation failed.
    pause
    exit /b %ERRORLEVEL%
)

echo [*] Restarting app...
"%ADB%" -s %EMULATOR% shell am force-stop %PACKAGE%
"%ADB%" -s %EMULATOR% shell am start -W -n %PACKAGE%/.MainActivity

echo.
echo [+] App launched on %EMULATOR%.
endlocal
