---
name: self-config
description: Use when the user asks the agent to change, rewrite, extend, or reconfigure itself or its own functionality — model, permissions, tools, instructions, agents, commands, skills, or plugins. Also use when editing files under ~/.config/opencode/ or .opencode/. Triggers - "change yourself", "rewrite yourself", "improve yourself", "add a tool", "change your model", "make yourself do X".
---

# Self-configuration

The agent cannot change its model weights or persist memory across sessions.
It CAN reconfigure the running opencode agent by editing config files. This skill
is the map of that surface.

## Hard rules
1. Never claim to edit weights or "train" yourself. Only config is editable.
2. Config is loaded once at startup and is **not hot-reloaded**. After any change,
   tell the user to quit and restart opencode.
3. Never edit herdr-managed files (see list below). Add new files beside them.
4. Validate JSON against `https://opencode.ai/config.json` before saving. A broken
   config hard-fails startup.
5. Preserve `$schema` and unrelated fields. Prefer new files over inlining.

## File map
| Purpose | Path |
| --- | --- |
| Global config | `~/.config/opencode/opencode.json` |
| Global instructions | `~/.config/opencode/AGENTS.md` |
| Global skills | `~/.config/opencode/skills/<name>/SKILL.md` |
| Global agents | `~/.config/opencode/agent/<name>.md` |
| Global commands | `~/.config/opencode/command/<name>.md` |
| Global plugins | `~/.config/opencode/plugins/<name>.js` |
| Project config | `./opencode.json` or `.opencode/opencode.json` |

## Managed — never edit
- `~/.config/opencode/herdr-tui-session.js`
- `~/.config/opencode/herdr-opencode/tui.js`
- `~/.config/opencode/plugins/herdr-agent-state.js`
- `~/.claude/hooks/herdr-agent-state.sh`

## Common self-changes
- **Model**: edit `model` in `opencode.json` (always `provider/model-id`).
- **Behavior/voice**: edit `AGENTS.md`.
- **Reusable workflow**: add a skill folder + `SKILL.md` with `name` + `description`.
- **New persona/subagent**: add `agent/<name>.md` with frontmatter `mode: subagent`.
- **Shortcut**: add `command/<name>.md`; body is the prompt, `$ARGUMENTS` for input.
- **Enforce behavior in code**: add `plugins/<name>.js` exporting a `Plugin` function.
- **Tools/permissions**: edit `permission` in `opencode.json`.

## Escape hatches (if config breaks startup)
- `OPENCODE_DISABLE_PROJECT_CONFIG=1` — skip project config.
- `OPENCODE_CONFIG=/path/file.json` — add explicit config.
- `OPENCODE_PURE=1` — skip external plugins.

Full schema: `https://opencode.ai/config.json`. When unsure of a field's shape,
fetch the schema rather than guessing.

## After editing
List exactly what changed, then: "Restart opencode for this to take effect."
