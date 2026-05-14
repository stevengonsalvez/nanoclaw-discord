---
name: add-discord
description: Add Discord bot channel integration to NanoClaw v2 (native ChannelAdapter + multi-bot Option B).
---

# Add Discord Channel (NanoClaw v2)

Adds Discord support to NanoClaw v2. Supports single-bot (legacy `DISCORD_BOT_TOKEN`) and multi-bot Option B (`DISCORD_BOTS_LIST` + per-bot env). Each bot registers under its own `channelType`, so two bots can coexist in the same Discord channel without JID-prefix games.

## Phase 1 — Pre-flight (idempotent)

Skip to **Phase 3** if all of these are already in place:

- `src/channels/discord.ts` exists in the target nanoclaw checkout
- `src/channels/index.ts` contains `import './discord.js';`
- `discord.js` (≥ 14.25.1) is in `package.json` dependencies
- For multi-bot: `DISCORD_BOTS_LIST` is set in OneCLI vault and matches `DISCORD_TOKEN_<NAME>` entries

Otherwise continue.

Ask the user via `AskUserQuestion`:

> Will you run one bot or multiple? If multiple, please confirm the short names (e.g., `data`, `geordi`).

Capture the answer — it determines which env vars to set in Phase 3.

## Phase 2 — Apply code

### 2.1 Fetch the port

```bash
git fetch https://github.com/stevengonsalvez/nanoclaw-discord.git port/v2-channeladapter:refs/remotes/discord-port/port-v2
```

### 2.2 Copy the adapter into the target tree

```bash
git show discord-port/port-v2:src/channels/discord.ts > src/channels/discord.ts
```

### 2.3 Append the self-registration import

If not already present, append to `src/channels/index.ts`:

```typescript
import './discord.js';
```

### 2.4 Install the discord.js dependency (pinned)

```bash
pnpm install discord.js@^14.25.1
```

### 2.5 Build

```bash
pnpm run build
```

## Phase 3 — Credentials

### 3.1 Create the Discord bot(s)

For each bot, tell the user:

> 1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
> 2. Click **New Application**, name it (e.g., `Data`, `Geordi`)
> 3. Under **Bot** tab: click **Reset Token** and copy it (one-time view)
> 4. Enable **Privileged Gateway Intents** → **Message Content Intent**
> 5. Under **OAuth2 → URL Generator**:
>    - Scopes: `bot`
>    - Bot Permissions: `Send Messages`, `Read Message History`, `View Channels`
>    - Open the generated URL to invite the bot to your server

Wait for tokens.

### 3.2 Single-bot configuration

```bash
onecli set DISCORD_BOT_TOKEN <token>
# Optional (only if you'll register slash commands or verify interaction webhooks):
onecli set DISCORD_APPLICATION_ID <app-id>
onecli set DISCORD_PUBLIC_KEY <public-key>
```

The adapter will register under `channelType=discord`.

### 3.3 Multi-bot configuration (Option B)

```bash
onecli set DISCORD_BOTS_LIST data,geordi
onecli set DISCORD_TOKEN_DATA <data token>
onecli set DISCORD_TOKEN_GEORDI <geordi token>
# Optional per-bot:
onecli set DISCORD_APPLICATION_ID_DATA <data app id>
onecli set DISCORD_APPLICATION_ID_GEORDI <geordi app id>
onecli set DISCORD_PUBLIC_KEY_DATA <data public key>
onecli set DISCORD_PUBLIC_KEY_GEORDI <geordi public key>
```

Each bot will register under `channelType=discord-<name>` (e.g. `discord-data`, `discord-geordi`).

## Phase 4 — Wire the messaging groups + agents

For each bot you configured, tell the user:

> In Discord, enable **Developer Mode** (User Settings → Advanced) and **right-click** the channel you want the bot to respond in, then **Copy Channel ID**. Also note the **Server (Guild) ID** by right-clicking the server name.

Wait for `<guildId>` and `<channelId>` from the user, then wire one messaging group per bot:

```bash
# Single-bot:
ncl mg add --channel-type discord --platform-id "discord:<guildId>:<channelId>" --name "Main"
ncl wire add --messaging-group <mg-id> --agent-group <agent-group-id> --engage-mode mention

# Multi-bot example:
ncl mg add --channel-type discord-data   --platform-id "discord:<guildId>:<channelId>" --name "Ops"
ncl mg add --channel-type discord-geordi --platform-id "discord:<guildId>:<channelId>" --name "Main"
ncl wire add --messaging-group <data-mg-id>   --agent-group <data-agent-group-id>   --engage-mode mention
ncl wire add --messaging-group <geordi-mg-id> --agent-group <geordi-agent-group-id> --engage-mode mention
```

Both multi-bot wirings can point at the **same** `platform_id` — v2's UNIQUE(channel_type, platform_id) constraint keeps them distinct.

## Phase 5 — Restart + verify

```bash
launchctl kickstart -k "gui/$(id -u)/com.nanoclaw"
sleep 5
tail -n 50 ~/.nanoclaw/logs/nanoclaw.log | grep -i discord
```

You should see `Discord bot connected` log lines for each configured bot, with their tag and id.

Send `@Data ping` in the wired channel — `@Data` should respond within 60s. Repeat for `@Geordi`. Each bot will only respond to its own @-mention.

## Troubleshooting

### Bot connects but never replies

1. `sqlite3 data/v2.db "SELECT * FROM messaging_groups WHERE channel_type LIKE 'discord%'"` — verify rows exist for the channel.
2. `sqlite3 data/v2.db "SELECT * FROM messaging_group_agents"` — verify wirings exist.
3. Check `engage_mode` — `mention` requires the user to @-mention the bot.
4. Verify Message Content Intent is enabled in Discord Developer Portal (Phase 3.1 step 4).

### One bot answers, the other is silent

- Verify both tokens were captured: `onecli get DISCORD_TOKEN_DATA && onecli get DISCORD_TOKEN_GEORDI`
- Verify both bots are invited to the same server (each needs its own OAuth2 invite URL).

### Logs show "no bot tokens set"

OneCLI vault hasn't injected the env. Confirm:
```bash
ncl env | grep DISCORD
```
The vault should expose the variable names you set in Phase 3.

## Uninstalling

Drop the channel from registry:

```bash
rm src/channels/discord.ts
# Remove the `import './discord.js';` line from src/channels/index.ts
pnpm uninstall discord.js
pnpm run build
launchctl kickstart -k "gui/$(id -u)/com.nanoclaw"
```

Existing `messaging_groups` rows with `channel_type LIKE 'discord%'` remain but become inert (no adapter to deliver to them); the v2 audit log will record `dropped_messages` for inbound that can't route. Clean them up manually if you want a tidy DB.
