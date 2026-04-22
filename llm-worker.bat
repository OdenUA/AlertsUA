@echo off
setlocal

set ACTION=%1

if "%ACTION%"=="" (
    echo Usage: %0 [start^|stop]
    exit /b 1
)

if not exist "%~dp0secrets.env" (
    echo [!] secrets.env not found. Copy secrets.env.example to secrets.env and fill in values.
    exit /b 1
)
setlocal enabledelayedexpansion
for /f "usebackq tokens=1* delims==" %%A in ("%~dp0secrets.env") do (
    set "_ln=%%A"
    if not "!_ln:~0,1!"=="#" if not "!_ln!"=="" set "%%A=%%B"
)

if "%VPS_SSH_KEY%"=="" (
    echo [!] VPS_SSH_KEY is not set in secrets.env
    exit /b 1
)
if "%VPS_SSH_USER%"=="" (
    echo [!] VPS_SSH_USER is not set in secrets.env
    exit /b 1
)
if "%VPS_DB_URL%"=="" (
    echo [!] VPS_DB_URL is not set in secrets.env
    exit /b 1
)

set SSH_KEY="%VPS_SSH_KEY%"
set SSH_USER=%VPS_SSH_USER%
set "DB_URL=%VPS_DB_URL%"

if /I "%ACTION%"=="stop" goto stop
if /I "%ACTION%"=="start" goto start

echo Unknown action: %ACTION%. Use 'start' or 'stop'.
exit /b 1

:stop
echo Stopping LLM worker...
ssh -i %SSH_KEY% %SSH_USER% "systemctl stop alerts-ua-telegram-parse.timer alerts-ua-telegram-parse.service"
echo LLM worker stopped.
exit /b 0

:start
echo Cleaning up old/stale pending messages ^(older than 10 minutes^)...
ssh -i %SSH_KEY% %SSH_USER% "psql '%DB_URL%' -c \"UPDATE llm_parse_jobs SET status = 'failed', last_error = 'Skipped: LLM worker was stopped', updated_at = NOW() WHERE status IN ('pending', 'processing') AND created_at < NOW() - INTERVAL '10 minutes';\""
echo Starting LLM worker...
ssh -i %SSH_KEY% %SSH_USER% "systemctl start alerts-ua-telegram-parse.timer"
echo LLM worker started.
exit /b 0
