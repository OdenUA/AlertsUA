import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const options = {
    dryRun: false,
  };

  for (const arg of argv) {
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (!arg.startsWith('--')) {
      continue;
    }

    const separatorIndex = arg.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = arg.slice(2, separatorIndex);
    const value = arg.slice(separatorIndex + 1);
    options[key] = value;
  }

  return options;
}

function stripBom(value) {
  return value.replace(/^\uFEFF/, '');
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const args = parseArgs(process.argv.slice(2));
  const migrationFile = path.resolve(
    scriptDir,
    args.file ?? '../../supabase/migrations/0001_initial.sql',
  );
  const sql = stripBom(await fs.readFile(migrationFile, 'utf8')).trim();

  if (!sql) {
    throw new Error(`Migration file is empty: ${migrationFile}`);
  }

  const projectRef =
    args['project-ref'] ??
    process.env.SUPABASE_PROJECT_ID ??
    process.env.SUPABASE_PROJECT_REF;
  const accessToken = args['access-token'] ?? process.env.SUPABASE_ACCESS_TOKEN;

  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          dry_run: true,
          project_ref: projectRef ?? null,
          migration_file: migrationFile,
          sql_bytes: Buffer.byteLength(sql, 'utf8'),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!projectRef) {
    throw new Error(
      'Missing SUPABASE_PROJECT_ID or --project-ref=<ref> for remote schema apply.',
    );
  }

  if (!accessToken) {
    throw new Error(
      'Missing SUPABASE_ACCESS_TOKEN or --access-token=<token> for remote schema apply.',
    );
  }

  const response = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: sql,
      }),
    },
  );

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Supabase schema apply failed (${response.status} ${response.statusText}): ${responseText}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        status: 'ok',
        project_ref: projectRef,
        migration_file: migrationFile,
        response_status: response.status,
        response_body: responseText || null,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});