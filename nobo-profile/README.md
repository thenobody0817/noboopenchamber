# nobo-profile

The maintainer's OpenCode and OpenChamber setup, sanitized so it can travel to
another machine. `install-nobo.sh --profile` copies it in; nothing here
overwrites a file you already have.

## What is in it

| Path | Lands at | What it gives you |
|------|----------|-------------------|
| `opencode/opencode.json` | `~/.config/opencode/opencode.json` | the model list, the gateway URL, per-agent model assignments, permissions |
| `opencode/AGENTS.md` | `~/.config/opencode/AGENTS.md` | the agent instructions (terse replies, self-configuration protocol) |
| `opencode/skills/self-config/SKILL.md` | `~/.config/opencode/skills/` | the self-configuration skill |
| `openchamber/settings.json` | `~/.config/noboopenchamber/settings.json` | app settings |
| `openchamber/preferences.json` | `~/.config/noboopenchamber/preferences.json` | themes, notification preferences, recent models |
| `openchamber/themes/*.json` | `~/.config/noboopenchamber/themes/` | the omarchy light/dark themes |
| `openchamber/links.conf` | `~/.config/noboopenchamber/links.conf` | in-app link routing |

## What you have to supply yourself

**An OpenCode model key.** The models in `opencode.json` come from
[opencode.ai](https://opencode.ai)'s inference gateway. Put your own key in
`~/.config/opencode/opencode-go.token` — one line, the key alone. If your
account needs an organization header, add it next to the provider's other
headers:

```json
"headers": { "X-Opencode-Org-Id": "org_…", "x-opencode-session": "opencode-go-local" }
```

**Other providers.** `opencode auth login` for anything else you use.

## What is deliberately not here

Nothing that identifies the machine it came from, and nothing secret:

- API keys, the local client token, the UI password, relay signing and
  encryption keys, tunnel tokens, OAuth client ids
- projects, recent directories, window geometry, ports, SSH instances
- chat history, worktrees, downloaded speech models
- `auth.json` — provider sign-ins are yours, not shipped

`scripts/export-nobo-profile.mjs` regenerates this bundle and refuses to finish
if anything that looks like a credential survives, which is why the omissions
above are enforced rather than remembered.
