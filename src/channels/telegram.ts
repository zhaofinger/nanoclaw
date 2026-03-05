import { Bot } from 'grammy';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import { getKeyStatus } from '../api-key-manager.js';
import { getChatStats, getSession, setSession } from '../db.js';
import { resolveGroupIpcPath } from '../group-folder.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Set bot command menu
    await this.bot.api.setMyCommands([
      { command: 'status', description: '查看 bot 状态和 API key 信息' },
      { command: 'compact', description: '手动压缩当前会话上下文' },
      { command: 'chatid', description: '获取当前聊天的注册 ID' },
      { command: 'ping', description: '检查 bot 是否在线' },
    ]);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Command to get detailed status
    this.bot.command('status', async (ctx) => {
      try {
        const keyStatus = getKeyStatus();
        const chatJid = `tg:${ctx.chat.id}`;

        // Check container runtime
        let containerStatus = 'Unknown';
        try {
          const { execSync } = await import('child_process');
          execSync('docker info', { stdio: 'ignore' });
          containerStatus = '✅ Running';
        } catch {
          containerStatus = '❌ Not running';
        }

        // Get active containers
        let activeContainers = 0;
        try {
          const { execSync } = await import('child_process');
          const output = execSync(
            'docker ps --filter name=nanoclaw --format "{{.Names}}" 2>/dev/null || echo ""',
            { encoding: 'utf-8' },
          );
          activeContainers = output.trim()
            ? output.trim().split('\n').length
            : 0;
        } catch {
          activeContainers = 0;
        }

        // Get session and context info for current chat
        const group = this.opts.registeredGroups()[chatJid];
        let sessionInfo = '';
        let contextInfo = '';

        if (group) {
          const sessionId = getSession(group.folder);
          const stats = getChatStats(chatJid, ASSISTANT_NAME);

          sessionInfo = `\n📝 *Session*:\n  • ID: ${sessionId ? `${sessionId.slice(0, 16)}...` : '未创建'}\n  • Group: ${group.folder}`;

          if (stats.totalMessages > 0) {
            const firstDate = stats.firstMessageTime
              ? new Date(stats.firstMessageTime).toLocaleDateString('zh-CN')
              : '-';
            const lastDate = stats.lastMessageTime
              ? new Date(stats.lastMessageTime).toLocaleDateString('zh-CN')
              : '-';
            // Estimate tokens: roughly 1 token per char for mixed Chinese/English
            const estimatedTokens = Math.round(stats.totalChars * 0.5);
            const contextLimit = 200000; // Claude context limit
            const usagePercent = Math.min(
              100,
              Math.round((estimatedTokens / contextLimit) * 100),
            );
            contextInfo = `\n💬 *Context Usage*:\n  • Total Messages: ${stats.totalMessages}\n  • User: ${stats.userMessages} / Assistant: ${stats.assistantMessages}\n  • Total Chars: ${stats.totalChars.toLocaleString()}\n  • Est. Tokens: ~${estimatedTokens.toLocaleString()} (${usagePercent}%)\n  • First: ${firstDate}\n  • Last: ${lastDate}`;
          } else {
            contextInfo = '\n💬 *Context Usage*: No messages yet';
          }
        } else {
          sessionInfo = '\n⚠️ This chat is not registered';
        }

        const statusText = [
          `*${ASSISTANT_NAME} Status*`,
          '',
          `🤖 *Bot*: Online`,
          `🐳 *Container Runtime*: ${containerStatus}`,
          `📦 *Active Containers*: ${activeContainers}`,
          `💬 *Chat*: ${chatJid}`,
          sessionInfo,
          contextInfo,
          '',
          `🔑 *API Keys*:`,
          `  • Total: ${keyStatus.totalKeys}`,
          `  • Available: ${keyStatus.availableKeys}`,
          `  • Current: ${keyStatus.currentKey}`,
          ...keyStatus.keys.map(
            (k) =>
              `  • ${k.name}: ${k.available ? '🟢' : '🔴'} (${k.errors} errors)`,
          ),
        ].join('\n');

        ctx.reply(statusText, { parse_mode: 'Markdown' });
      } catch (err) {
        logger.error({ err }, 'Failed to get status');
        ctx.reply('Failed to retrieve status. Please try again later.');
      }
    });

    // Command to compact the current session context
    this.bot.command('compact', async (ctx) => {
      try {
        const chatJid = `tg:${ctx.chat.id}`;
        const group = this.opts.registeredGroups()[chatJid];

        if (!group) {
          ctx.reply('⚠️ 当前聊天未注册，无法执行 compact');
          return;
        }

        // Check if there's an active container for this group
        const { execSync } = await import('child_process');
        const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
        const containerPattern = `nanoclaw-${safeName}`;

        let hasActiveContainer = false;
        try {
          const output = execSync(
            `docker ps --filter name=${containerPattern} --format "{{.Names}}" 2>/dev/null || echo ""`,
            { encoding: 'utf-8' },
          );
          hasActiveContainer = output.trim().length > 0;
        } catch {
          hasActiveContainer = false;
        }

        if (hasActiveContainer) {
          // Send compact signal via IPC to active container
          const ipcDir = resolveGroupIpcPath(group.folder);
          const inputDir = path.join(ipcDir, 'input');
          fs.mkdirSync(inputDir, { recursive: true });

          const compactSentinel = path.join(inputDir, '_compact');
          fs.writeFileSync(compactSentinel, '');

          ctx.reply('🔄 已发送 compact 信号，会话上下文将被压缩...');
          logger.info(
            { chatJid, group: group.folder },
            'Compact signal sent to active container',
          );
        } else {
          // No active container - clear the session to achieve similar effect
          const currentSession = getSession(group.folder);
          if (currentSession) {
            // Clear session by setting it to a new empty value
            setSession(group.folder, `compacted-${Date.now()}`);
            ctx.reply('✅ 会话已重置（无活跃容器）。下次触发时将创建新会话。');
            logger.info(
              { chatJid, group: group.folder, oldSession: currentSession },
              'Session compacted (no active container)',
            );
          } else {
            ctx.reply('📭 当前没有活跃会话，无需 compact');
          }
        }
      } catch (err) {
        logger.error({ err }, 'Failed to compact session');
        ctx.reply('❌ compact 操作失败，请稍后重试');
      }
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Mario\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string, filePath?: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      // Include file path in content if available
      let content = `${placeholder}${caption}`;
      if (filePath) {
        content += `\n[File: ${filePath}]`;
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    };

    // Download and save photo to group directory
    const downloadPhoto = async (ctx: any): Promise<string | undefined> => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      try {
        // Get the largest photo (highest resolution)
        const photos = ctx.message.photo;
        const photo = photos[photos.length - 1];
        const fileId = photo.file_id;

        // Get file info from Telegram
        const file = await ctx.api.getFile(fileId);
        if (!file.file_path) {
          logger.warn({ fileId }, 'Telegram file has no file_path');
          return;
        }

        // Download file from Telegram
        const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const response = await fetch(fileUrl);
        if (!response.ok) {
          logger.warn(
            { fileUrl, status: response.status },
            'Failed to download photo from Telegram',
          );
          return;
        }

        // Save to group directory
        const mediaDir = path.join(GROUPS_DIR, group.folder, 'media');
        fs.mkdirSync(mediaDir, { recursive: true });

        // Generate filename with timestamp and original extension
        const timestamp = Date.now();
        const originalExt = path.extname(file.file_path) || '.jpg';
        const fileName = `photo_${timestamp}${originalExt}`;
        const filePath = path.join(mediaDir, fileName);

        // Save file
        const buffer = await response.arrayBuffer();
        fs.writeFileSync(filePath, Buffer.from(buffer));

        // Return relative path from group directory (agent sees /workspace/group/)
        const relativePath = path.join('media', fileName);
        logger.info(
          { filePath: relativePath, group: group.folder },
          'Telegram photo saved',
        );
        return relativePath;
      } catch (err) {
        logger.error({ err, chatJid }, 'Failed to download Telegram photo');
        return;
      }
    };

    this.bot.on('message:photo', async (ctx) => {
      const filePath = await downloadPhoto(ctx);
      storeNonText(ctx, '[Photo]', filePath);
    });
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }

  async sendReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.setMessageReaction(
        numericId,
        parseInt(messageId, 10),
        [{ type: 'emoji', emoji: emoji as any }],
      );
      logger.info({ jid, messageId, emoji }, 'Telegram reaction sent');
    } catch (err) {
      logger.error(
        { jid, messageId, emoji, err },
        'Failed to send Telegram reaction',
      );
    }
  }
}
