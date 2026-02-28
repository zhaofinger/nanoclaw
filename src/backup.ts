import { put, list, del } from '@vercel/blob';
import { createReadStream, createWriteStream } from 'fs';
import { createGzip, createGunzip } from 'zlib';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { pipeline } from 'stream/promises';
import { STORE_DIR } from './config.js';
import path from 'path';
import fs from 'fs';

const BACKUP_PREFIX = 'nanoclaw-backup';
const KEY = Buffer.from(
  process.env.BACKUP_KEY?.padEnd(32, '0').slice(0, 32) ||
    'nanoclaw-backup-key-32-chars!',
);

/**
 * Encrypt buffer using AES-256-CBC
 */
function encrypt(buffer: Buffer): Buffer {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', KEY, iv);
  return Buffer.concat([iv, cipher.update(buffer), cipher.final()]);
}

/**
 * Decrypt buffer
 */
function decrypt(encrypted: Buffer): Buffer {
  const iv = encrypted.slice(0, 16);
  const data = encrypted.slice(16);
  const decipher = createDecipheriv('aes-256-cbc', KEY, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/**
 * Compress and encrypt database file
 */
export async function createBackup(): Promise<Buffer> {
  const dbPath = path.join(STORE_DIR, 'messages.db');

  // Read database
  const dbBuffer = fs.readFileSync(dbPath);

  // Compress (SQLite 通常可压缩 50-80%)
  const compressed = await new Promise<Buffer>((resolve, reject) => {
    const gzip = createGzip({ level: 9 });
    const chunks: Buffer[] = [];

    gzip.on('data', (chunk) => chunks.push(chunk));
    gzip.on('end', () => resolve(Buffer.concat(chunks)));
    gzip.on('error', reject);

    gzip.end(dbBuffer);
  });

  // Encrypt
  return encrypt(compressed);
}

/**
 * Upload backup to Vercel Blob with retention strategy
 */
export async function uploadBackup(): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupBuffer = await createBackup();

  // Upload daily backup
  await put(
    `${BACKUP_PREFIX}/daily/messages-${timestamp}.db.enc.gz`,
    backupBuffer,
    {
      access: 'private',
      contentType: 'application/octet-stream',
    },
  );

  console.log(`Backup uploaded: ${backupBuffer.length} bytes`);
}

/**
 * Restore from latest backup
 */
export async function restoreFromBackup(): Promise<void> {
  // List all backups
  const { blobs } = await list({ prefix: `${BACKUP_PREFIX}/daily/` });

  if (blobs.length === 0) {
    throw new Error('No backup found');
  }

  // Sort by uploadedAt, get latest
  const latest = blobs.sort(
    (a, b) =>
      new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
  )[0];

  console.log(`Restoring from: ${latest.url}`);

  // Download
  const response = await fetch(latest.url);
  if (!response.ok) {
    throw new Error(`Failed to download backup: ${response.status}`);
  }

  const encrypted = Buffer.from(await response.arrayBuffer());

  // Decrypt and decompress
  const compressed = decrypt(encrypted);
  const dbBuffer = await new Promise<Buffer>((resolve, reject) => {
    const gunzip = createGunzip();
    const chunks: Buffer[] = [];

    gunzip.on('data', (chunk) => chunks.push(chunk));
    gunzip.on('end', () => resolve(Buffer.concat(chunks)));
    gunzip.on('error', reject);

    gunzip.end(compressed);
  });

  // Write to database
  const dbPath = path.join(STORE_DIR, 'messages.db');

  // Backup current (if exists) before overwrite
  if (fs.existsSync(dbPath)) {
    const backupPath = `${dbPath}.local-backup-${Date.now()}`;
    fs.copyFileSync(dbPath, backupPath);
    console.log(`Current database backed up to: ${backupPath}`);
  }

  fs.writeFileSync(dbPath, dbBuffer);
  console.log('Database restored successfully');
}

/**
 * Clean up old backups (keep last 7 daily, 4 weekly, 12 monthly)
 */
export async function cleanupOldBackups(): Promise<void> {
  const { blobs } = await list({ prefix: BACKUP_PREFIX });

  const now = new Date();
  const toDelete: string[] = [];

  for (const blob of blobs) {
    const uploadDate = new Date(blob.uploadedAt);
    const ageDays =
      (now.getTime() - uploadDate.getTime()) / (1000 * 60 * 60 * 24);

    // Keep if:
    // - Less than 7 days old (daily)
    // - Or it's a weekly backup (Sunday) and less than 28 days old
    // - Or it's a monthly backup (1st) and less than 365 days old
    const isWeekly = uploadDate.getDay() === 0; // Sunday
    const isMonthly = uploadDate.getDate() === 1;

    const shouldKeep =
      ageDays < 7 || // Daily
      (isWeekly && ageDays < 28) || // Weekly
      (isMonthly && ageDays < 365); // Monthly

    if (!shouldKeep) {
      toDelete.push(blob.url);
    }
  }

  // Delete in batches
  for (const url of toDelete) {
    await del(url);
    console.log(`Deleted old backup: ${url}`);
  }

  console.log(`Cleanup complete: ${toDelete.length} backups deleted`);
}

/**
 * Verify backup integrity
 */
export async function verifyBackup(): Promise<boolean> {
  try {
    const { blobs } = await list({ prefix: `${BACKUP_PREFIX}/daily/` });
    if (blobs.length === 0) return false;

    // Try to download and decrypt latest backup
    const latest = blobs.sort(
      (a, b) =>
        new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
    )[0];

    const response = await fetch(latest.url);
    const encrypted = Buffer.from(await response.arrayBuffer());

    // Decrypt (will throw if corrupted)
    decrypt(encrypted);

    console.log('Backup verification passed');
    return true;
  } catch (err) {
    console.error('Backup verification failed:', err);
    return false;
  }
}
