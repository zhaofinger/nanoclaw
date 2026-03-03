import { Bot } from 'grammy';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import { getKeyStatus } from '../api-key-manager.js';
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
  private draftIds: Map<string, number> = new Map();
  private draftContent: Map<string, string> = new Map();

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Set bot command menu
    await this.bot.api.setMyCommands([
      { command: 'status', description: '查看 bot 状态和 API key 信息' },
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

        const statusText = [
          `*${ASSISTANT_NAME} Status*`,
          '',
          `🤖 *Bot*: Online`,
          `🐳 *Container Runtime*: ${containerStatus}`,
          `📦 *Active Containers*: ${activeContainers}`,
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

      // Clear any active draft for this chat
      this.draftIds.delete(jid);
      this.draftContent.delete(jid);

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

  /**
   * Send a streaming message using sendMessageDraft API.
   * Updates the same draft message as content arrives, then sends final message.
   */
  async sendStreamingMessage(
    jid: string,
    chunks: AsyncIterable<string>,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    const numericId = parseInt(jid.replace(/^tg:/, ''), 10);
    if (isNaN(numericId)) {
      logger.warn({ jid }, 'Invalid Telegram chat ID');
      return;
    }

    // Generate a unique draft ID for this streaming session
    const draftId = Date.now();
    this.draftIds.set(jid, draftId);

    let fullContent = '';
    let lastSentContent = '';
    let lastUpdateTime = 0;
    const UPDATE_INTERVAL_MS = 500; // Update at most every 500ms
    const MAX_DRAFT_LENGTH = 4096;

    try {
      for await (const chunk of chunks) {
        fullContent += chunk;

        // Throttle updates to avoid rate limits
        const now = Date.now();
        if (now - lastUpdateTime < UPDATE_INTERVAL_MS) {
          continue;
        }

        // Only send if content changed significantly (>10 chars or first update)
        if (
          lastSentContent.length === 0 ||
          fullContent.length - lastSentContent.length > 10
        ) {
          const draftText = fullContent.slice(0, MAX_DRAFT_LENGTH);
          await this.sendMessageDraft(numericId, draftId, draftText);
          lastSentContent = draftText;
          lastUpdateTime = now;
          this.draftContent.set(jid, draftText);
        }
      }

      // Send final message (clearing draft)
      this.draftIds.delete(jid);
      this.draftContent.delete(jid);

      // Split final message if needed
      const MAX_LENGTH = 4096;
      if (fullContent.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, fullContent);
      } else {
        for (let i = 0; i < fullContent.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(
            numericId,
            fullContent.slice(i, i + MAX_LENGTH),
          );
        }
      }

      logger.info(
        { jid, length: fullContent.length },
        'Telegram streaming message sent',
      );
    } catch (err) {
      this.draftIds.delete(jid);
      this.draftContent.delete(jid);
      logger.error({ jid, err }, 'Failed to send Telegram streaming message');
      throw err;
    }
  }

  /**
   * Send or update a message draft using raw Telegram Bot API.
   * This is an experimental API for streaming message updates.
   */
  private async sendMessageDraft(
    chatId: number,
    draftId: number,
    text: string,
  ): Promise<void> {
    try {
      // Use raw API call since grammy might not have sendMessageDraft yet
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessageDraft`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          draft_id: draftId,
          text: text,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        // Don't throw for draft errors - the API might not be available
        logger.debug({ chatId, draftId, error }, 'sendMessageDraft API error');
      }
    } catch (err) {
      // Silently fail - draft API is optional and might not be supported
      logger.debug({ chatId, draftId, err }, 'sendMessageDraft failed');
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
