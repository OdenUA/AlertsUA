/**
 * Standalone скрипт для отправки уведомления (для VPS)
 */

import { Pool } from 'pg';
import { existsSync, readFileSync } from 'fs';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';

const DATABASE_URL = process.env.DATABASE_URL || '';
const FIREBASE_SERVICE_ACCOUNT_PATH = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '';

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error('Usage: node send-notification.js <installation_id> <title> <body>');
    process.exit(1);
  }

  const [installationId, title, body] = args;

  const pool = new Pool({ connectionString: DATABASE_URL });

  try {
    const tokenResult = await pool.query<{ fcm_token: string }>(
      `SELECT fcm_token FROM device_push_tokens WHERE installation_id = $1 AND is_active = TRUE ORDER BY last_seen_at DESC LIMIT 1`,
      [installationId],
    );

    if (tokenResult.rowCount === 0) {
      console.error(`No active FCM token found for installation_id: ${installationId}`);
      process.exit(1);
    }

    const { fcm_token } = tokenResult.rows[0];
    console.log(`Sending to token: ${fcm_token.substring(0, 20)}...`);

    const serviceAccount = JSON.parse(readFileSync(FIREBASE_SERVICE_ACCOUNT_PATH, 'utf-8'));
    const app = getApps().length === 0
      ? initializeApp({ credential: cert(serviceAccount) })
      : getApps()[0];
    const messaging = getMessaging(app);

    const messageId = await messaging.send({
      token: fcm_token,
      notification: { title, body },
      android: { priority: 'high' },
    });

    console.log(`✅ Sent! Message ID: ${messageId}`);
    await pool.end();
  } catch (error: any) {
    console.error(`❌ Error: ${error.code || error.message}`);
    await pool.end();
    process.exit(1);
  }
}

main();
