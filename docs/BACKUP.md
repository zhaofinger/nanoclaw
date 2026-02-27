# NanoClaw 备份指南

NanoClaw 支持两种备份方式：

1. **SQLite 数据库** → Vercel Blob（压缩 + 加密）
2. **文件记忆** → GitHub 仓库（版本控制）

---

## 快速开始

### 1. 配置环境变量

复制示例配置并修改：

```bash
cp .env.backup.example .env
```

编辑 `.env` 文件，填入你的配置：

```bash
# ============================================
# SQLite 数据库备份到 Vercel Blob
# ============================================

# 启用 SQLite 备份
ENABLE_SQLITE_BACKUP=true

# 备份间隔（分钟）
SQLITE_BACKUP_INTERVAL=60

# Vercel Blob Token（从 Vercel Dashboard 获取）
BLOB_READ_WRITE_TOKEN=vercel_blob_token_here

# 加密密钥（64 字符十六进制）
BACKUP_KEY=your_64_char_hex_key_here

# ============================================
# 文件记忆备份到 GitHub
# ============================================

# GitHub 仓库地址（使用 Personal Access Token）
# 生成 Token: https://github.com/settings/tokens
GIT_BACKUP_REPO=https://ghp_xxx@github.com/username/nanoclaw-memory.git

# Git 配置
GIT_BACKUP_NAME=NanoClaw Backup
GIT_BACKUP_EMAIL=backup@nanoclaw.local

# 备份间隔（分钟）
GIT_BACKUP_INTERVAL=30
```

### 2. 创建 GitHub 仓库

1. 在 GitHub 创建一个新的**私有**仓库，例如 `nanoclaw-memory`
2. 生成 Personal Access Token（需要 `repo` 权限）
3. 将 Token 填入 `GIT_BACKUP_REPO` 环境变量

### 3. 启动 NanoClaw

```bash
npm run dev
# 或
systemctl --user start nanoclaw
```

备份会自动启动并按配置的时间间隔运行。

---

## 备份内容

### SQLite 数据库（Vercel Blob）

包含：
- 所有消息历史
- 定时任务
- 群组配置
- 会话状态

存储格式：
```
nanoclaw-backup/daily/2026-02-27_123456789.db
├── 压缩（gzip level 9）
├── 加密（AES-256-GCM）
└── 元数据（JSON）
```

保留策略：
- 最近 7 天：每日备份
- 最近 4 周：每周日备份
- 最近 12 个月：每月 1 号备份

### 文件记忆（GitHub）

包含：
- `groups/main/CLAUDE.md` - 主群组记忆
- `groups/main/USER.md` - 用户信息
- `groups/main/SOUL.md` - 个性设定
- `groups/global/CLAUDE.md` - 全局记忆
- 其他 Agent 创建的文件

保留策略：
- Git 完整历史记录
- 可以查看任意时间点的记忆状态
- 支持 diff 查看变更

---

## 灾难恢复

### 从 Vercel Blob 恢复 SQLite

```typescript
import { restoreFromBackup } from './src/backup-safe.js';

// 恢复到最新备份
await restoreFromBackup();

// 或恢复到指定备份
await restoreFromBackup('nanoclaw-backup/daily/2026-02-27_123456.db');
```

### 从 GitHub 恢复文件记忆

```bash
# 克隆备份仓库到 groups 目录
cd /path/to/nanoclaw
cd groups
git clone https://github.com/username/nanoclaw-memory.git . --branch main
```

或代码方式：

```typescript
import { restoreFromGit } from './src/git-backup.js';

await restoreFromGit();
```

---

## 监控备份状态

查看备份状态：

```typescript
import { getBackupStatus } from './src/backup-scheduler.js';

const status = await getBackupStatus();
console.log(status);
// {
//   sqlite: { enabled: true, verified: true },
//   git: { enabled: true, hasChanges: false, lastCommit: '...' }
// }
```

查看日志：

```bash
tail -f logs/nanoclaw.log | grep -i backup
```

---

## 安全注意事项

1. **BACKUP_KEY** 必须保密，丢失后无法解密备份
2. **GitHub Token** 只授予最小权限（repo 访问）
3. GitHub 仓库建议设为**私有**
4. 定期验证备份可恢复性

---

## 故障排除

### SQLite 备份失败

检查：
- `BLOB_READ_WRITE_TOKEN` 是否正确
- `BACKUP_KEY` 是否 >= 32 字符
- Vercel Blob 免费额度（250MB）是否已满

### Git 备份失败

检查：
- `GIT_BACKUP_REPO` 格式是否正确
- Token 是否有 `repo` 权限
- 仓库是否为私有且可访问

### 手动触发备份

```typescript
import { runFullBackup } from './src/backup-scheduler.js';
await runFullBackup();
```
