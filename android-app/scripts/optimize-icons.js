const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const resDir = path.join(__dirname, '..', 'app', 'src', 'main', 'res');

const launcherIconSizes = {
  'mipmap-mdpi': 48,
  'mipmap-hdpi': 72,
  'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144,
  'mipmap-xxxhdpi': 192,
};

const launcherFiles = ['ic_launcher.png', 'ic_launcher_round.png'];

async function processLauncherIcons() {
  for (const file of launcherFiles) {
    const source = path.join(resDir, 'mipmap-xxxhdpi', file);
    if (!fs.existsSync(source)) {
      console.warn(`Source not found: ${source}`);
      continue;
    }

    for (const [folder, size] of Object.entries(launcherIconSizes)) {
      const targetDir = path.join(resDir, folder);
      const targetFile = path.join(targetDir, file.replace('.png', '.webp'));

      await sharp(source)
        .resize(size, size, { fit: 'cover' })
        .webp({ quality: 90, effort: 6, lossless: false })
        .toFile(targetFile);

      console.log(`Generated ${targetFile}: ${size}x${size}`);

      // Remove old PNG to avoid duplicate resources
      const oldPng = path.join(targetDir, file);
      if (fs.existsSync(oldPng)) {
        fs.unlinkSync(oldPng);
        console.log(`Removed old ${oldPng}`);
      }
    }
  }
}

async function processNotificationIcon() {
  const source = path.join(resDir, 'drawable', 'ic_notification_large.png');
  const target = path.join(resDir, 'drawable', 'ic_notification_large.webp');

  if (!fs.existsSync(source)) {
    console.warn(`Source not found: ${source}`);
    return;
  }

  await sharp(source)
    .resize(256, 256, { fit: 'cover' })
    .webp({ quality: 90, effort: 6 })
    .toFile(target);

  console.log(`Generated ${target}: 256x256`);

  fs.unlinkSync(source);
  console.log(`Removed old ${source}`);
}

async function processSmallIcons() {
  const smallIcons = [
    'drawable/tg.png',
    'drawable/ic_tg.png',
    'drawable/faq.png',
    'drawable/fullscreen.png',
    'drawable/map.png',
    'drawable/refresh.png',
    'drawable/theme.png',
  ];

  for (const relPath of smallIcons) {
    const source = path.join(resDir, relPath);
    if (!fs.existsSync(source)) continue;

    const target = source.replace('.png', '.webp');
    await sharp(source)
      .webp({ quality: 95, effort: 6 })
      .toFile(target);

    console.log(`Generated ${target}`);
    fs.unlinkSync(source);
    console.log(`Removed old ${source}`);
  }
}

async function main() {
  try {
    await processLauncherIcons();
    await processNotificationIcon();
    await processSmallIcons();
    console.log('Done');
  } catch (e) {
    console.error('Error:', e);
    process.exit(1);
  }
}

main();
