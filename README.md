# @stevengonsalvez/nanoclaw-discord

Discord channel for NanoClaw.

## Status

This package currently ships the **v1-shape** Discord channel as extracted from `stevengonsalvez/nanoclaw` fork's `src/channels/discord.ts`. It is **NOT a drop-in for vanilla NanoClaw v2** — the v2 `ChannelAdapter` contract is different and a port is needed (see [MIGRATION.md](MIGRATION.md)).

## Contents

| Path | Purpose |
|---|---|
| `src/channels/discord.ts` | v1 Discord channel — multi-bot support, per-bot trigger injection. 403 LOC. |
| `src/channels/discord.test.ts` | Test suite. 854 LOC. |
| `skill/SKILL.md` | The `/add-discord` install skill (Claude Code skill format). |
| `MIGRATION.md` | v1 → v2 ChannelAdapter port checklist. |

## v1 install (fork-style)

`skill/SKILL.md` is a Claude Code skill that walks through interactive setup: bot token, intents, guild ID, channel registration. Drops `discord.ts` into `src/channels/`, registers it via `src/channels/index.ts`, captures token via OneCLI gateway.

## v2 install (TBD)

Pending the v2 port — see MIGRATION.md.

## License

MIT
