# v1 → v2 ChannelAdapter port — DONE

This document is the historical port checklist. The port is complete on branch `port/v2-channeladapter` and lives in `src/channels/discord.ts`. The summary below records what landed and how it differs from the v1 source preserved on the `v1-source-extract` branch.

## What landed

| Surface | v1 (fork) | v2 port |
|---|---|---|
| Contract | `Channel` (`connect / sendMessage / disconnect / isConnected / ownsJid / setTyping(jid, on)`) | `ChannelAdapter` (`setup / teardown / deliver / setTyping / subscribe / openDM / isConnected`) |
| Inbound delivery | `opts.onMessage(jid, msg)` + `opts.onChatMetadata(jid, ts, name, channelType, isGroup)` | `setup.onInbound(platformId, threadId, InboundMessage)` + `setup.onMetadata(platformId, name?, isGroup?)` |
| Trigger matching | Adapter-resident (`buildTriggerPattern` + mention/reply text rewrites) | Router-resident — adapter sets platform-confirmed `isMention: boolean` and forwards every non-bot message. v2 router's `engage_mode='mention'` / `'mention-sticky'` wirings consume `isMention` directly. |
| platform_id format | `dc:<channelId>` or per-bot `dc-<name>:<channelId>` | `discord:<guildId>:<channelId>` (4-part `discord:<guildId>:<channelId>:<threadId>` accepted for legacy compatibility on delivery). DMs use `discord:@me:<dmChannelId>`. |
| Thread support | Not modelled — channel-level only | First-class — `threadId` flows alongside `platformId` and `deliver()` routes through the thread. `supportsThreads: true`. |
| Multi-bot | `DISCORD_BOTS=name:token:trigger;…` env (single colon-delimited string) | `DISCORD_BOTS_LIST=name1,name2,…` + per-bot `DISCORD_TOKEN_<NAME>`, `DISCORD_APPLICATION_ID_<NAME>` (optional), `DISCORD_PUBLIC_KEY_<NAME>` (optional). Each bot self-registers under `channelType=discord-<name>`. Single-bot legacy fallback (`DISCORD_BOT_TOKEN`) registers under `channelType=discord`. |
| Multi-bot key insight | Each bot is its own `DiscordChannel` instance with a distinct `jidPrefix` to namespace JIDs | Each bot is its own `ChannelAdapter` instance with a distinct `channelType`. v2's `messaging_groups` UNIQUE(`channel_type`, `platform_id`) lets both bots share the same Discord channel (same `platform_id`) under different `channel_type`s — no JID-prefix games needed. |
| Trigger fix (`[Reply to X]` @-mention) | Cherry-picked into fork main as commit `87f6cef` | Moot — v2 router uses `isMention` not text regex. The reply prefix is still emitted in content (`[Reply to <Sender>] ...`) for prompt readability, but routing decisions don't depend on its position. |
| Bot token transport | OneCLI vault → process env → adapter | Same. The adapter reads `DISCORD_TOKEN_*` first from `process.env`, then from `.env` via `readEnvFile`. OneCLI injects at process spawn time. |

## Differences from MIGRATION.md draft

The original checklist had a few items the implementation diverged from. Recording them so future readers know the divergences are intentional:

1. **`supportsThreads` is `true` (not optional).** Discord ALWAYS supports threads; setting `true` unconditionally avoids router fallback paths that would strip the `threadId`.
2. **`openDM` is implemented.** The original checklist marked it as TBD. v2 wants it for cold DM initiation; the port wires through `client.users.fetch(id).createDM()` and encodes the result as `discord:@me:<dmId>`.
3. **`subscribe` is a no-op recorder.** Discord's Gateway delivers every `MESSAGE_CREATE` in channels the bot can see — there's no platform-side action to "subscribe" to a thread. The router holds its own subscribed-threads ledger; the adapter records subscribes in an in-memory `Set` purely for instrumentation visibility.
4. **No `start/stop` — `setup/teardown`.** The v2 contract in `upstream/main:src/channels/adapter.ts` uses `setup` and `teardown`, not the older `start`/`stop` names that appeared in early v2 drafts.
5. **Multi-bot env format.** Adopted `DISCORD_BOTS_LIST` + per-bot env vars (cleaner for OneCLI vault) rather than the fork's `DISCORD_BOTS=name:token:trigger;…` colon-delimited string. Legacy `DISCORD_BOT_TOKEN` fallback retained.
6. **Trigger name removed from per-bot config.** v1's `triggerName` was used to rewrite `@${triggerName} ` into the content. v2's router doesn't care about content for engagement — it uses `isMention`. So per-bot `trigger_name` is dropped. The agent group's display name (the v2 source-of-truth for what users type as `@Andy` / `@Data` / `@Geordi`) lives in `agent_groups.name` and the router resolves it there.

## Verifying the port

```bash
git checkout port/v2-channeladapter
pnpm install
pnpm typecheck   # tsc --noEmit must be clean
pnpm test        # 44/44 vitest specs green
```

## Installing into nanoclaw v2

The `/add-discord` skill at `skill/SKILL.md` walks an operator through:

1. Copy `src/channels/discord.ts` from this repo into the target nanoclaw tree at the same path.
2. Append `import './discord.js';` to `src/channels/index.ts` if not already present.
3. `pnpm install discord.js@^14.25.1`.
4. Capture per-bot env vars via OneCLI vault (`onecli set DISCORD_TOKEN_DATA …`).
5. `pnpm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`.

Note that the **stub files** in this repo (`src/channels/adapter.ts`, `src/channels/channel-registry.ts`, `src/env.ts`, `src/log.ts`) are NOT installed into nanoclaw — they exist purely so this repo can `tsc --noEmit` and `vitest run` against the same shape upstream provides. The skill copies only `src/channels/discord.ts` (and tests if requested).

## v1 archive

The v1 source remains on the `v1-source-extract` branch for reference. Don't delete that branch.
