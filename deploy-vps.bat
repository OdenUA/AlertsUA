@echo off
setlocal

powershell -ExecutionPolicy Bypass -File "%~dp0deploy-vps.ps1" %*
exit /b %ERRORLEVEL%