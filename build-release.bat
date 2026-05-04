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

rem Set up Java environment
set "JAVA_HOME=C:\Program Files\Java\jdk-21"
set "ANDROID_SDK_ROOT=E:\Dev\Android\SDK"
set "GRADLE=%~dp0.tools\gradle-8.7\bin\gradle.bat"

cd /d "%~dp0android-app"

echo [*] Building release AAB...
call "%GRADLE%" bundleRelease

if %ERRORLEVEL% neq 0 (
    echo [!] Build failed.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo [+] Done: android-app\app\build\outputs\bundle\release\app-release.aab
endlocal
