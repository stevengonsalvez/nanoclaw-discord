# v1 → v2 ChannelAdapter port

The v1 `discord.ts` here uses fork's `Channel` interface. v2's `ChannelAdapter` is a different shape. This file is the checklist for porting.

## What changes

### v1 (fork) channel surface

```ts
// fork: src/channels/discord.ts
import { registerChannel, ChannelOpts } from './registry.js';
import { ASSISTANT_NAME, buildTriggerPattern } from '../config.js';
import { Channel, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

registerChannel({ name: 'discord', ... });
```

The v1 channel:
- Owns trigger-matching (`buildTriggerPattern` injected per group)
- Receives `OnInboundMessage(jid, sender, content, ...)` callbacks
- Tracks registered groups itself
- Knows about `ASSISTANT_NAME`

### v2 (upstream) channel surface

```ts
// v2: src/channels/adapter.ts
export interface ChannelSetup {
  onInbound(platformId: string, threadId: string | null, message: InboundMessage): void | Promise<void>;
  onInboundEvent(event: InboundEvent): void | Promise<void>;
  onMetadata(platformId: string, name?: string, isGroup?: boolean): void;
  onAction(questionId: string, selectedOption: string, userId: string): void;
}

export interface ChannelAdapter {
  channelType: string;
  start(setup: ChannelSetup): Promise<void>;
  stop(): Promise<void>;
  deliver(platformId: string, threadId: string | null, content: string): Promise<{ messageId?: string }>;
  setTyping?(platformId: string, threadId: string | null, on: boolean): Promise<void>;
  subscribe?(platformId: string, threadId: string): Promise<void>;
  supportsThreads?: boolean;
}
```

The v2 channel:
- Does NOT trigger-match (router layer handles it)
- Returns platform message IDs from `deliver` for threading
- Implements `setTyping` (typing indicator)
- Implements `subscribe` (post-engagement thread tracking)
- Distinguishes `onInbound` (chat) from `onInboundEvent` (admin transport routing)
- Handles `onAction` (button-click responses from interactive cards)

## Port checklist

When porting `src/channels/discord.ts` (v1) to a v2 `ChannelAdapter`:

- [ ] Strip `buildTriggerPattern` / `ASSISTANT_NAME` imports — router handles triggers in v2.
- [ ] Replace `registerChannel({ name, ... })` with `export const discordAdapter: ChannelAdapter = { channelType: 'discord', ... }` and register via `channels/channel-registry.ts`.
- [ ] Map Discord events to v2's `InboundEvent`:
  - `channelType: 'discord'`
  - `platformId: \`discord:${guildId}:${channelId}\`` (or DM equivalent)
  - `threadId: <discord thread ID if applicable, else null>`
  - `message.id: <Discord message snowflake>`
  - `message.isMention: <true if bot was @mentioned via discord.js native detection>` ← important for v2's mention-sticky engagement
  - `message.isGroup: <true for guild channels, false for DMs>`
- [ ] Implement `deliver(platformId, threadId, content)` — parse platformId back to guild/channel, send via discord.js, return the platform message ID so v2 stores it in the `delivered` table.
- [ ] Implement `setTyping` — use Discord's typing indicator API.
- [ ] Implement `subscribe` — record thread subscription so subsequent messages in that thread arrive as inbound without needing @mention.
- [ ] Multi-bot support: v2 already has provider abstraction; check whether multi-bot lives at the adapter layer (one adapter, many tokens) or as separate adapter instances (cleaner). Recommended: instance-per-bot.
- [ ] Token handling: pull from OneCLI gateway (same as v1) — no token in the container.
- [ ] Discord reply-to prefix bug: fork's v1 trigger regex didn't match `[Reply to X] @Data ...`. v2 router does message normalization differently — verify the v2 router handles this correctly before considering this resolved.
- [ ] Update tests: v2 channel adapters are typically integration-tested via a fake `ChannelSetup` callback target, not the v1 in-process group registry.

## Reference

v2 example channels live at:
- `src/channels/cli.ts` — minimal native adapter (Unix socket).
- `src/channels/chat-sdk-bridge.ts` — generic Chat SDK adapter wrapper.

Read these first before porting.

## Timing

Suggested order:
1. Stevie creates `github.com/stevengonsalvez/nanoclaw-discord` (empty).
2. Push this v1 source as `v0.1.0-v1` tag.
3. Open a `v2` branch and port using the checklist above.
4. Tag `v1.0.0-v2` when port lands and integrates with vanilla NanoClaw v2.
