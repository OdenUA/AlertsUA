import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import readline from 'readline';

const API_ID_RAW = process.env.TELEGRAM_API_ID;
const API_HASH = process.env.TELEGRAM_API_HASH;

if (!API_ID_RAW || !API_HASH) {
  throw new Error(
    'Missing TELEGRAM_API_ID or TELEGRAM_API_HASH. Set both in environment before running.'
  );
}

const API_ID = parseInt(API_ID_RAW, 10);

if (Number.isNaN(API_ID)) {
  throw new Error('TELEGRAM_API_ID must be a valid number.');
}

function promptUser(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log('🔐 Telegram MTProto Session Generator');
  console.log(`Using API ID: ${API_ID}`);
  console.log('');

  const stringSession = new StringSession('');
  const client = new TelegramClient(stringSession, API_ID, API_HASH, {
    connectionRetries: 5,
  });

  try {
    await client.connect();
    console.log('✅ Connected to Telegram servers\n');

    const phoneNumber = await promptUser(
      '📱 Enter your phone number (with + and country code, e.g., +380XXXXXXXXXX): '
    );

    console.log('\n⏳ Sending code...');
    const result = await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, phoneNumber);
    console.log('✅ Code sent to your Telegram!\n');

    const code = await promptUser('🔑 Enter the code you received (without spaces): ');

    console.log('\n⏳ Signing in...');
    
    // Sign in with phone code and password (for 2FA support)
    const user = await client.signInWithPassword(
      { apiId: API_ID, apiHash: API_HASH },
      {
        phoneNumber,
        phoneCodeHash: result.phoneCodeHash,
        phoneCode: code,
        password: async (hint) => {
          // Return empty string if no 2FA needed
          if (!hint) return '';
          // Prompt for password if 2FA is enabled
          return await promptUser(`🔐 Enter 2FA password (${hint}): `);
        },
        onError: (err) => {
          console.error('Auth error:', err?.message || String(err));
        },
      },
    );

    const userName = user?.firstName || 'User';
    console.log(`✅ Signed in as ${userName}!\n`);

    const sessionString = client.session.save();
    console.log('📋 Your Telegram Session String (copy this to TELEGRAM_SESSION_STRING):');
    console.log('═'.repeat(80));
    console.log(sessionString);
    console.log('═'.repeat(80));
    console.log('');
    console.log('✅ Save this string - you need it for .env.worker on VPS');

    await client.disconnect();
  } catch (error) {
    const msg = error?.message || String(error);
    
    if (msg.includes('password') || msg.includes('SESSION_PASSWORD_NEEDED')) {
      console.error('⚠️  2FA is enabled. For 2FA accounts, please:');
      console.error('   1. Temporarily disable 2FA in Telegram settings');
      console.error('   2. Run this script again');
      console.error('   3. Re-enable 2FA after getting the session');
    } else {
      console.error('❌ Error:', msg);
      console.error('\n💡 Troubleshooting:');
      console.error('   - Check phone number format: +380XXXXXXXXXX');
      console.error('   - Ensure your Telegram app is active');
      console.error('   - Verify API_ID and API_HASH are correct');
    }
    process.exit(1);
  }
}

main();
