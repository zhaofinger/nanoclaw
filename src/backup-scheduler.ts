import {
  uploadBackup,
  cleanupOldBackups,
  verifyLatestBackup,
} from './backup-safe.js';
import {
  backupToGit,
  startGitBackupScheduler,
  isGitBackupConfigured,
} from './git-backup.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

let schedulerStarted = false;

interface BackupConfig {
  // SQLite Blob 备份
  sqliteEnabled: boolean;
  sqliteIntervalMinutes: number;

  // Git 文件备份
  gitEnabled: boolean;
  gitIntervalMinutes: number;
}

function getConfig(): BackupConfig {
  const env = readEnvFile([
    'ENABLE_SQLITE_BACKUP',
    'SQLITE_BACKUP_INTERVAL',
    'GIT_BACKUP_REPO',
    'GIT_BACKUP_INTERVAL',
  ]);
  return {
    sqliteEnabled: env.ENABLE_SQLITE_BACKUP === 'true',
    sqliteIntervalMinutes: parseInt(env.SQLITE_BACKUP_INTERVAL || '60', 10),
    gitEnabled: isGitBackupConfigured(),
    gitIntervalMinutes: parseInt(env.GIT_BACKUP_INTERVAL || '30', 10),
  };
}

/**
 * 执行完整的备份（SQLite + Git）
 */
export async function runFullBackup(): Promise<void> {
  const config = getConfig();

  logger.info('Starting full backup');

  // 1. 备份 SQLite 到 Blob
  if (config.sqliteEnabled) {
    try {
      await uploadBackup();
      await cleanupOldBackups();
      logger.info('SQLite backup completed');
    } catch (err) {
      logger.error({ err }, 'SQLite backup failed');
    }
  }

  // 2. 备份文件记忆到 Git
  if (config.gitEnabled) {
    try {
      await backupToGit();
      logger.info('Git backup completed');
    } catch (err) {
      logger.error({ err }, 'Git backup failed');
    }
  }

  logger.info('Full backup completed');
}

/**
 * 启动自动备份调度器
 */
export function startBackupScheduler(): void {
  if (schedulerStarted) {
    logger.debug('Backup scheduler already started');
    return;
  }

  const config = getConfig();

  if (!config.sqliteEnabled && !config.gitEnabled) {
    logger.info('Backup not configured, scheduler not started');
    return;
  }

  schedulerStarted = true;

  logger.info(
    {
      sqliteEnabled: config.sqliteEnabled,
      sqliteInterval: config.sqliteIntervalMinutes,
      gitEnabled: config.gitEnabled,
      gitInterval: config.gitIntervalMinutes,
    },
    'Starting backup scheduler',
  );

  // SQLite 备份调度（默认每小时）
  if (config.sqliteEnabled) {
    // 立即执行一次
    uploadBackup().catch((err) =>
      logger.error({ err }, 'Initial SQLite backup failed'),
    );

    setInterval(
      () => {
        uploadBackup().catch((err) =>
          logger.error({ err }, 'Scheduled SQLite backup failed'),
        );
      },
      config.sqliteIntervalMinutes * 60 * 1000,
    );

    // 清理旧备份（每天一次）
    setInterval(
      () => {
        cleanupOldBackups().catch((err) =>
          logger.error({ err }, 'Cleanup old backups failed'),
        );
      },
      24 * 60 * 60 * 1000,
    );
  }

  // Git 备份调度（默认每 30 分钟）
  if (config.gitEnabled) {
    startGitBackupScheduler(config.gitIntervalMinutes);
  }
}

/**
 * 获取备份状态
 */
export async function getBackupStatus(): Promise<{
  sqlite: { enabled: boolean; lastBackup?: string; verified: boolean };
  git: { enabled: boolean; hasChanges: boolean; lastCommit?: string };
}> {
  const config = getConfig();

  const status: {
    sqlite: { enabled: boolean; verified: boolean };
    git: { enabled: boolean; hasChanges: boolean; lastCommit?: string };
  } = {
    sqlite: {
      enabled: config.sqliteEnabled,
      verified: false,
    },
    git: {
      enabled: config.gitEnabled,
      hasChanges: false,
    },
  };

  if (config.sqliteEnabled) {
    status.sqlite.verified = await verifyLatestBackup();
  }

  if (config.gitEnabled) {
    const { getGitBackupStatus } = await import('./git-backup.js');
    const gitStatus = await getGitBackupStatus();
    status.git.hasChanges = gitStatus.hasChanges;
    status.git.lastCommit = gitStatus.lastCommit;
  }

  return status;
}
