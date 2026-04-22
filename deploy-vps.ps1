[CmdletBinding()]
param(
    [string]$ReleaseName,
    [switch]$SkipLint,
    [switch]$SkipBuild,
    [switch]$DryRun,
    [switch]$KeepArchive,
    [switch]$ForceInstallDependencies
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step {
    param([string]$Message)
    Write-Host "[*] $Message"
}

function Fail {
    param([string]$Message)
    throw $Message
}

function Import-EnvFile {
    param([string]$Path)

    $result = @{}
    foreach ($line in Get-Content -Path $Path) {
        if ($line -match '^\s*#' -or $line -match '^\s*$') {
            continue
        }

        if ($line -match '^\s*([^=\s]+)\s*=(.*)$') {
            $name = $matches[1]
            $value = $matches[2].Trim()
            if (
                ($value.StartsWith('"') -and $value.EndsWith('"')) -or
                ($value.StartsWith("'") -and $value.EndsWith("'"))
            ) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            $result[$name] = $value
        }
    }

    return $result
}

function Get-RequiredTool {
    param([string]$Name)

    $command = Get-Command -Name $Name -ErrorAction SilentlyContinue
    if (-not $command) {
        Fail "Required tool '$Name' was not found in PATH."
    }

    return $command.Source
}

function Invoke-ExternalCommand {
    param(
        [string]$Command,
        [string[]]$Arguments,
        [string]$WorkingDirectory
    )

    Push-Location $WorkingDirectory
    try {
        & $Command @Arguments
        if ($LASTEXITCODE -ne 0) {
            Fail "Command failed with exit code ${LASTEXITCODE}: $Command $($Arguments -join ' ')"
        }
    }
    finally {
        Pop-Location
    }
}

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = Join-Path $repoRoot 'backend'
$secretsPath = Join-Path $repoRoot 'secrets.env'
$remoteDeployScript = Join-Path $repoRoot 'infra\vps\scripts\deploy_backend_release.sh'

if (-not (Test-Path $backendDir)) {
    Fail "Backend directory not found: $backendDir"
}

if (-not (Test-Path $remoteDeployScript)) {
    Fail "Remote deploy script not found: $remoteDeployScript"
}

if (-not (Test-Path $secretsPath)) {
    Fail "secrets.env not found. Create it and configure VPS_SSH_KEY and VPS_SSH_USER first."
}

$envFile = Import-EnvFile -Path $secretsPath
$sshKey = if ($env:VPS_SSH_KEY) { $env:VPS_SSH_KEY } elseif ($envFile.ContainsKey('VPS_SSH_KEY')) { $envFile['VPS_SSH_KEY'] } else { '' }
$sshUser = if ($env:VPS_SSH_USER) { $env:VPS_SSH_USER } elseif ($envFile.ContainsKey('VPS_SSH_USER')) { $envFile['VPS_SSH_USER'] } else { '' }

if ([string]::IsNullOrWhiteSpace($sshKey)) {
    Fail 'VPS_SSH_KEY is not configured in secrets.env or the environment.'
}

if ([string]::IsNullOrWhiteSpace($sshUser)) {
    Fail 'VPS_SSH_USER is not configured in secrets.env or the environment.'
}

if (-not (Test-Path $sshKey)) {
    Fail "SSH key file was not found: $sshKey"
}

$sshExe = Get-RequiredTool -Name 'ssh'
$scpExe = Get-RequiredTool -Name 'scp'
$tarExe = Get-RequiredTool -Name 'tar.exe'
$npmCmd = Get-RequiredTool -Name 'npm'

$sshCommonArgs = @('-i', $sshKey, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new')
$sshExecArgs = $sshCommonArgs + @('-n')
$scpCommonArgs = @('-i', $sshKey, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new')

if ([string]::IsNullOrWhiteSpace($ReleaseName)) {
    $ReleaseName = 'deploy-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
}

$archiveName = "backend-release-$ReleaseName.tgz"
$localArchivePath = Join-Path ([System.IO.Path]::GetTempPath()) $archiveName
$remoteArchivePath = "/tmp/$archiveName"
$remoteScriptPath = '/tmp/deploy_backend_release.sh'

$bundleEntries = @(
    'dist',
    'package.json',
    'package-lock.json',
    'nest-cli.json',
    'tsconfig.json',
    'tsconfig.build.json',
    'scripts',
    'sql'
)

$archiveArguments = @('-czf', $localArchivePath, '-C', $backendDir) + $bundleEntries

foreach ($entry in $bundleEntries) {
    if (-not (Test-Path (Join-Path $backendDir $entry))) {
        Fail "Required backend release entry was not found: $entry"
    }
}

$forceInstallFlag = if ($ForceInstallDependencies) { 'FORCE_NPM_INSTALL=1' } else { 'FORCE_NPM_INSTALL=0' }

$remoteCommand = @(
    'chmod',
    '755',
    $remoteScriptPath,
    '&&',
    $forceInstallFlag,
    $remoteScriptPath,
    '--archive',
    $remoteArchivePath,
    '--release-name',
    $ReleaseName
) -join ' '

Write-Step "Release name: $ReleaseName"
Write-Step "SSH target: $sshUser"

if ($DryRun) {
    Write-Step 'Dry-run enabled. No local build or remote deployment will be executed.'
    Write-Host "[dry-run] npm run lint   (cwd: $backendDir)"
    Write-Host "[dry-run] npm run build  (cwd: $backendDir)"
    Write-Host "[dry-run] $tarExe -czf $localArchivePath -C $backendDir $($bundleEntries -join ' ')"
    Write-Host "[dry-run] $scpExe $($scpCommonArgs -join ' ') $localArchivePath ${sshUser}:$remoteArchivePath"
    Write-Host "[dry-run] $scpExe $($scpCommonArgs -join ' ') $remoteDeployScript ${sshUser}:$remoteScriptPath"
    Write-Host "[dry-run] $sshExe $($sshExecArgs -join ' ') $sshUser '$remoteCommand'"
    return
}

try {
    if (-not $SkipLint) {
        Write-Step 'Running backend TypeScript check...'
        Invoke-ExternalCommand -Command $npmCmd -Arguments @('run', 'lint') -WorkingDirectory $backendDir
    }

    if (-not $SkipBuild) {
        Write-Step 'Building backend dist...'
        Invoke-ExternalCommand -Command $npmCmd -Arguments @('run', 'build') -WorkingDirectory $backendDir
    }

    if (Test-Path $localArchivePath) {
        Remove-Item -Path $localArchivePath -Force
    }

    Write-Step 'Creating backend release archive...'
    Invoke-ExternalCommand -Command $tarExe -Arguments $archiveArguments -WorkingDirectory $repoRoot

    Write-Step 'Uploading archive to VPS...'
    Invoke-ExternalCommand -Command $scpExe -Arguments ($scpCommonArgs + @($localArchivePath, "${sshUser}:$remoteArchivePath")) -WorkingDirectory $repoRoot

    Write-Step 'Uploading remote deploy helper...'
    Invoke-ExternalCommand -Command $scpExe -Arguments ($scpCommonArgs + @($remoteDeployScript, "${sshUser}:$remoteScriptPath")) -WorkingDirectory $repoRoot

    Write-Step 'Running deployment on VPS...'
    Invoke-ExternalCommand -Command $sshExe -Arguments ($sshExecArgs + @($sshUser, $remoteCommand)) -WorkingDirectory $repoRoot
}
finally {
    if ((Test-Path $localArchivePath) -and -not $KeepArchive) {
        Remove-Item -Path $localArchivePath -Force
    }

    if (-not $DryRun) {
        try {
            & $sshExe @sshExecArgs $sshUser "rm -f $remoteScriptPath $remoteArchivePath"
        }
        catch {
        }
    }
}

Write-Step 'Deployment completed successfully.'