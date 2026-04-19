import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import * as readline from 'readline';

const API_ID_RAW = process.env['TELEGRAM_API_ID'];
const API_HASH = process.env['TELEGRAM_API_HASH'];

if (!API_ID_RAW || !API_HASH) {
  throw new Error(
    'Missing TELEGRAM_API_ID or TELEGRAM_API_HASH. Set both in environment before running.',
  );
}

const API_ID = parseInt(API_ID_RAW, 10);

if (Number.isNaN(API_ID)) {
  throw new Error('TELEGRAM_API_ID must be a valid number.');
}

async function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
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
      '📱 Enter your phone number (with + and country code, e.g., +380XXXXXXXXXX): ',
    );

    console.log('\n⏳ Sending code...');
    const result = await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, phoneNumber);

    console.log('✅ Code sent to your Telegram!\n');

    const code = await promptUser(
      '🔑 Enter the code you received (without spaces): ',
    );

    console.log('\n⏳ Signing in...');
    let user: any;
    try {
      user = await client.signInWithPassword(
        { apiId: API_ID, apiHash: API_HASH },
        {
          phoneCodeHash: result.phoneCodeHash,
          phoneCode: code,
          password: async (hint?: string) => {
            if (hint) console.log(`💡 Hint: ${hint}`);
            return await promptUser('🔐 2FA Password: ');
          },
          onError: (err: Error) => {
            console.error('❌ Auth error:', err.message);
          },
        },
      );
    } catch (firstAttemptError: any) {
      console.log('ℹ️  Trying alternative auth method...');
      const passwordValue = await promptUser('🔐 Enter 2FA password (if required): ');
      user = await client.signInWithPassword(
        { apiId: API_ID, apiHash: API_HASH },
        {
          phoneCodeHash: result.phoneCodeHash,
          phoneCode: code,
          password: async () => passwordValue || '',
          onError: (err: Error) => console.error('❌ Error:', err.message),
        },
      );
    }

    const userDetails = user && typeof user === 'object' && 'firstName' in user
      ? (user as any).firstName
      : 'User';
    console.log(`✅ Signed in as ${userDetails}!\n`);

    const sessionString = client.session.save();
    console.log('📋 Your Telegram Session String (copy this to TELEGRAM_SESSION_STRING):');
    console.log('═'.repeat(80));
    console.log(sessionString);
    console.log('═'.repeat(80));
    console.log('');
    console.log('✅ Save this string to a secure location and use it in your .env.worker file');

    await client.disconnect();
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : String(error));
    console.error('\n💡 If authentication keeps failing:');
    console.error('   1. Try again with a different phone number');
    console.error('   2. Ensure Telegram app is installed on your device');
    console.error('   3. Check API credentials are correct in TG Gemini attachment');
    process.exit(1);
  }
}

main();
