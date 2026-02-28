import { put, list, del } from '@vercel/blob';
import Database from 'better-sqlite3';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from 'crypto';
import { createGzip, createGunzip } from 'zlib';
import { promisify } from 'util';
import { STORE_DIR } from './config.js';
import { readEnvFile } from './env.js';
import path from 'path';
import fs from 'fs';
import { logger } from './logger.js';

const gzip = promisify(createGzip);
const gunzip = promisify(createGunzip);

const BACKUP_PREFIX = 'nanoclaw-backup';

function getBackupKey(): Buffer {
  const env = readEnvFile(['BACKUP_KEY']);
  return Buffer.from(
    env.BACKUP_KEY?.padEnd(32, '0').slice(0, 32) ||
      'nanoclaw-backup-key-32-chars!',
  );
}

function getBlobToken(): string {
  const env = readEnvFile(['BLOB_READ_WRITE_TOKEN']);
  return env.BLOB_READ_WRITE_TOKEN || '';
}

interface BackupMetadata {
  version: string;
  timestamp: string;
  size: number;
  checksum: string;
  sqliteVersion: string;
}

/**
 * Encrypt buffer using AES-256-GCM (更安全的认证加密)
 */
function encrypt(buffer: Buffer): Buffer {
  const iv = randomBytes(16);
  const authTagLength = 16;
  const cipher = createCipheriv('aes-256-gcm', getBackupKey(), iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Decrypt buffer
 */
function decrypt(encrypted: Buffer): Buffer {
  const iv = encrypted.slice(0, 16);
  const authTag = encrypted.slice(16, 32);
  const data = encrypted.slice(32);
  const decipher = createDecipheriv('aes-256-gcm', getBackupKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/**
 * 计算 SHA-256 校验和
 */
function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * 使用 SQLite 在线备份 API 创建一致性的备份
 * 不需要停止服务，不会备份到一半有新数据写入
 */
export async function createSafeBackup(): Promise<{
  buffer: Buffer;
  metadata: BackupMetadata;
}> {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  const backupPath = path.join(STORE_DIR, 'messages.backup.tmp');

  try {
    // 方法: 使用 SQLite 在线备份 API（推荐）
    // better-sqlite3 的 backup 方法创建一个备份对象
    const sourceDb = new Database(dbPath);

    // 执行在线备份 - 这会创建数据库的快照
    // 即使备份过程中有新写入，也不会影响备份的一致性
    // 使用 exec 直接执行 SQL 备份命令更可靠
    sourceDb.exec(`VACUUM INTO '${backupPath}'`);

    sourceDb.close();

    // 读取备份文件
    const backupBuffer = fs.readFileSync(backupPath);

    // 计算校验和
    const checksum = sha256(backupBuffer);

    // 压缩（SQLite 通常能压缩 60-80%）
    const compressed = await new Promise<Buffer>((resolve, reject) => {
      const gzip = createGzip({ level: 9 });
      const chunks: Buffer[] = [];
      gzip.on('data', (chunk) => chunks.push(chunk));
      gzip.on('end', () => resolve(Buffer.concat(chunks)));
      gzip.on('error', reject);
      gzip.end(backupBuffer);
    });

    // 加密
    const encrypted = encrypt(compressed);

    const metadata: BackupMetadata = {
      version: '1.0',
      timestamp: new Date().toISOString(),
      size: backupBuffer.length,
      checksum,
      sqliteVersion: '3.x', // better-sqlite3 不提供静态版本号
    };

    // 清理临时文件
    fs.unlinkSync(backupPath);

    logger.info(
      {
        originalSize: backupBuffer.length,
        compressedSize: compressed.length,
        encryptedSize: encrypted.length,
        ratio:
          ((compressed.length / backupBuffer.length) * 100).toFixed(1) + '%',
      },
      'Backup created successfully',
    );

    return { buffer: encrypted, metadata };
  } catch (err) {
    // 清理临时文件
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }
    throw err;
  }
}

/**
 * 上传备份到 Vercel Blob
 */
export async function uploadBackup(): Promise<void> {
  const { buffer, metadata } = await createSafeBackup();

  const date = new Date();
  const dateStr = date.toISOString().split('T')[0]; // 2026-02-27

  // 文件命名: nanoclaw-backup/daily/2026-02-27_xxxxxx.db
  const filename = `${BACKUP_PREFIX}/daily/${dateStr}_${Date.now()}.db`;

  const token = getBlobToken();
  if (!token) {
    throw new Error('BLOB_READ_WRITE_TOKEN not configured');
  }

  // 上传数据库文件
  await put(filename, buffer, {
    access: 'private',
    contentType: 'application/octet-stream',
    token,
  });

  // 上传元数据（便于验证）
  await put(`${filename}.meta.json`, JSON.stringify(metadata, null, 2), {
    access: 'private',
    contentType: 'application/json',
    token,
  });

  logger.info({ filename, metadata }, 'Backup uploaded to Vercel Blob');
}

/**
 * 从备份恢复
 */
export async function restoreFromBackup(filename?: string): Promise<void> {
  const dbPath = path.join(STORE_DIR, 'messages.db');

  const token = getBlobToken();
  if (!token) {
    throw new Error('BLOB_READ_WRITE_TOKEN not configured');
  }

  // 如果没有指定文件名，找最新的
  let targetFile = filename;
  if (!targetFile) {
    const { blobs } = await list({ prefix: `${BACKUP_PREFIX}/daily/`, token });
    const dbBlobs = blobs.filter((b) => !b.pathname.endsWith('.meta.json'));

    if (dbBlobs.length === 0) {
      throw new Error('No backup found');
    }

    // 按时间排序，取最新的
    targetFile = dbBlobs.sort(
      (a, b) =>
        new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
    )[0].pathname;
  }

  logger.info({ targetFile }, 'Starting restore');

  // 下载备份
  const { blobs } = await list({ prefix: targetFile, token });
  const backupBlob = blobs[0];

  if (!backupBlob) {
    throw new Error(`Backup not found: ${targetFile}`);
  }

  // 下载元数据
  const metaBlob = blobs.find((b) => b.pathname === `${targetFile}.meta.json`);
  let metadata: BackupMetadata | undefined;

  if (metaBlob) {
    const metaResponse = await fetch(metaBlob.url);
    metadata = (await metaResponse.json()) as BackupMetadata;
  }

  // 下载并恢复
  const response = await fetch(backupBlob.url);
  const encrypted = Buffer.from(await response.arrayBuffer());

  // 解密
  const compressed = decrypt(encrypted);

  // 解压
  const dbBuffer = await new Promise<Buffer>((resolve, reject) => {
    const gunzip = createGunzip();
    const chunks: Buffer[] = [];
    gunzip.on('data', (chunk) => chunks.push(chunk));
    gunzip.on('end', () => resolve(Buffer.concat(chunks)));
    gunzip.on('error', reject);
    gunzip.end(compressed);
  });

  // 验证校验和（如果元数据存在）
  if (metadata) {
    const actualChecksum = sha256(dbBuffer);
    if (actualChecksum !== metadata.checksum) {
      throw new Error('Backup checksum mismatch! File may be corrupted.');
    }
    logger.info('Checksum verification passed');
  }

  // 验证 SQLite 文件头
  const header = dbBuffer.slice(0, 16).toString('utf8');
  if (!header.startsWith('SQLite format 3')) {
    throw new Error('Invalid SQLite file format');
  }

  // 备份当前数据库（防止恢复失败导致数据丢失）
  if (fs.existsSync(dbPath)) {
    const localBackup = `${dbPath}.bak.${Date.now()}`;
    fs.copyFileSync(dbPath, localBackup);
    logger.info({ localBackup }, 'Current database backed up locally');
  }

  // 写入新数据库
  fs.writeFileSync(dbPath, dbBuffer);

  logger.info({ size: dbBuffer.length }, 'Database restored successfully');
}

/**
 * 清理旧备份
 * 保留策略：7天每日 + 4周每周 + 12月每月
 */
export async function cleanupOldBackups(): Promise<void> {
  const token = getBlobToken();
  if (!token) {
    logger.warn('BLOB_READ_WRITE_TOKEN not configured, skipping cleanup');
    return;
  }

  const { blobs } = await list({ prefix: BACKUP_PREFIX, token });
  const dbBlobs = blobs.filter((b) => !b.pathname.endsWith('.meta.json'));

  const now = new Date();
  const toDelete: string[] = [];

  for (const blob of dbBlobs) {
    const uploadDate = new Date(blob.uploadedAt);
    const ageDays =
      (now.getTime() - uploadDate.getTime()) / (1000 * 60 * 60 * 24);

    const isWeekly = uploadDate.getDay() === 0; // 周日
    const isMonthly = uploadDate.getDate() === 1; // 每月1号

    const shouldKeep =
      ageDays < 7 || // 最近7天全部保留
      (isWeekly && ageDays < 28) || // 4周内的每周备份
      (isMonthly && ageDays < 365); // 1年内的每月备份

    if (!shouldKeep) {
      toDelete.push(blob.pathname);
      // 同时删除对应的元数据文件
      toDelete.push(`${blob.pathname}.meta.json`);
    }
  }

  // 批量删除
  for (const pathname of toDelete) {
    try {
      await del(pathname, { token });
      logger.info({ pathname }, 'Deleted old backup');
    } catch (err) {
      logger.warn({ pathname, err }, 'Failed to delete backup');
    }
  }

  logger.info({ deleted: toDelete.length / 2 }, 'Backup cleanup complete');
}

/**
 * 验证最新备份是否可用
 */
export async function verifyLatestBackup(): Promise<boolean> {
  const token = getBlobToken();
  if (!token) {
    return false;
  }

  try {
    const { blobs } = await list({ prefix: `${BACKUP_PREFIX}/daily/`, token });
    const dbBlobs = blobs.filter((b) => !b.pathname.endsWith('.meta.json'));

    if (dbBlobs.length === 0) {
      logger.warn('No backups found to verify');
      return false;
    }

    const latest = dbBlobs.sort(
      (a, b) =>
        new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
    )[0];

    // 下载并尝试解密
    const response = await fetch(latest.url);
    const encrypted = Buffer.from(await response.arrayBuffer());

    // 解密（失败会抛出异常）
    decrypt(encrypted);

    logger.info({ pathname: latest.pathname }, 'Backup verification passed');
    return true;
  } catch (err) {
    logger.error({ err }, 'Backup verification failed');
    return false;
  }
}
