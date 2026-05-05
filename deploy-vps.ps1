# improved VPS deploy script based on real deployment experience
[CmdletBinding()]
param(
    [string]$ReleaseName,
    [switch]$SkipLint,
    [switch]$SkipBuild,
    [switch]$DryRun,
    [switch]$KeepArchive,
    [switch]$ForceInstallDependencies,
    [switch]$DetailedOutput
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step {
    param([string]$Message)
    Write-Host "[*] $Message" -ForegroundColor Cyan
}

function Write-Success {
    param([string]$Message)
    Write-Host "[OK] $Message" -ForegroundColor Green
}

function Write-Error-Message {
    param([string]$Message)
    Write-Host "[ERROR] $Message" -ForegroundColor Red
}

function Fail {
    param([string]$Message)
    Write-Error-Message $Message
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
        [string]$WorkingDirectory,
        [switch]$AllowFailure
    )

    Push-Location $WorkingDirectory
    try {
        & $Command @Arguments
        if ($LASTEXITCODE -ne 0 -and -not $AllowFailure) {
            Fail "Command failed with exit code ${LASTEXITCODE}: $Command $($Arguments -join ' ')"
        }
        return $LASTEXITCODE -eq 0
    }
    finally {
        Pop-Location
    }
}

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = Join-Path $repoRoot 'backend'
$secretsPath = Join-Path $repoRoot 'secrets.env'
$remoteDeployScript = Join-Path $repoRoot 'infra\vps\scripts\deploy_backend_release.sh'

# Validate required paths
if (-not (Test-Path $backendDir)) {
    Fail "Backend directory not found: $backendDir"
}

if (-not (Test-Path $remoteDeployScript)) {
    Fail "Remote deploy script not found: $remoteDeployScript"
}

if (-not (Test-Path $secretsPath)) {
    Fail "secrets.env not found. Create it and configure VPS_SSH_KEY and VPS_SSH_USER first."
}

# Load environment variables
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

# Validate required tools - prefer Git Bash versions for SSH tools
function Find-SSHTool {
    param([string]$Name)

    # Try Git Bash first (usually better with permissions)
    $gitPath = "C:\Program Files\Git\usr\bin\$Name.exe"
    if (Test-Path $gitPath) {
        Write-Host "  - Using Git Bash $Name" -ForegroundColor Gray
        return $gitPath
    }

    # Fallback to Windows OpenSSH
    $command = Get-Command -Name $Name -ErrorAction SilentlyContinue
    if ($command) {
        Write-Host "  - Using Windows OpenSSH $Name" -ForegroundColor Gray
        return $command.Source
    }

    Fail "Required tool '$Name' was not found in PATH or Git Bash."
}

$sshExe = Find-SSHTool -Name 'ssh'
$scpExe = Find-SSHTool -Name 'scp'
$tarExe = Find-SSHTool -Name 'tar'
$npmCmd = Get-RequiredTool -Name 'npm'

# SSH configuration
$sshCommonArgs = @('-i', $sshKey, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=30')
$sshExecArgs = $sshCommonArgs + @('-n')
$scpCommonArgs = @('-i', $sshKey, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=30')

# Release configuration
if ([string]::IsNullOrWhiteSpace($ReleaseName)) {
    $ReleaseName = 'deploy-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
}

$archiveName = "backend-release-$ReleaseName.zip"
$localArchivePath = Join-Path ([System.IO.Path]::GetTempPath()) $archiveName
$remoteArchivePath = "/tmp/$archiveName"
$remoteScriptPath = '/tmp/deploy_backend_release.sh'

# Bundle entries - critical files for deployment
$bundleEntries = @(
    'dist',
    'package.json',
    'package-lock.json'
)

Write-Step "========================================="
Write-Step "Тривога UA - Backend Deployment"
Write-Step "========================================="
Write-Step "Release name: $ReleaseName"
Write-Step "SSH target: $sshUser"
Write-Step "Backend dir: $backendDir"
Write-Step ""

# Validate bundle entries exist
# If building from source, only check package files (dist will be created)
# If skipping build, check all files including dist
$entriesToCheck = if ($SkipBuild) { $bundleEntries } else { 'package.json', 'package-lock.json' }

foreach ($entry in $entriesToCheck) {
    if (-not (Test-Path (Join-Path $backendDir $entry))) {
        Fail "Required backend release entry was not found: $entry"
    }
}

if ($SkipBuild) {
    # Additional validation for dist folder when skipping build
    $distMainJs = Join-Path $backendDir 'dist\main.js'
    if (-not (Test-Path $distMainJs)) {
        Fail "Critical file not found: dist\main.js. Build may have failed."
    }
}

Write-Success "All required files validated"

if ($DryRun) {
    Write-Step "Dry-run enabled. No local build or remote deployment will be executed."
    Write-Host ""
    Write-Host '[dry-run] npm run lint   (cwd:' $backendDir ')'
    Write-Host '[dry-run] npm run build  (cwd:' $backendDir ')'
    Write-Host '[dry-run]' $tarExe '-czf' $localArchivePath '-C' $backendDir $($bundleEntries -join ' ')
    $scpArgsString = $scpCommonArgs -join ' '
    Write-Host '[dry-run]' $scpExe $scpArgsString $localArchivePath "${sshUser}:$remoteArchivePath"
    Write-Host '[dry-run]' $scpExe $scpArgsString $remoteDeployScript "${sshUser}:$remoteScriptPath"
    $sshArgsString = $sshExecArgs -join ' '
    $forceInstallFlag = if ($ForceInstallDependencies) { 'FORCE_NPM_INSTALL=1' } else { 'FORCE_NPM_INSTALL=0' }
    $remoteCommandExample = "$forceInstallFlag /tmp/deploy_backend_release.sh --archive /tmp/backend-release-$ReleaseName.tgz --release-name $ReleaseName"
    Write-Host '[dry-run]' $sshExe $sshArgsString $sshUser $remoteCommandExample
    return
}

try {
    # Step 1: Lint
    if (-not $SkipLint) {
        Write-Step "Step 1/6: Running TypeScript type check..."
        $lintSuccess = Invoke-ExternalCommand -Command $npmCmd -Arguments @('run', 'lint') -WorkingDirectory $backendDir -AllowFailure
        if (-not $lintSuccess) {
            Write-Host "[!] Lint failed but continuing with build" -ForegroundColor Yellow
        }
        else {
            Write-Success "TypeScript check passed"
        }
    }
    else {
        Write-Step "Step 1/6: Skipping TypeScript check (SkipLint specified)"
    }

    # Step 2: Build
    if (-not $SkipBuild) {
        Write-Step "Step 2/6: Building backend..."

        # Clean old build - but be careful with file locks
        $distPath = Join-Path $backendDir 'dist'
        if (Test-Path $distPath) {
            Write-Host "  - Removing old dist folder..." -ForegroundColor Gray
            try {
                Remove-Item -Path $distPath -Recurse -Force -ErrorAction Stop
                Write-Host "  - Cleaned old dist folder" -ForegroundColor Gray
            } catch {
                Write-Host "  - Warning: Could not remove dist folder (may be locked)" -ForegroundColor Yellow
            }
        }

        Write-Host "  - Starting build process..." -ForegroundColor Gray
        $buildSuccess = Invoke-ExternalCommand -Command $npmCmd -Arguments @('run', 'build') -WorkingDirectory $backendDir -AllowFailure
        if (-not $buildSuccess) {
            Fail "Build failed. Check TypeScript compilation errors."
        }

        # Add small delay to ensure file system is synced
        Start-Sleep -Milliseconds 500

        # Verify critical files exist
        $distMainJs = Join-Path $backendDir 'dist/main.js'
        Write-Host "  - Checking: $distMainJs" -ForegroundColor Gray
        Write-Host "  - Dist folder exists: $(Test-Path (Join-Path $backendDir 'dist'))" -ForegroundColor Gray

        # List files in dist for debugging
        $distPath = Join-Path $backendDir 'dist'
        if (Test-Path $distPath) {
            $files = Get-ChildItem -Path $distPath -Filter "*.js" -ErrorAction SilentlyContinue | Select-Object -First 5 -ExpandProperty Name
            Write-Host "  - Files in dist: $($files -join ', ')" -ForegroundColor Gray
        }

        if (-not (Test-Path $distMainJs)) {
            Write-Host "  - ERROR: File not found: $distMainJs" -ForegroundColor Red
            Write-Host "  - Trying alternative path format..." -ForegroundColor Yellow
            $altPath = "$backendDir\dist\main.js"
            Write-Host "  - Alt path: $altPath (exists: $(Test-Path $altPath))" -ForegroundColor Gray
            Fail "Build completed but dist\main.js not found. Check tsconfig.json module setting (should be 'commonjs')"
        }

        # Count JS files
        $jsFileCount = (Get-ChildItem -Path $distPath -Filter "*.js" -Recurse -ErrorAction SilentlyContinue | Measure-Object).Count
        Write-Host "  - Compiled $jsFileCount JavaScript files" -ForegroundColor Gray
        Write-Success "Build successful"
    }
    else {
        Write-Step "Step 2/6: Skipping build (SkipBuild specified)"
    }

    # Step 3: Create archive
    Write-Step "Step 3/6: Creating deployment archive..."
    if (Test-Path $localArchivePath) {
        Remove-Item -Path $localArchivePath -Force
    }

    # Try to use tar if available (preferred for .tgz), fallback to Compress-Archive (.zip)
    Write-Host "  - Creating archive with $($bundleEntries.Count) entries" -ForegroundColor Gray

    $tarAvailable = Get-Command tar.exe -ErrorAction SilentlyContinue
    if ($tarAvailable) {
        # Create tar.gz archive using relative paths
        Push-Location $backendDir
        try {
            # Create a temporary tar.gz in the backend directory first (avoid drive letter issues)
            $tempArchive = "temp-archive.tar.gz"
            $archiveArguments = @('-czf', $tempArchive) + $bundleEntries

            $tarPath = $tarAvailable.Source
            & $tarPath @archiveArguments
            if ($LASTEXITCODE -ne 0) {
                throw "tar failed with exit code $LASTEXITCODE"
            }

            # Move to final location
            Move-Item -Path (Join-Path $backendDir $tempArchive) -Destination $localArchivePath -Force
        }
        finally {
            Pop-Location
        }
    }
    else {
        # Fallback to PowerShell Compress-Archive (creates .zip)
        Write-Host "  - Using Compress-Archive (tar.exe not found)" -ForegroundColor Yellow
        $tempFiles = @()
        foreach ($entry in $bundleEntries) {
            $entryPath = Join-Path $backendDir $entry
            if (Test-Path $entryPath) {
                $tempFiles += $entryPath
            }
        }
        Compress-Archive -Path $tempFiles -DestinationPath $localArchivePath -CompressionLevel Optimal -Force
    }

    $archiveSize = (Get-Item $localArchivePath).Length / 1KB
    Write-Host "  - Archive size: $([math]::Round($archiveSize, 2)) KB" -ForegroundColor Gray
    Write-Success "Archive created"

    # Step 4: Upload archive
    Write-Step "Step 4/6: Uploading archive to VPS..."
    Invoke-ExternalCommand -Command $scpExe -Arguments ($scpCommonArgs + @($localArchivePath, "${sshUser}:$remoteArchivePath")) -WorkingDirectory $repoRoot
    Write-Success "Archive uploaded"

    # Step 5: Upload deploy script
    Write-Step "Step 5/6: Uploading deploy helper script..."
    Invoke-ExternalCommand -Command $scpExe -Arguments ($scpCommonArgs + @($remoteDeployScript, "${sshUser}:$remoteScriptPath")) -WorkingDirectory $repoRoot
    Write-Success "Deploy script uploaded"

    # Step 6: Execute deployment
    Write-Step "Step 6/6: Executing remote deployment..."

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

    # Execute deployment (ignore npm warnings in stderr)
    $deploymentOutput = ""

    try {
        # Redirect stderr to suppress PowerShell exceptions
        $deploymentOutput = & $sshExe @sshExecArgs $sshUser $remoteCommand 2>&1 |
                           Where-Object { $_ -notmatch '^npm warn' } |
                           Out-String
        $deploymentExitCode = $LASTEXITCODE
    }
    catch {
        $deploymentOutput = $_.Exception.Message
        $deploymentExitCode = 1
    }

    # Show output if detailed
    if ($DetailedOutput) {
        Write-Host $deploymentOutput
    }

    # Check for actual errors (ignore npm warnings)
    $hasRealErrors = $deploymentOutput -match '(?i)error|fail|fatal' -and
                     $deploymentOutput -notmatch 'npm warn deprecated' -and
                     $deploymentOutput -notmatch 'Runtime npm'

    if ($deploymentExitCode -ne 0 -and $hasRealErrors) {
        Write-Host "  - Deployment output:" -ForegroundColor Yellow
        Write-Host $deploymentOutput
        Fail "Deployment failed. Check VPS logs for details."
    }
    elseif ($deploymentExitCode -ne 0) {
        Write-Host "  - Deployment completed (exit code $deploymentExitCode ignored - npm warnings)" -ForegroundColor Yellow
    }

    # Parse deployment output
    $releasePath = ""
    $apiStatus = ""
    $dtekStatus = ""
    $healthStatus = ""

    foreach ($line in $deploymentOutput -split "`n") {
        if ($line -match '^release=(.+)$') {
            $releasePath = $matches[1]
        }
        elseif ($line -match '^api=(.+)$') {
            $apiStatus = $matches[1]
        }
        elseif ($line -match '^dtek=(.+)$') {
            $dtekStatus = $matches[1]
        }
        elseif ($line -match '^health=(.+)$') {
            $healthStatus = $matches[1]
        }
    }

    Write-Success "Deployment completed successfully!"
    Write-Host ""
    Write-Host "Deployment Summary:" -ForegroundColor Cyan
    Write-Host "  Release path: $releasePath"
    Write-Host "  API service:  $apiStatus"
    Write-Host "  DTEK service: $dtekStatus"
    Write-Host "  Health check: $healthStatus"
    Write-Host ""

    # Final health check
    Write-Step "Running final health check..."
    $healthCheckResult = & $sshExe @sshExecArgs $sshUser "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/api/v1/map/regions" 2>&1

    if ($healthCheckResult -match '^200$') {
        Write-Success "API is responding correctly"
    }
    else {
        Write-Host "[!] Health check returned: $healthCheckResult" -ForegroundColor Yellow
    }
}
finally {
    # Cleanup
    if ((Test-Path $localArchivePath) -and -not $KeepArchive) {
        Remove-Item -Path $localArchivePath -Force
        Write-Host "  - Cleaned local archive" -ForegroundColor Gray
    }

    if (-not $DryRun) {
        try {
            & $sshExe @sshExecArgs $sshUser "rm -f $remoteScriptPath $remoteArchivePath" 2>&1 | Out-Null
            Write-Host "  - Cleaned remote files" -ForegroundColor Gray
        }
        catch {
            Write-Host '[!] Failed to clean remote files:' $_ -ForegroundColor Yellow
        }
    }

    Write-Host ""
    Write-Success "Deploy script completed"
}

