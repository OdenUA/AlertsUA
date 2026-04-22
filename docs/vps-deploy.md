# VPS Deploy

Routine backend deploys to the Alerts VPS are now handled by a single local command:

```powershell
.\deploy-vps.bat
```

The script reads `VPS_SSH_KEY` and `VPS_SSH_USER` from `secrets.env`, builds a backend release bundle locally, uploads it to the VPS, creates a new release under `/srv/alerts-ua/app/releases`, switches `/srv/alerts-ua/app/current`, restarts `alerts-ua-api.service`, verifies `http://127.0.0.1:3100/api/v1/system/health`, and rolls back automatically if the new release does not come up cleanly.

## What Gets Deployed

The release bundle contains only the backend runtime files required on the VPS:

- `dist`
- `package.json`
- `package-lock.json`
- `nest-cli.json`
- `tsconfig.json`
- `tsconfig.build.json`
- `scripts`
- `sql`

The remote deploy helper keeps the previous release as a rollback source, and only runs `npm ci --omit=dev` when production dependencies changed or `-ForceInstallDependencies` was requested.

## Usage

Default deploy:

```powershell
.\deploy-vps.bat
```

Deploy with a custom release name:

```powershell
.\deploy-vps.bat -ReleaseName hotfix-kyiv-fill
```

Skip local lint/build when `backend/dist` is already up to date:

```powershell
.\deploy-vps.bat -SkipLint -SkipBuild
```

Force reinstall production dependencies on the VPS:

```powershell
.\deploy-vps.bat -ForceInstallDependencies
```

Validate the resolved commands without deploying:

```powershell
.\deploy-vps.bat -DryRun
```

## Safety Guarantees

- Deploys only into `/srv/alerts-ua`.
- Restarts only `alerts-ua-api.service`.
- Verifies that `dtek-api.service` is active before and after deployment.
- Uses the dedicated runtime Node/NPM from `/srv/alerts-ua/runtime/node`.
- Rolls back `current` to the previous release if the API service or health check fails.