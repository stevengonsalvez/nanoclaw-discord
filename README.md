# @stevengonsalvez/nanoclaw-discord

Discord channel for NanoClaw — native ChannelAdapter with multi-bot (Option B) support.

## Status

Branch `port/v2-channeladapter` ships the **v2 native port**. Installs cleanly into vanilla NanoClaw v2 via the `/add-discord` skill in `skill/SKILL.md`. The v1 source remains on the `v1-source-extract` branch for archival reference.

See [MIGRATION.md](MIGRATION.md) for a contract-by-contract diff vs the v1 source.

## What this gives you

- **One Discord ChannelAdapter implementation** that registers itself with v2's `channel-registry` on import.
- **Multi-bot in one process** — set `DISCORD_BOTS_LIST=data,geordi` (and per-bot tokens) and you get two independent gateways under distinct `channelType`s (`discord-data` + `discord-geordi`). Both bots can live in the same Discord channel; v2's `messaging_groups` UNIQUE(channel_type, platform_id) keeps their wirings isolated.
- **Platform-confirmed `isMention`** — the adapter sets `isMention: true` for native bot mentions, DMs, and replies to the bot's own messages. v2's router uses this for `engage_mode='mention'` / `'mention-sticky'` instead of regex against agent-group names.
- **First-class thread support** — `threadId` flows alongside `platformId`; replies route into the originating thread.
- **All v1 content normalisations preserved** — `<@botId>` mention syntax stripping, `[Reply to X]` prefix, attachment placeholders.

## Single-bot install (legacy)

```bash
# In your nanoclaw checkout:
git fetch <this-repo> port/v2-channeladapter
git show <this-repo>/port/v2-channeladapter:src/channels/discord.ts > src/channels/discord.ts
printf "\nimport './discord.js';\n" >> src/channels/index.ts
pnpm install discord.js@^14.25.1
# Set env:
onecli set DISCORD_BOT_TOKEN <token>
pnpm run build
launchctl kickstart -k "gui/$(id -u)/com.nanoclaw"
```

The adapter registers under `channelType=discord`.

## Multi-bot install (Option B)

Same install steps, plus set per-bot env vars:

```bash
onecli set DISCORD_BOTS_LIST data,geordi
onecli set DISCORD_TOKEN_DATA <data bot token>
onecli set DISCORD_TOKEN_GEORDI <geordi bot token>
# Optional per-bot — only if you plan to verify interactions / register slash commands:
onecli set DISCORD_APPLICATION_ID_DATA <data app id>
onecli set DISCORD_APPLICATION_ID_GEORDI <geordi app id>
onecli set DISCORD_PUBLIC_KEY_DATA <data app public key>
onecli set DISCORD_PUBLIC_KEY_GEORDI <geordi app public key>
```

Each bot registers under `channelType=discord-<name>`. To wire `@Data` and `@Geordi` agent groups in v2:

```bash
ncl mg add --channel-type discord-data   --platform-id "discord:<guildId>:<channelId>" --name "Ops"
ncl mg add --channel-type discord-geordi --platform-id "discord:<guildId>:<channelId>" --name "Main"
ncl wire add --messaging-group <data-mg-id>   --agent-group <data-agent-group-id>   --engage-mode mention
ncl wire add --messaging-group <geordi-mg-id> --agent-group <geordi-agent-group-id> --engage-mode mention
```

Both wirings can target the **same Discord channel** — `messaging_groups` keys on `(channel_type, platform_id)`, so two rows with identical `platform_id` but distinct `channel_type` are fine. Each bot's gateway only sees its own `@`-mentions.

## platform_id encoding

| Source | `platformId` | `threadId` |
|---|---|---|
| Guild channel message | `discord:<guildId>:<channelId>` | `null` |
| Guild thread message | `discord:<guildId>:<channelId>` | `<discord thread id>` |
| DM | `discord:@me:<dmChannelId>` | `null` |

Legacy 4-part platformIds (`discord:<guildId>:<channelId>:<threadId>`) are accepted on `deliver()` for backward compatibility but never emitted by the adapter.

## Local development

```bash
pnpm install
pnpm typecheck
pnpm test        # 44 vitest specs
```

The stubs at `src/channels/adapter.ts`, `src/channels/channel-registry.ts`, `src/env.ts`, `src/log.ts` mirror the upstream nanoclaw shapes so this repo can typecheck and run tests standalone. They are NOT installed by the skill; only `src/channels/discord.ts` ships.

## License

MIT
