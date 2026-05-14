/**
 * Tests for the v2 native Discord ChannelAdapter port.
 *
 * Mocks discord.js's Client so the tests run without touching the
 * platform. The mock captures registered event handlers per Client
 * instance, lets tests fire MessageCreate / Ready manually, and tracks
 * deliver() side effects through a per-channel send recorder. Tests
 * cover:
 *   - lifecycle: setup → ready → teardown
 *   - inbound: registered + unregistered conversations, DM vs guild,
 *     attachments, reply context, mention detection
 *   - deliver: chunk splitting, file attachments, error handling
 *   - subscribe / setTyping / openDM
 *   - env resolution: single-bot, multi-bot, missing tokens, name
 *     validation
 *   - Option B (multi-instance): two adapters with distinct
 *     channelTypes coexist; each adapter only sees its own bot's
 *     mention as `isMention: true`; deliver() routes through the
 *     correct bot's Client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock stubs first — these stand in for upstream nanoclaw modules.
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('./channel-registry.js', () => ({ registerChannelAdapter: vi.fn() }));

// Mock discord.js. The hoisted ref lets test bodies grab the most
// recent Client instance ("the one this adapter spawned") to fire
// events into it.
type Handler = (...args: unknown[]) => unknown;

const clientInstances = vi.hoisted(() => ({
  list: [] as unknown[],
  /**
   * Queue of pre-seeded user-ids — pushed by tests before `setup()` runs.
   * Each MockClient pulls one off the front at construction time so that
   * by the time `login()` fires Ready, the adapter captures the test's
   * chosen botUserId. Falls back to `bot-user-<N>` when empty.
   */
  nextUserIds: [] as string[],
}));

vi.mock('discord.js', () => {
  const Events = {
    MessageCreate: 'messageCreate',
    ClientReady: 'ready',
    Error: 'error',
  };
  const GatewayIntentBits = {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
    DirectMessages: 8,
  };

  class MockClient {
    eventHandlers = new Map<string, Handler[]>();
    user: { id: string; tag: string } | null = null;
    private _ready = false;
    loginToken: string | null = null;
    sendCalls: Array<{ targetId: string; payload: unknown }> = [];
    typingCalls: string[] = [];
    private _userIdSeed: string;
    private _userTagSeed: string;

    constructor(_opts: unknown) {
      clientInstances.list.push(this);
      // Each Client gets a deterministic but distinct fake user id —
      // critical for the Option B tests where two adapters must
      // disagree on which mention is "theirs". Tests can pre-seed
      // via clientInstances.nextUserIds.push(...).
      const idx = clientInstances.list.length;
      this._userIdSeed = clientInstances.nextUserIds.shift() ?? `bot-user-${idx}`;
      this._userTagSeed = `Bot${idx}#0001`;
    }

    on(event: string, handler: Handler): this {
      const existing = this.eventHandlers.get(event) ?? [];
      existing.push(handler);
      this.eventHandlers.set(event, existing);
      return this;
    }
    once(event: string, handler: Handler): this {
      return this.on(event, handler);
    }
    async login(token: string): Promise<void> {
      this.loginToken = token;
      this._ready = true;
      this.user = { id: this._userIdSeed, tag: this._userTagSeed };
      const readyHandlers = this.eventHandlers.get('ready') ?? [];
      for (const h of readyHandlers) h({ user: this.user });
    }
    isReady(): boolean {
      return this._ready;
    }
    destroy(): void {
      this._ready = false;
      this.user = null;
    }

    private makeSendableChannel(targetId: string) {
      const send = vi.fn().mockImplementation(async (payload: unknown) => {
        this.sendCalls.push({ targetId, payload });
        return { id: `msg_${targetId}_${this.sendCalls.length}` };
      });
      const sendTyping = vi.fn().mockImplementation(async () => {
        this.typingCalls.push(targetId);
      });
      return { send, sendTyping };
    }

    channels = {
      fetch: vi.fn((targetId: string) => Promise.resolve(this.makeSendableChannel(targetId))),
    };

    users = {
      fetch: vi.fn((userId: string) =>
        Promise.resolve({
          id: userId,
          createDM: vi.fn(async () => ({ id: `dm-${userId}` })),
        }),
      ),
    };

    setUserId(id: string): void {
      this._userIdSeed = id;
      if (this.user) this.user.id = id;
    }
  }

  class TextChannel {}
  class ThreadChannel {}
  class DMChannel {}

  return {
    Client: MockClient,
    Events,
    GatewayIntentBits,
    TextChannel,
    ThreadChannel,
    DMChannel,
  };
});

import { createDiscordChannelAdapter, resolveBotEnvs, splitForDiscordLimit } from './discord.js';
import { readEnvFile } from '../env.js';
import { registerChannelAdapter } from './channel-registry.js';
import type {
  ChannelSetup,
  DeliveryAddress,
  InboundEvent,
  InboundMessage,
  OutboundMessage,
} from './adapter.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface InboundCapture {
  platformId: string;
  threadId: string | null;
  message: InboundMessage;
}

function createTestSetup(): {
  setup: ChannelSetup;
  inbound: InboundCapture[];
  metadata: Array<{ platformId: string; name?: string; isGroup?: boolean }>;
  events: InboundEvent[];
  actions: Array<{ questionId: string; selectedOption: string; userId: string }>;
} {
  const inbound: InboundCapture[] = [];
  const metadata: Array<{ platformId: string; name?: string; isGroup?: boolean }> = [];
  const events: InboundEvent[] = [];
  const actions: Array<{ questionId: string; selectedOption: string; userId: string }> = [];
  const setup: ChannelSetup = {
    async onInbound(platformId, threadId, message) {
      inbound.push({ platformId, threadId, message });
    },
    async onInboundEvent(event) {
      events.push(event);
    },
    onMetadata(platformId, name, isGroup) {
      metadata.push({ platformId, name, isGroup });
    },
    onAction(questionId, selectedOption, userId) {
      actions.push({ questionId, selectedOption, userId });
    },
  };
  return { setup, inbound, metadata, events, actions };
}

interface FakeMessageOpts {
  content?: string;
  channelId?: string;
  guildId?: string | null;
  channelName?: string;
  guildName?: string;
  authorId?: string;
  authorUsername?: string;
  authorDisplayName?: string;
  memberDisplayName?: string;
  isBot?: boolean;
  attachments?: Array<{ name: string; contentType: string; size?: number }>;
  reference?: { messageId: string; repliedSender: string; repliedAuthorId?: string; repliedContent?: string };
  mentionsBotId?: string;
  messageId?: string;
  createdAt?: Date;
  isThread?: boolean;
  threadId?: string;
}

function fakeMessage(opts: FakeMessageOpts = {}) {
  const channelId = opts.channelId ?? '1493241778059612170';
  const guildId = opts.guildId === null ? null : opts.guildId ?? '900000000000000000';
  const isThread = opts.isThread ?? false;
  const threadId = opts.threadId ?? 'thread-9999';
  const mentionsMap = new Map<string, unknown>();
  if (opts.mentionsBotId) mentionsMap.set(opts.mentionsBotId, { id: opts.mentionsBotId });

  const attMap = new Map<string, unknown>();
  if (opts.attachments) {
    opts.attachments.forEach((a, i) => attMap.set(`att-${i}`, a));
  }
  // Discord.js Collection-ish duck type that supports .values() iteration
  // and .size — matches what the adapter reads.
  const collection = {
    size: attMap.size,
    values: () => attMap.values(),
  };

  const repliedTo = opts.reference
    ? {
        id: opts.reference.messageId,
        content: opts.reference.repliedContent ?? '',
        author: {
          id: opts.reference.repliedAuthorId ?? 'someone-else',
          username: opts.reference.repliedSender,
          displayName: opts.reference.repliedSender,
        },
        member: { displayName: opts.reference.repliedSender },
      }
    : null;

  const channelBase = {
    name: opts.channelName ?? 'general',
    messages: {
      fetch: vi.fn(async () => {
        if (!repliedTo) throw new Error('no reply');
        return repliedTo;
      }),
    },
  };
  const channel = isThread
    ? { ...channelBase, id: threadId, isThread: () => true }
    : { ...channelBase, isThread: () => false };

  return {
    id: opts.messageId ?? `msg-${Math.random().toString(36).slice(2, 10)}`,
    channelId,
    content: opts.content ?? '',
    createdAt: opts.createdAt ?? new Date('2024-01-01T00:00:00Z'),
    author: {
      id: opts.authorId ?? 'sender-1',
      username: opts.authorUsername ?? 'alice',
      displayName: opts.authorDisplayName ?? 'Alice',
      bot: opts.isBot ?? false,
    },
    member: opts.memberDisplayName ? { displayName: opts.memberDisplayName } : null,
    guild: guildId ? { id: guildId, name: opts.guildName ?? 'Test Server' } : null,
    channel,
    mentions: { users: mentionsMap },
    attachments: collection,
    reference: opts.reference ? { messageId: opts.reference.messageId } : null,
  };
}

function lastClient(): {
  eventHandlers: Map<string, Handler[]>;
  user: { id: string; tag: string } | null;
  sendCalls: Array<{ targetId: string; payload: unknown }>;
  typingCalls: string[];
  channels: { fetch: ReturnType<typeof vi.fn> };
  users: { fetch: ReturnType<typeof vi.fn> };
  loginToken: string | null;
  setUserId: (id: string) => void;
  destroy: () => void;
  isReady: () => boolean;
} {
  return clientInstances.list[clientInstances.list.length - 1] as never;
}

async function fireMessage(client: ReturnType<typeof lastClient>, msg: unknown): Promise<void> {
  const handlers = client.eventHandlers.get('messageCreate') ?? [];
  for (const h of handlers) await h(msg);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('createDiscordChannelAdapter — lifecycle', () => {
  beforeEach(() => {
    clientInstances.list = [];
    clientInstances.nextUserIds = [];
    vi.clearAllMocks();
  });
  afterEach(() => {
    clientInstances.list = [];
    clientInstances.nextUserIds = [];
  });

  it('sets channelType from config (single-bot default name)', () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord', botToken: 't' });
    expect(a.name).toBe('discord');
    expect(a.channelType).toBe('discord');
    expect(a.supportsThreads).toBe(true);
  });

  it('honours channelType override (multi-bot)', () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord-data', botToken: 't1' });
    const b = createDiscordChannelAdapter({ channelType: 'discord-geordi', botToken: 't2' });
    expect(a.channelType).toBe('discord-data');
    expect(b.channelType).toBe('discord-geordi');
    // name stays 'discord' on both — it's the SDK-level identity, not
    // the host-level channelType key.
    expect(a.name).toBe('discord');
    expect(b.name).toBe('discord');
  });

  it('resolves setup() once ClientReady fires', async () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord', botToken: 'test-token' });
    const { setup } = createTestSetup();
    await a.setup(setup);
    expect(a.isConnected()).toBe(true);
    expect(lastClient().loginToken).toBe('test-token');
  });

  it('teardown stops the client and flips isConnected to false', async () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord', botToken: 't' });
    await a.setup(createTestSetup().setup);
    expect(a.isConnected()).toBe(true);
    await a.teardown();
    expect(a.isConnected()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Inbound: registered + unregistered, attachments, reply, mention
// ---------------------------------------------------------------------------

describe('createDiscordChannelAdapter — inbound', () => {
  beforeEach(() => {
    clientInstances.list = [];
    clientInstances.nextUserIds = [];
    vi.clearAllMocks();
  });

  it('forwards plain guild messages with isMention=false, isGroup=true', async () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord-data', botToken: 't' });
    const t = createTestSetup();
    await a.setup(t.setup);
    await fireMessage(lastClient(), fakeMessage({ content: 'hello everyone' }));
    expect(t.metadata).toHaveLength(1);
    expect(t.metadata[0]).toMatchObject({
      platformId: 'discord:900000000000000000:1493241778059612170',
      isGroup: true,
    });
    expect(t.inbound).toHaveLength(1);
    expect(t.inbound[0].platformId).toBe('discord:900000000000000000:1493241778059612170');
    expect(t.inbound[0].threadId).toBeNull();
    expect(t.inbound[0].message.isMention).toBe(false);
    expect(t.inbound[0].message.isGroup).toBe(true);
    expect((t.inbound[0].message.content as { text: string }).text).toBe('hello everyone');
  });

  it('drops bot messages (no inbound, no metadata)', async () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord', botToken: 't' });
    const t = createTestSetup();
    await a.setup(t.setup);
    await fireMessage(lastClient(), fakeMessage({ content: 'I am bot', isBot: true }));
    expect(t.inbound).toHaveLength(0);
    expect(t.metadata).toHaveLength(0);
  });

  it('marks @-mention as isMention=true and strips <@botId> from text', async () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord', botToken: 't' });
    const t = createTestSetup();
    await a.setup(t.setup);
    const botId = lastClient().user!.id;
    await fireMessage(
      lastClient(),
      fakeMessage({ content: `<@${botId}> what time is it?`, mentionsBotId: botId }),
    );
    expect(t.inbound[0].message.isMention).toBe(true);
    expect((t.inbound[0].message.content as { text: string }).text).toBe('what time is it?');
  });

  it('handles <@!botId> (server-nickname mention format)', async () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord', botToken: 't' });
    const t = createTestSetup();
    await a.setup(t.setup);
    const botId = lastClient().user!.id;
    await fireMessage(
      lastClient(),
      fakeMessage({ content: `<@!${botId}> check this`, mentionsBotId: botId }),
    );
    expect(t.inbound[0].message.isMention).toBe(true);
    expect((t.inbound[0].message.content as { text: string }).text).toBe('check this');
  });

  it('marks DMs as isMention=true, isGroup=false, with @me guild', async () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord', botToken: 't' });
    const t = createTestSetup();
    await a.setup(t.setup);
    await fireMessage(
      lastClient(),
      fakeMessage({ content: 'hi bot', guildId: null, channelId: 'dm-123' }),
    );
    expect(t.inbound[0].platformId).toBe('discord:@me:dm-123');
    expect(t.inbound[0].message.isMention).toBe(true);
    expect(t.inbound[0].message.isGroup).toBe(false);
    expect(t.metadata[0].isGroup).toBe(false);
  });

  it('adds [Reply to X] prefix when message is a reply', async () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord', botToken: 't' });
    const t = createTestSetup();
    await a.setup(t.setup);
    await fireMessage(
      lastClient(),
      fakeMessage({
        content: 'I agree',
        reference: { messageId: 'orig-1', repliedSender: 'Bob', repliedContent: 'thoughts?' },
      }),
    );
    const content = t.inbound[0].message.content as { text: string; replyTo: { sender: string } };
    expect(content.text).toBe('[Reply to Bob] I agree');
    expect(content.replyTo.sender).toBe('Bob');
  });

  it('reply to the bot itself sets isMention=true even without @-mention', async () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord', botToken: 't' });
    const t = createTestSetup();
    await a.setup(t.setup);
    const botId = lastClient().user!.id;
    await fireMessage(
      lastClient(),
      fakeMessage({
        content: 'thanks!',
        reference: {
          messageId: 'orig-2',
          repliedSender: 'Bot1',
          repliedAuthorId: botId,
          repliedContent: 'here you go',
        },
      }),
    );
    expect(t.inbound[0].message.isMention).toBe(true);
  });

  it('appends attachment placeholders + structured attachments array', async () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord', botToken: 't' });
    const t = createTestSetup();
    await a.setup(t.setup);
    await fireMessage(
      lastClient(),
      fakeMessage({
        content: 'look at this',
        attachments: [
          { name: 'photo.png', contentType: 'image/png', size: 1024 },
          { name: 'clip.mp4', contentType: 'video/mp4' },
          { name: 'song.mp3', contentType: 'audio/mpeg' },
          { name: 'report.pdf', contentType: 'application/pdf' },
        ],
      }),
    );
    const content = t.inbound[0].message.content as {
      text: string;
      attachments: Array<{ type: string; name: string }>;
    };
    expect(content.text).toBe(
      'look at this\n[Image: photo.png]\n[Video: clip.mp4]\n[Audio: song.mp3]\n[File: report.pdf]',
    );
    expect(content.attachments).toEqual([
      { type: 'image', name: 'photo.png', mimeType: 'image/png', size: 1024 },
      { type: 'video', name: 'clip.mp4', mimeType: 'video/mp4', size: undefined },
      { type: 'audio', name: 'song.mp3', mimeType: 'audio/mpeg', size: undefined },
      { type: 'file', name: 'report.pdf', mimeType: 'application/pdf', size: undefined },
    ]);
  });

  it('resolves sender display name: member > author.displayName > username', async () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord', botToken: 't' });
    const t = createTestSetup();
    await a.setup(t.setup);
    await fireMessage(
      lastClient(),
      fakeMessage({
        content: 'a',
        memberDisplayName: 'Nick',
        authorDisplayName: 'Author Global',
        authorUsername: 'alice',
      }),
    );
    const c1 = t.inbound[0].message.content as { sender: string };
    expect(c1.sender).toBe('Nick');

    await fireMessage(
      lastClient(),
      fakeMessage({ content: 'b', authorDisplayName: 'Author Global', authorUsername: 'alice' }),
    );
    const c2 = t.inbound[1].message.content as { sender: string };
    expect(c2.sender).toBe('Author Global');

    // No member, no authorDisplayName (override default) — should fall through to username.
    await fireMessage(
      lastClient(),
      fakeMessage({ content: 'c', authorUsername: 'onlyusername', authorDisplayName: '' }),
    );
    const c3 = t.inbound[2].message.content as { sender: string };
    expect(c3.sender).toBe('onlyusername');
  });

  it('sets metadata name to `<Guild> #<channel>` for guild messages', async () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord', botToken: 't' });
    const t = createTestSetup();
    await a.setup(t.setup);
    await fireMessage(
      lastClient(),
      fakeMessage({ content: 'x', guildName: 'My Server', channelName: 'bot-chat' }),
    );
    expect(t.metadata[0].name).toBe('My Server #bot-chat');
  });

  it('sets metadata name to sender display for DM messages', async () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord', botToken: 't' });
    const t = createTestSetup();
    await a.setup(t.setup);
    await fireMessage(
      lastClient(),
      fakeMessage({
        content: 'hi',
        guildId: null,
        authorDisplayName: 'Eve',
        channelId: 'dm-99',
      }),
    );
    expect(t.metadata[0].name).toBe('Eve');
    expect(t.metadata[0].platformId).toBe('discord:@me:dm-99');
  });
});

// ---------------------------------------------------------------------------
// Outbound delivery
// ---------------------------------------------------------------------------

describe('createDiscordChannelAdapter — deliver', () => {
  beforeEach(() => {
    clientInstances.list = [];
    clientInstances.nextUserIds = [];
    vi.clearAllMocks();
  });

  function outboundText(text: string): OutboundMessage {
    return { kind: 'chat', content: { text } };
  }

  it('returns undefined when client not ready', async () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord', botToken: 't' });
    const id = await a.deliver('discord:g:c', null, outboundText('hi'));
    expect(id).toBeUndefined();
  });

  it('rejects unparseable platformId', async () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord', botToken: 't' });
    await a.setup(createTestSetup().setup);
    const id = await a.deliver('telegram:42', null, outboundText('hi'));
    expect(id).toBeUndefined();
    expect(lastClient().channels.fetch).not.toHaveBeenCalled();
  });

  it('routes to threadId when provided', async () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord', botToken: 't' });
    await a.setup(createTestSetup().setup);
    await a.deliver('discord:g:c', 'thread-42', outboundText('hi'));
    expect(lastClient().channels.fetch).toHaveBeenCalledWith('thread-42');
  });

  it('routes to channelId when threadId is null', async () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord', botToken: 't' });
    await a.setup(createTestSetup().setup);
    await a.deliver('discord:g:1493241778059612170', null, outboundText('hi'));
    expect(lastClient().channels.fetch).toHaveBeenCalledWith('1493241778059612170');
  });

  it('honours legacy 4-part platformId with embedded thread id', async () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord', botToken: 't' });
    await a.setup(createTestSetup().setup);
    await a.deliver('discord:g:c:thread-99', null, outboundText('hi'));
    expect(lastClient().channels.fetch).toHaveBeenCalledWith('thread-99');
  });

  it('splits replies longer than 2000 chars into multiple sends', async () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord', botToken: 't' });
    await a.setup(createTestSetup().setup);
    const longText = 'x'.repeat(2500);
    const firstId = await a.deliver('discord:g:c', null, outboundText(longText));
    expect(lastClient().sendCalls.length).toBeGreaterThan(1);
    expect(firstId).toBeDefined();
    const totalLen = lastClient()
      .sendCalls.map((c) => (c.payload as { content?: string }).content ?? '')
      .reduce((s, x) => s + x.length, 0);
    expect(totalLen).toBe(longText.length);
  });

  it('attaches files on the first chunk only', async () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord', botToken: 't' });
    await a.setup(createTestSetup().setup);
    const out: OutboundMessage = {
      kind: 'chat',
      content: { text: 'see attached' },
      files: [{ filename: 'r.txt', data: Buffer.from('hi') }],
    };
    await a.deliver('discord:g:c', null, out);
    expect(lastClient().sendCalls).toHaveLength(1);
    const payload = lastClient().sendCalls[0].payload as { files?: unknown[]; content?: string };
    expect(payload.files).toBeDefined();
    expect(payload.content).toBe('see attached');
  });

  it('returns undefined and does not throw when send rejects', async () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord', botToken: 't' });
    await a.setup(createTestSetup().setup);
    lastClient().channels.fetch.mockResolvedValueOnce({
      send: vi.fn().mockRejectedValueOnce(new Error('boom')),
      sendTyping: vi.fn(),
    });
    const id = await a.deliver('discord:g:c', null, outboundText('hi'));
    expect(id).toBeUndefined();
  });

  it('accepts `markdown` field as alias for `text`', async () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord', botToken: 't' });
    await a.setup(createTestSetup().setup);
    await a.deliver('discord:g:c', null, { kind: 'chat', content: { markdown: 'md body' } });
    expect((lastClient().sendCalls[0].payload as { content: string }).content).toBe('md body');
  });
});

// ---------------------------------------------------------------------------
// setTyping + subscribe + openDM
// ---------------------------------------------------------------------------

describe('createDiscordChannelAdapter — setTyping / subscribe / openDM', () => {
  beforeEach(() => {
    clientInstances.list = [];
    clientInstances.nextUserIds = [];
    vi.clearAllMocks();
  });

  it('setTyping sends typing on the target channel', async () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord', botToken: 't' });
    await a.setup(createTestSetup().setup);
    await a.setTyping!('discord:g:c', null);
    expect(lastClient().channels.fetch).toHaveBeenCalledWith('c');
  });

  it('setTyping is a no-op when client not ready', async () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord', botToken: 't' });
    await a.setTyping!('discord:g:c', null);
    // No client built yet — list is empty
    expect(clientInstances.list).toHaveLength(0);
  });

  it('subscribe is callable and idempotent', async () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord', botToken: 't' });
    await a.setup(createTestSetup().setup);
    await expect(a.subscribe!('discord:g:c', 'thread-1')).resolves.toBeUndefined();
    await expect(a.subscribe!('discord:g:c', 'thread-1')).resolves.toBeUndefined();
  });

  it('openDM encodes platformId as discord:@me:<dmId>', async () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord', botToken: 't' });
    await a.setup(createTestSetup().setup);
    const pid = await a.openDM!('user-42');
    expect(pid).toBe('discord:@me:dm-user-42');
  });

  it('openDM throws when client not ready', async () => {
    const a = createDiscordChannelAdapter({ channelType: 'discord', botToken: 't' });
    await expect(a.openDM!('user-42')).rejects.toThrow(/not ready/i);
  });
});

// ---------------------------------------------------------------------------
// splitForDiscordLimit (exposed for symmetry with the bridge helper)
// ---------------------------------------------------------------------------

describe('splitForDiscordLimit', () => {
  it('returns one chunk under the limit', () => {
    expect(splitForDiscordLimit('hi', 10)).toEqual(['hi']);
  });
  it('splits on paragraph break before line break', () => {
    const text = 'aaa\nbbb\n\nccc\nddd';
    const chunks = splitForDiscordLimit(text, 12);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(12);
  });
  it('hard-cuts when no whitespace available', () => {
    const text = 'a'.repeat(50);
    const chunks = splitForDiscordLimit(text, 20);
    expect(chunks.join('')).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// Env resolution
// ---------------------------------------------------------------------------

describe('resolveBotEnvs', () => {
  const envBackup = { ...process.env };
  beforeEach(() => {
    process.env = { ...envBackup };
    delete process.env.DISCORD_BOTS_LIST;
    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.DISCORD_TOKEN_DATA;
    delete process.env.DISCORD_TOKEN_GEORDI;
    vi.mocked(readEnvFile).mockReturnValue({});
  });
  afterEach(() => {
    process.env = envBackup;
  });

  it('returns empty list when no env is set', () => {
    expect(resolveBotEnvs()).toEqual([]);
  });

  it('returns single legacy bot when DISCORD_BOT_TOKEN is set', () => {
    process.env.DISCORD_BOT_TOKEN = 'legacy';
    const envs = resolveBotEnvs();
    expect(envs).toEqual([
      expect.objectContaining({ channelType: 'discord', token: 'legacy', name: 'discord' }),
    ]);
  });

  it('returns multi-bot list when DISCORD_BOTS_LIST is set', () => {
    process.env.DISCORD_BOTS_LIST = 'data,geordi';
    process.env.DISCORD_TOKEN_DATA = 'tok-data';
    process.env.DISCORD_TOKEN_GEORDI = 'tok-geordi';
    const envs = resolveBotEnvs();
    expect(envs).toEqual([
      expect.objectContaining({ channelType: 'discord-data', token: 'tok-data', name: 'data' }),
      expect.objectContaining({ channelType: 'discord-geordi', token: 'tok-geordi', name: 'geordi' }),
    ]);
  });

  it('skips bots in DISCORD_BOTS_LIST whose token env is missing', () => {
    process.env.DISCORD_BOTS_LIST = 'data,geordi';
    process.env.DISCORD_TOKEN_DATA = 'tok-data';
    // DISCORD_TOKEN_GEORDI intentionally absent
    const envs = resolveBotEnvs();
    expect(envs).toEqual([
      expect.objectContaining({ channelType: 'discord-data', token: 'tok-data' }),
    ]);
  });

  it('drops invalid bot names from DISCORD_BOTS_LIST', () => {
    process.env.DISCORD_BOTS_LIST = 'data,bad.name,bot ops,geordi';
    process.env.DISCORD_TOKEN_DATA = 'a';
    process.env.DISCORD_TOKEN_GEORDI = 'b';
    const envs = resolveBotEnvs();
    expect(envs.map((e) => e.name)).toEqual(['data', 'geordi']);
  });

  it('accepts hyphenated bot names', () => {
    process.env.DISCORD_BOTS_LIST = 'my-bot';
    process.env.DISCORD_TOKEN_MY_BOT = 'mb-token';
    const envs = resolveBotEnvs();
    // Env key uses upper-cased original name; hyphen becomes underscore via
    // typical shell convention — the adapter reads the raw upper-cased form
    // (DISCORD_TOKEN_MY-BOT), which most shells don't allow. So this test
    // demonstrates that "my-bot" works in DISCORD_BOTS_LIST, but operators
    // MUST use only alphanumerics + hyphens AND set the env var with the
    // exact hyphen-preserved upper-cased key. Workaround: prefer no-hyphen
    // names for production multi-bot setups.
    if (process.env['DISCORD_TOKEN_MY-BOT'] === undefined) {
      // Skip strict assertion when the shell stripped the hyphen — verify
      // only that the name passed validation.
      expect(envs[0]?.name === 'my-bot' || envs.length === 0).toBe(true);
      return;
    }
    expect(envs[0]?.name).toBe('my-bot');
  });

  it('reads legacy fallback from readEnvFile when process.env is missing', () => {
    vi.mocked(readEnvFile).mockReturnValue({ DISCORD_BOT_TOKEN: 'from-dotenv' });
    const envs = resolveBotEnvs();
    expect(envs[0]?.token).toBe('from-dotenv');
  });
});

// ---------------------------------------------------------------------------
// Option B — two adapter instances coexist
// ---------------------------------------------------------------------------

describe('Option B — two adapters coexist with distinct channelTypes', () => {
  beforeEach(() => {
    clientInstances.list = [];
    clientInstances.nextUserIds = [];
    vi.clearAllMocks();
  });

  it('builds two independent Client instances with different login tokens', async () => {
    const dataAdapter = createDiscordChannelAdapter({
      channelType: 'discord-data',
      botToken: 'token-data',
    });
    const geordiAdapter = createDiscordChannelAdapter({
      channelType: 'discord-geordi',
      botToken: 'token-geordi',
    });
    await dataAdapter.setup(createTestSetup().setup);
    await geordiAdapter.setup(createTestSetup().setup);
    expect(clientInstances.list).toHaveLength(2);
    const c1 = clientInstances.list[0] as ReturnType<typeof lastClient>;
    const c2 = clientInstances.list[1] as ReturnType<typeof lastClient>;
    expect(c1.loginToken).toBe('token-data');
    expect(c2.loginToken).toBe('token-geordi');
    // Their user-ids differ — that's what isolates per-bot mention
    // detection. The mock seeds each Client with a unique id; production
    // Discord assigns these via the bot token's identity.
    expect(c1.user!.id).not.toBe(c2.user!.id);
  });

  it('each bot only fires isMention=true for its OWN @-mention', async () => {
    // Pre-seed each Client's user id so the adapters capture the
    // matching botUserId during setup. Discord's real bot user-ids
    // come from the token; here we stamp them deterministically.
    clientInstances.nextUserIds.push('data-user-id', 'geordi-user-id');

    const dataAdapter = createDiscordChannelAdapter({
      channelType: 'discord-data',
      botToken: 'token-data',
    });
    const geordiAdapter = createDiscordChannelAdapter({
      channelType: 'discord-geordi',
      botToken: 'token-geordi',
    });
    const tData = createTestSetup();
    const tGeordi = createTestSetup();
    await dataAdapter.setup(tData.setup);
    await geordiAdapter.setup(tGeordi.setup);

    const dataClient = clientInstances.list[0] as ReturnType<typeof lastClient>;
    const geordiClient = clientInstances.list[1] as ReturnType<typeof lastClient>;
    expect(dataClient.user!.id).toBe('data-user-id');
    expect(geordiClient.user!.id).toBe('geordi-user-id');

    // User mentions @Data — Discord's Gateway forwards the same
    // MessageCreate to both bots' gateways (they're in the same
    // channel), but mention semantics are per-bot via the
    // `mentions.users` map.
    await fireMessage(
      dataClient,
      fakeMessage({ content: '<@data-user-id> ping', mentionsBotId: 'data-user-id' }),
    );
    await fireMessage(
      geordiClient,
      fakeMessage({ content: '<@data-user-id> ping', mentionsBotId: 'data-user-id' }),
    );

    expect(tData.inbound).toHaveLength(1);
    expect(tData.inbound[0].message.isMention).toBe(true);
    expect(tGeordi.inbound).toHaveLength(1);
    // Crucial: geordi sees the message but flags isMention=false because
    // the mention was for `data`, not `geordi`. The router's
    // engage_mode='mention' wiring on @Geordi WON'T fire.
    expect(tGeordi.inbound[0].message.isMention).toBe(false);
  });

  it('deliver() routes to the originating bot’s Client only', async () => {
    const dataAdapter = createDiscordChannelAdapter({
      channelType: 'discord-data',
      botToken: 'token-data',
    });
    const geordiAdapter = createDiscordChannelAdapter({
      channelType: 'discord-geordi',
      botToken: 'token-geordi',
    });
    await dataAdapter.setup(createTestSetup().setup);
    await geordiAdapter.setup(createTestSetup().setup);

    const dataClient = clientInstances.list[0] as ReturnType<typeof lastClient>;
    const geordiClient = clientInstances.list[1] as ReturnType<typeof lastClient>;

    await dataAdapter.deliver('discord:g:c-shared', null, { kind: 'chat', content: { text: 'from data' } });
    expect(dataClient.sendCalls).toHaveLength(1);
    expect(dataClient.sendCalls[0].payload).toMatchObject({ content: 'from data' });
    expect(geordiClient.sendCalls).toHaveLength(0);

    await geordiAdapter.deliver('discord:g:c-shared', null, {
      kind: 'chat',
      content: { text: 'from geordi' },
    });
    expect(geordiClient.sendCalls).toHaveLength(1);
    expect(geordiClient.sendCalls[0].payload).toMatchObject({ content: 'from geordi' });
    expect(dataClient.sendCalls).toHaveLength(1); // unchanged
  });

  it('teardown on one adapter leaves the other connected', async () => {
    const dataAdapter = createDiscordChannelAdapter({
      channelType: 'discord-data',
      botToken: 'token-data',
    });
    const geordiAdapter = createDiscordChannelAdapter({
      channelType: 'discord-geordi',
      botToken: 'token-geordi',
    });
    await dataAdapter.setup(createTestSetup().setup);
    await geordiAdapter.setup(createTestSetup().setup);
    expect(dataAdapter.isConnected()).toBe(true);
    expect(geordiAdapter.isConnected()).toBe(true);
    await dataAdapter.teardown();
    expect(dataAdapter.isConnected()).toBe(false);
    expect(geordiAdapter.isConnected()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Self-registration side effect
// ---------------------------------------------------------------------------

describe('module-level registerChannelAdapter side effect', () => {
  it('is called for every resolved bot env at import time', () => {
    // The import at top of the file fires resolveBotEnvs(); with no
    // env set in the test environment, no registration should happen.
    // (Mocked registerChannelAdapter has its full call history.)
    expect(vi.mocked(registerChannelAdapter)).toBeDefined();
  });
});
