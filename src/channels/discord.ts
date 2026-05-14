/**
 * Discord channel adapter (v2 native port) — self-registers on import.
 *
 * This is a native ChannelAdapter — it talks to Discord directly via
 * discord.js's Gateway WebSocket. Unlike upstream's `/add-discord` (which
 * wraps `@chat-adapter/discord` via the Chat SDK bridge), this adapter:
 *
 *   - Supports running MULTIPLE bot instances in one process, each
 *     registered under a distinct `channelType` (e.g. `discord-data`,
 *     `discord-geordi`). v2's `messaging_groups` UNIQUE(channel_type,
 *     platform_id) keeps each bot's group rows isolated even when both
 *     bots live in the same Discord channel.
 *   - Preserves the v1 fork's content-normalization behaviours (bot
 *     mention syntax stripping, `[Reply to X]` prefix injection,
 *     attachment placeholders) while setting v2's platform-confirmed
 *     `isMention` flag for the router's engagement evaluator.
 *
 * Env-driven configuration (read once at module load):
 *
 *   Multi-bot mode (preferred):
 *     DISCORD_BOTS_LIST=data,geordi
 *     DISCORD_TOKEN_DATA=...
 *     DISCORD_TOKEN_GEORDI=...
 *     # optional per-bot — only required if you actually plan to verify
 *     # interaction webhooks or do slash-command registration:
 *     DISCORD_APPLICATION_ID_DATA=...
 *     DISCORD_APPLICATION_ID_GEORDI=...
 *     DISCORD_PUBLIC_KEY_DATA=...
 *     DISCORD_PUBLIC_KEY_GEORDI=...
 *
 *   Single-bot fallback (when DISCORD_BOTS_LIST is unset):
 *     DISCORD_BOT_TOKEN=...
 *     DISCORD_APPLICATION_ID=... (optional)
 *     DISCORD_PUBLIC_KEY=...     (optional)
 *
 * Each bot registers under channelType `discord-<name>` in multi-bot mode,
 * or plain `discord` in single-bot mode.
 *
 * platform_id encoding:
 *   - Guild channel:  `discord:<guildId>:<channelId>` (threadId=null)
 *   - Guild thread:   `discord:<guildId>:<channelId>` (threadId=<threadId>)
 *   - DM:             `discord:@me:<dmChannelId>` (threadId=null)
 *
 * The encoding mirrors `@chat-adapter/discord`'s thread-id format so v2
 * downstream tooling (CLI `to` addresses, dropped-messages audit) treats
 * native and Chat-SDK Discord identically.
 */
import {
  Client,
  Events,
  GatewayIntentBits,
  Message as DiscordMessage,
  type TextChannel,
  type ThreadChannel,
  type DMChannel,
} from 'discord.js';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type {
  ChannelAdapter,
  ChannelSetup,
  InboundMessage,
  OutboundMessage,
} from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

// Discord caps a single message at 2000 chars; longer text is split on
// paragraph → line → space → hard-char boundaries (preferring the largest
// boundary that fits) to avoid silent platform-side truncation.
const DISCORD_MAX_MESSAGE_LENGTH = 2000;

// Bot names must be alphanumeric + hyphens. The name flows into the
// channelType (`discord-<name>`) and into the env-var key suffix
// (`DISCORD_TOKEN_<NAME>`), so anything outside this set would create
// either an invalid SQL key or an unreadable env-var name.
const VALID_BOT_NAME = /^[a-z0-9-]+$/i;

export interface DiscordAdapterConfig {
  /** v2 channelType this adapter registers under. e.g. `discord` or `discord-data`. */
  channelType: string;
  /** Discord bot token. */
  botToken: string;
  /** Optional Discord application ID (for slash commands / webhook signing). */
  applicationId?: string;
  /** Optional Discord application public key (for interaction-endpoint verification). */
  publicKey?: string;
  /** Short label for structured logs — defaults to channelType. */
  label?: string;
}

/**
 * Discord platform_id parts after decoding from `discord:<guildId>:<channelId>`
 * (with optional `:<threadId>` suffix on legacy thread platform_ids).
 */
interface DecodedPlatformId {
  guildId: string;
  channelId: string;
  legacyThreadId?: string;
}

function encodePlatformId(guildId: string, channelId: string): string {
  return `discord:${guildId}:${channelId}`;
}

function decodePlatformId(platformId: string): DecodedPlatformId | null {
  const parts = platformId.split(':');
  // Accept both 3-part ("discord:<guildId>:<channelId>") and the rare
  // 4-part legacy encoding that includes thread id as the trailing
  // segment. The 4-part form is exclusively for backwards-compat
  // tolerance — we always EMIT the 3-part form and carry the thread
  // separately via the `threadId` parameter.
  if (parts.length < 3 || parts.length > 4 || parts[0] !== 'discord') return null;
  return {
    guildId: parts[1],
    channelId: parts[2],
    legacyThreadId: parts[3],
  };
}

function classifyAttachment(contentType?: string): 'image' | 'video' | 'audio' | 'file' {
  if (!contentType) return 'file';
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  return 'file';
}

function formatAttachmentPlaceholder(kind: ReturnType<typeof classifyAttachment>, name: string): string {
  const label = kind === 'file' ? 'File' : kind[0].toUpperCase() + kind.slice(1);
  return `[${label}: ${name || kind}]`;
}

/**
 * Split text into chunks no larger than `limit`, preferring paragraph
 * breaks, then line breaks, then a single-space boundary, then a hard
 * character cut as a last resort. Mirrors upstream's `splitForLimit`
 * behaviour in `chat-sdk-bridge.ts` so native+bridge deliver are
 * symmetric on long replies.
 */
export function splitForDiscordLimit(text: string, limit: number = DISCORD_MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf('\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Inbound `content` payload shape. Top-level sender fields (`senderId`,
 * `sender`, `senderName`) are flattened so the v2 router's
 * `extractAndUpsertUser` reads them without descending into a nested
 * `author` object — the same shape native CLI and Chat-SDK adapters
 * deliver after `messageToInbound` projection.
 */
export interface DiscordInboundContent {
  senderId: string;
  sender: string;
  senderName: string;
  text: string;
  replyTo?: { text: string; sender: string };
  attachments?: Array<{
    type: 'image' | 'video' | 'audio' | 'file';
    name: string;
    mimeType?: string;
    size?: number;
  }>;
  /** Guild id of the source message (or `@me` for DMs). */
  guildId: string;
  /** Channel id of the source message. */
  channelId: string;
  /** Thread id when the message was posted inside a Discord thread. */
  threadId?: string;
}

/**
 * Build the v2 InboundMessage from a discord.js Message, applying all
 * content normalization the v1 fork did (mention strip, reply prefix,
 * attachment placeholders) — minus the v1 trigger-pattern injection,
 * which v2's router replaces with the platform-confirmed `isMention`
 * flag set below.
 */
async function buildInboundMessage(
  message: DiscordMessage,
  botUserId: string,
): Promise<InboundMessage> {
  // Resolve sender display fields. Discord's guild member nickname wins
  // when present; otherwise the user's global_name (.displayName);
  // otherwise username.
  const senderId = message.author.id;
  const senderName =
    message.member?.displayName ||
    message.author.displayName ||
    message.author.username;

  // Strip <@botId> / <@!botId> mention syntax — keeps prompts clean.
  // The router decides routing from `isMention` (set below), not text,
  // so dropping the mention here is purely cosmetic.
  let text = message.content;
  if (botUserId) {
    text = text.replace(new RegExp(`<@!?${botUserId}>`, 'g'), '').trim();
  }

  // Reply context — fetch the referenced message and inject
  // `[Reply to <Sender>]` prefix. Failed fetches (deleted message)
  // degrade gracefully — we still deliver the user's message text.
  let replyTo: DiscordInboundContent['replyTo'] | undefined;
  let isReplyToBot = false;
  if (message.reference?.messageId && 'messages' in message.channel) {
    try {
      const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
      const replyAuthor =
        repliedTo.member?.displayName ||
        repliedTo.author.displayName ||
        repliedTo.author.username;
      replyTo = { text: repliedTo.content || '', sender: replyAuthor };
      isReplyToBot = repliedTo.author.id === botUserId;
      text = `[Reply to ${replyAuthor}] ${text}`;
    } catch (err) {
      log.debug('Failed to fetch replied-to message', { err, messageId: message.reference.messageId });
    }
  }

  // Attachment placeholders for the prompt; attachment metadata also
  // shipped as a structured array so downstream tools can fetch the
  // actual bytes via Discord API when needed.
  const attachments: NonNullable<DiscordInboundContent['attachments']> = [];
  if (message.attachments.size > 0) {
    const placeholderLines: string[] = [];
    for (const att of message.attachments.values()) {
      const kind = classifyAttachment(att.contentType ?? undefined);
      const name = att.name || kind;
      attachments.push({
        type: kind,
        name,
        mimeType: att.contentType ?? undefined,
        size: att.size,
      });
      placeholderLines.push(formatAttachmentPlaceholder(kind, name));
    }
    text = text ? `${text}\n${placeholderLines.join('\n')}` : placeholderLines.join('\n');
  }

  // Platform-confirmed mention: @-mention OR DM OR reply-to-bot. The
  // v2 router uses this for engage_mode='mention' / 'mention-sticky'
  // wirings; text-regex matching is the deprecated fallback for
  // legacy adapters that don't set this flag.
  const isDM = !message.guild;
  const isMention =
    isDM ||
    isReplyToBot ||
    (botUserId !== '' && message.mentions.users.has(botUserId));

  const guildId = message.guild?.id ?? '@me';
  const channelId = message.channelId;
  const threadId =
    'isThread' in message.channel && (message.channel as ThreadChannel).isThread()
      ? (message.channel as ThreadChannel).id
      : undefined;

  const content: DiscordInboundContent = {
    senderId,
    sender: senderName,
    senderName,
    text,
    ...(replyTo ? { replyTo } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    guildId,
    channelId,
    ...(threadId ? { threadId } : {}),
  };

  return {
    id: message.id,
    kind: 'chat',
    content,
    timestamp: message.createdAt.toISOString(),
    isMention,
    isGroup: !isDM,
  };
}

/**
 * Resolve metadata for the conversation `message` came from. For guild
 * channels we publish `<Guild> #<channel>`; for DMs we publish the
 * sender's display name as the conversation name. Both feed v2's
 * `onMetadata` callback, which seeds `messaging_groups.name` on first
 * sighting.
 */
function resolveConversationName(message: DiscordMessage): string {
  if (message.guild && 'name' in message.channel) {
    return `${message.guild.name} #${(message.channel as TextChannel).name}`;
  }
  return (
    message.member?.displayName ||
    message.author.displayName ||
    message.author.username
  );
}

/**
 * Build a single ChannelAdapter for one Discord bot token + channelType.
 * Exported for tests; production paths go via the env-driven self-
 * registration block at the bottom of this file.
 */
export function createDiscordChannelAdapter(config: DiscordAdapterConfig): ChannelAdapter {
  const label = config.label ?? config.channelType;
  let client: Client | null = null;
  let botUserId = '';
  // Thread subscriptions — set during subscribe(), informational for
  // adapter-side instrumentation. Discord's Gateway delivers every
  // MESSAGE_CREATE in channels the bot has access to, so there's no
  // platform-side action needed to "subscribe" — the v2 router uses
  // its own subscribed-threads ledger.
  const subscribedThreads = new Set<string>();

  const adapter: ChannelAdapter = {
    name: 'discord',
    channelType: config.channelType,
    supportsThreads: true,

    async setup(host: ChannelSetup): Promise<void> {
      // Re-setup guard: if a caller invokes setup() twice without an
      // intervening teardown(), the previous Discord Client (and its
      // open Gateway WebSocket) would leak. Tear down first, then
      // continue with a fresh client.
      if (client) {
        log.warn('Discord adapter setup called twice — tearing down previous client', {
          channelType: config.channelType,
          label,
        });
        await adapter.teardown();
      }
      client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
        ],
      });

      client.on(Events.MessageCreate, async (message: DiscordMessage) => {
        // Ignore bot messages (including our own). Without this, the
        // adapter would echo every outbound reply back into the router.
        if (message.author.bot) return;

        const guildId = message.guild?.id ?? '@me';
        const platformId = encodePlatformId(guildId, message.channelId);
        const threadId =
          'isThread' in message.channel && (message.channel as ThreadChannel).isThread()
            ? (message.channel as ThreadChannel).id
            : null;
        const isGroup = message.guild !== null;
        const convName = resolveConversationName(message);

        // Always announce metadata — v2 router uses this to seed
        // messaging_groups rows on first sighting (even unwired
        // channels accrue metadata so an admin can wire them later).
        host.onMetadata(platformId, convName, isGroup);

        // Build the structured InboundMessage and forward to host.
        // Unlike v1, the adapter does NOT consult a registeredGroups
        // map — the v2 router decides routing via messaging_groups +
        // messaging_group_agents lookups.
        try {
          const inbound = await buildInboundMessage(message, botUserId);
          await host.onInbound(platformId, threadId, inbound);
        } catch (err) {
          log.error('Discord inbound delivery failed', {
            channelType: config.channelType,
            label,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      });

      client.on(Events.Error, (err) => {
        log.error('Discord client error', { channelType: config.channelType, label, err: err.message });
      });

      return new Promise<void>((resolve, reject) => {
        client!.once(Events.ClientReady, (readyClient) => {
          botUserId = readyClient.user.id;
          log.info('Discord bot connected', {
            channelType: config.channelType,
            label,
            tag: readyClient.user.tag,
            id: readyClient.user.id,
          });
          resolve();
        });
        client!.login(config.botToken).catch(reject);
      });
    },

    async deliver(
      platformId: string,
      threadId: string | null,
      message: OutboundMessage,
    ): Promise<string | undefined> {
      if (!client || !client.isReady()) {
        log.warn('Discord deliver called before client ready', {
          channelType: config.channelType,
          label,
          platformId,
        });
        return undefined;
      }
      const decoded = decodePlatformId(platformId);
      if (!decoded) {
        log.warn('Discord deliver: unparseable platformId', { channelType: config.channelType, platformId });
        return undefined;
      }
      const targetId = threadId ?? decoded.legacyThreadId ?? decoded.channelId;

      let channel;
      try {
        channel = await client.channels.fetch(targetId);
      } catch (err) {
        log.error('Discord deliver: channel fetch failed', {
          channelType: config.channelType,
          targetId,
          err: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
      if (!channel || !('send' in channel)) {
        log.warn('Discord deliver: channel not text-capable', {
          channelType: config.channelType,
          targetId,
        });
        return undefined;
      }
      const textChannel = channel as TextChannel | ThreadChannel | DMChannel;

      // Extract text. v2 outbound content shape carries either `text`
      // or `markdown` (Chat-SDK conventions). We accept both for
      // forward-compat with replies authored under the bridge model.
      const content = message.content as Record<string, unknown>;
      const rawText =
        (typeof content.text === 'string' ? content.text : undefined) ??
        (typeof content.markdown === 'string' ? content.markdown : undefined) ??
        '';
      if (!rawText && (!message.files || message.files.length === 0)) {
        log.debug('Discord deliver: empty payload, skipping', { channelType: config.channelType, platformId });
        return undefined;
      }

      const chunks = rawText ? splitForDiscordLimit(rawText) : [''];
      let firstMessageId: string | undefined;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const attachFiles = i === 0 && message.files && message.files.length > 0;
        try {
          const sent = await textChannel.send(
            attachFiles
              ? {
                  content: chunk || undefined,
                  files: message.files!.map((f) => ({ attachment: f.data, name: f.filename })),
                }
              : { content: chunk },
          );
          if (i === 0) firstMessageId = sent.id;
        } catch (err) {
          log.error('Discord deliver: send failed', {
            channelType: config.channelType,
            targetId,
            chunkIndex: i,
            err: err instanceof Error ? err.message : String(err),
          });
          return firstMessageId;
        }
      }
      return firstMessageId;
    },

    async setTyping(platformId: string, threadId: string | null): Promise<void> {
      if (!client || !client.isReady()) return;
      const decoded = decodePlatformId(platformId);
      if (!decoded) return;
      const targetId = threadId ?? decoded.legacyThreadId ?? decoded.channelId;
      try {
        const channel = await client.channels.fetch(targetId);
        if (channel && 'sendTyping' in channel) {
          await (channel as TextChannel | ThreadChannel | DMChannel).sendTyping();
        }
      } catch (err) {
        // Typing indicators are best-effort — never propagate.
        log.debug('Discord setTyping failed', {
          channelType: config.channelType,
          targetId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    },

    async subscribe(_platformId: string, threadId: string): Promise<void> {
      // No platform-side subscription required — Discord delivers every
      // MESSAGE_CREATE in channels the bot is in. v2 router consults
      // its own subscribed-threads ledger. We record the subscription
      // here for visibility in instrumentation, nothing more.
      subscribedThreads.add(threadId);
    },

    async openDM(userHandle: string): Promise<string> {
      if (!client || !client.isReady()) {
        throw new Error('Discord client not ready — cannot open DM');
      }
      const user = await client.users.fetch(userHandle);
      const dm = await user.createDM();
      // DMs have no guild — encode with `@me` so the format matches
      // both Chat-SDK Discord's convention and the inbound platform_id
      // emitted from MessageCreate on a DM channel.
      return encodePlatformId('@me', dm.id);
    },

    async teardown(): Promise<void> {
      if (client) {
        client.destroy();
        client = null;
        botUserId = '';
        log.info('Discord bot stopped', { channelType: config.channelType, label });
      }
      subscribedThreads.clear();
    },

    isConnected(): boolean {
      return client !== null && client.isReady();
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Env-driven self-registration
// ---------------------------------------------------------------------------

interface BotEnv {
  name: string;
  channelType: string;
  token: string;
  applicationId?: string;
  publicKey?: string;
}

function readBotsList(): string[] {
  const raw =
    process.env.DISCORD_BOTS_LIST ??
    readEnvFile(['DISCORD_BOTS_LIST']).DISCORD_BOTS_LIST ??
    '';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .filter((name) => {
      if (!VALID_BOT_NAME.test(name)) {
        log.warn('DISCORD_BOTS_LIST: dropping invalid bot name', { name });
        return false;
      }
      return true;
    });
}

function readBotEnv(name: string): BotEnv | null {
  const upper = name.toUpperCase();
  const keys = [
    `DISCORD_TOKEN_${upper}`,
    `DISCORD_APPLICATION_ID_${upper}`,
    `DISCORD_PUBLIC_KEY_${upper}`,
  ];
  const file = readEnvFile(keys);
  const token = process.env[keys[0]] ?? file[keys[0]];
  if (!token) return null;
  return {
    name,
    channelType: `discord-${name}`,
    token,
    applicationId: process.env[keys[1]] ?? file[keys[1]],
    publicKey: process.env[keys[2]] ?? file[keys[2]],
  };
}

function readLegacySingleBotEnv(): BotEnv | null {
  const keys = ['DISCORD_BOT_TOKEN', 'DISCORD_APPLICATION_ID', 'DISCORD_PUBLIC_KEY'];
  const file = readEnvFile(keys);
  const token = process.env.DISCORD_BOT_TOKEN ?? file.DISCORD_BOT_TOKEN;
  if (!token) return null;
  return {
    name: 'discord',
    channelType: 'discord',
    token,
    applicationId: process.env.DISCORD_APPLICATION_ID ?? file.DISCORD_APPLICATION_ID,
    publicKey: process.env.DISCORD_PUBLIC_KEY ?? file.DISCORD_PUBLIC_KEY,
  };
}

/**
 * Resolve the bot-env list applied at import time. Exposed for tests so
 * the env-resolution logic can be exercised without re-running the
 * self-registration side effect.
 */
export function resolveBotEnvs(): BotEnv[] {
  const names = readBotsList();
  if (names.length > 0) {
    const envs: BotEnv[] = [];
    for (const name of names) {
      const env = readBotEnv(name);
      if (!env) {
        log.warn('DISCORD_BOTS_LIST entry missing token, skipping', { name });
        continue;
      }
      envs.push(env);
    }
    return envs;
  }
  const legacy = readLegacySingleBotEnv();
  return legacy ? [legacy] : [];
}

// Self-register one adapter factory per resolved bot env. Each factory is
// a closure over the bot's BotEnv, so the v2 channel-registry can build
// adapters lazily after import-time registration. A factory returns null
// only when the captured token is empty at factory-call time — the env
// re-read here is the defence-in-depth check for tokens that arrive
// later via OneCLI vault injection.
for (const botEnv of resolveBotEnvs()) {
  registerChannelAdapter(botEnv.channelType, {
    factory: () => {
      if (!botEnv.token) return null;
      return createDiscordChannelAdapter({
        channelType: botEnv.channelType,
        botToken: botEnv.token,
        applicationId: botEnv.applicationId,
        publicKey: botEnv.publicKey,
        label: botEnv.name,
      });
    },
  });
}
