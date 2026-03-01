# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to WhatsApp, routes messages to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `src/api-key-manager.ts` | Multi API key management with auto failover |
| `src/api-error.ts` | API error detection (quota, rate limit, auth) |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update` | Pull upstream NanoClaw changes, merge with customizations, run migrations |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

## API Key Configuration

Supports multiple API keys with automatic failover. Configure in `.env`:

```bash
# Multiple keys (recommended)
ANTHROPIC_KEY_CONFIGS='[{"name":"aliyun","baseUrl":"https://coding.dashscope.aliyuncs.com/apps/anthropic","authToken":"xxx","model":"glm-5"},{"name":"kimi","baseUrl":"https://api.kimi.com/coding/","apiKey":"xxx"}]'

# Single key
ANTHROPIC_KEY_CONFIG='{"name":"primary","apiKey":"sk-xxx","baseUrl":"https://api.anthropic.com"}'

# Legacy format (backward compatible)
ANTHROPIC_API_KEY=sk-xxx
ANTHROPIC_API_KEY_1=sk-xxx-1
ANTHROPIC_API_KEY_2=sk-xxx-2
```

Each key config supports:
- `name`: identifier for logging/notifications
- `baseUrl`: API endpoint (optional)
- `apiKey`: standard API key
- `authToken`: alternative auth token (for providers like DashScope)
- `model`: default model override (optional)
