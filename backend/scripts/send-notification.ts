/**
 * Скрипт для отправки тестового уведомления на указанный installation_id
 *
 * Использование:
 *   npm run send-notification -- <installation_id> <title> <body>
 *
 * Пример:
 *   npm run send-notification -- 123e4567-e89b-12d3-a456-426614174000 "Тест" "Привет мир"
 */

import { Pool } from 'pg';
import { existsSync, readFileSync } from 'fs';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';

const DATABASE_URL = process.env.DATABASE_URL || '';
const FIREBASE_SERVICE_ACCOUNT_PATH =
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '/srv/alerts-ua/env/firebase-service-account.json';

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 3) {
    console.error('Использование: ts-node send-notification.ts <installation_id> <title> <body>');
    console.error('Пример: ts-node send-notification.ts 123e4567-e89b-12d3-a456-426614174000 "Тест" "Привет мир"');
    process.exit(1);
  }

  const [installationId, title, body] = args;

  console.log(`📱 Отправка уведомления на installation_id: ${installationId}`);
  console.log(`📝 Заголовок: ${title}`);
  console.log(`📄 Текст: ${body}`);
  console.log('');

  // Проверка наличия credentials
  if (!existsSync(FIREBASE_SERVICE_ACCOUNT_PATH)) {
    console.error(`❌ Firebase service account не найден: ${FIREBASE_SERVICE_ACCOUNT_PATH}`);
    console.error('   Убедитесь, что FIREBASE_SERVICE_ACCOUNT_PATH указан верно');
    process.exit(1);
  }

  // Подключение к базе
  const pool = new Pool({
    connectionString: DATABASE_URL,
  });

  try {
    // Получаем FCM токен для installation_id
    console.log('🔍 Поиск FCM токена в базе данных...');
    const tokenResult = await pool.query<{
      fcm_token: string;
      is_active: boolean;
      notifications_enabled: boolean;
      status: string;
    }>(
      `
        SELECT dpt.fcm_token,
               dpt.is_active,
               di.notifications_enabled,
               di.status
        FROM device_push_tokens dpt
        JOIN device_installations di ON di.installation_id = dpt.installation_id
        WHERE dpt.installation_id = $1
          AND dpt.is_active = TRUE
        ORDER BY dpt.last_seen_at DESC
        LIMIT 1
      `,
      [installationId],
    );

    if (tokenResult.rowCount === 0) {
      console.error(`❌ Активный FCM токен для installation_id "${installationId}" не найден`);
      console.error('   Убедитесь, что:');
      console.error('   1. installation_id указан верно');
      console.error('   2. Устройство зарегистрировано и активно');
      console.error('   3. Push-уведомления включены в приложении');
      process.exit(1);
    }

    const { fcm_token, is_active, notifications_enabled, status } = tokenResult.rows[0];

    console.log(`✅ Токен найден: ${fcm_token.substring(0, 20)}...`);
    console.log(`   - Активен: ${is_active}`);
    console.log(`   - Уведомления включены: ${notifications_enabled}`);
    console.log(`   - Статус установки: ${status}`);
    console.log('');

    // Инициализация Firebase
    console.log('🔥 Инициализация Firebase Admin SDK...');
    const messaging = getMessagingClient(FIREBASE_SERVICE_ACCOUNT_PATH);

    // Отправка уведомления
    console.log('📤 Отправка уведомления...');

    const messageId = await messaging.send({
      token: fcm_token,
      notification: {
        title: title,
        body: body,
      },
      android: {
        priority: 'high',
      },
    });

    console.log('');
    console.log('✅ Уведомление успешно отправлено!');
    console.log(`📋 Message ID: ${messageId}`);

    await pool.end();
  } catch (error) {
    console.error('');
    console.error('❌ Ошибка при отправке уведомления:');

    if (typeof error === 'object' && error !== null) {
      if ('code' in error) {
        console.error(`   Код ошибки: ${error.code}`);
      }
      if ('message' in error) {
        console.error(`   Сообщение: ${error.message}`);
      }
    } else {
      console.error(error);
    }

    await pool.end();
    process.exit(1);
  }
}

function getMessagingClient(serviceAccountPath: string): Messaging {
  const appName = 'alerts-ua-push-script';
  const existingApp = getApps().find((app) => app.name === appName);
  if (existingApp) {
    return getMessaging(existingApp);
  }

  const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf-8'));
  const app = initializeApp(
    {
      credential: cert(serviceAccount),
    },
    appName,
  );
  return getMessaging(app);
}

main();
