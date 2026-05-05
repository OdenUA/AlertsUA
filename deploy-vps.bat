@echo off
setlocal enabledelayedexpansion

REM Use Git Bash ssh instead of Windows OpenSSH
set "PATH=C:\Program Files\Git\usr\bin;%PATH%"

:menu
cls
echo ========================================
echo   Trivoha UA - VPS Deploy
echo ========================================
echo.
echo Select deployment type:
echo.
echo   [1] Full Deploy
echo       - TypeScript check
echo       - Build project
echo       - Deploy to VPS
echo.
echo   [2] Quick Deploy
echo       - No checks
echo       - No build
echo       - Deploy only
echo.
echo   [3] Deploy with Dependencies
echo       - TypeScript check
echo       - Build project
echo       - Reinstall npm packages on VPS
echo       - Deploy to VPS
echo.
echo   [4] Dry Run (Test)
echo       - TypeScript check
echo       - Build project
echo       - Simulate deployment without changes
echo.
echo   [5] Cancel
echo.
echo ========================================
set /p choice="Select option (1-5): "

if "%choice%"=="1" goto full_deploy
if "%choice%"=="2" goto quick_deploy
if "%choice%"=="3" goto reinstall_deploy
if "%choice%"=="4" goto dry_run
if "%choice%"=="5" goto cancel
echo.
echo Invalid choice! Please enter number from 1 to 5.
timeout /t 2 >nul
goto menu

:full_deploy
cls
echo ========================================
echo   Starting Full Deploy...
echo ========================================
echo.
powershell -ExecutionPolicy Bypass -File "%~dp0deploy-vps.ps1"
goto end

:quick_deploy
cls
echo ========================================
echo   Starting Quick Deploy...
echo ========================================
echo.
powershell -ExecutionPolicy Bypass -File "%~dp0deploy-vps.ps1" -SkipLint -SkipBuild
goto end

:reinstall_deploy
cls
echo ========================================
echo   Starting Deploy with Dependencies...
echo ========================================
echo.
powershell -ExecutionPolicy Bypass -File "%~dp0deploy-vps.ps1" -ForceInstallDependencies
goto end

:dry_run
cls
echo ========================================
echo   Dry Run (Test Mode)
echo ========================================
echo.
echo This is a simulation. No changes will be made on VPS.
echo.
pause
powershell -ExecutionPolicy Bypass -File "%~dp0deploy-vps.ps1" -DryRun
goto end

:cancel
cls
echo ========================================
echo   Deployment Cancelled
echo ========================================
echo.
timeout /t 2 >nul
exit /b 0

:end
echo.
echo ========================================
if %ERRORLEVEL% EQU 0 (
    echo   [OK] Deployment completed successfully!
) else (
    echo   [ERROR] Deployment failed!
    echo   Error code: %ERRORLEVEL%
)
echo ========================================
echo.
pause
