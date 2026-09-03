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

set "EMULATOR_EXE=E:\Dev\Android\SDK\emulator\emulator.exe"
set "ADB=E:\Dev\Android\SDK\platform-tools\adb.exe"

rem Change AVD_NAME to Medium_Phone_API_36.1 if you prefer a different device.
set "AVD_NAME=Pixel_6"

echo [*] Starting emulator: %AVD_NAME% (cold boot)
rem Размер userdata-раздела берется из AVD config.ini (disk.dataPartition.size)
rem -no-snapshot-load: всегда холодная загрузка, сохранённый снапшот не используется
start "" "%EMULATOR_EXE%" -avd %AVD_NAME% -no-snapshot-load

echo [*] Waiting for emulator to boot...
:wait_loop
    timeout /t 3 /nobreak >nul
    "%ADB%" -s emulator-5554 shell getprop sys.boot_completed 2>nul | findstr /x "1" >nul
    if %ERRORLEVEL% neq 0 goto wait_loop

echo.
echo [+] Emulator is ready.
endlocal
