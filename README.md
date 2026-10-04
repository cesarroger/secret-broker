# secret-broker

A Claude Code mod. Claude writes `{{secret:NAME}}` in a terminal command instead of a key, token or password. The log pops up, you enter the value privately and approve the exact command, the value is injected as `$NAME` for that one command only, and every output is redacted. Claude never sees the value.

## Install

Clone it anywhere, then point Claude Code at the folder.

```
git clone https://github.com/cesarroger/secret-broker.git
```

### Always on (Claude desktop app's Code tab, and the terminal)

Add an `env` block to your user settings, `~/.claude/settings.json` (Windows: `C:\Users\<you>\.claude\settings.json`), using the folder's absolute path:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/Users/you/mods/secret-broker",
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
  }
}
```

- `CLAUDE_CODE_PLUGIN_DIRS` loads the mod in every session. On Windows, escape backslashes: `"D:\\Mods\\secret-broker"`. Several mods: separate the paths with `:` (macOS/Linux) or `;` (Windows).
- `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` turns mods on where Claude Code runs in the background, as the desktop app does; without it the mod may not load there.
- Don't set `CLAUDE_CODE_PLUGIN_DIR_WATCH` for everyday use. It reloads the mod whenever anything in its folder changes (an indexer, a sync client, `git`), and a reload wipes the mod's memory, including a pending approval and remembered secrets. Use it only while editing the mod.

Settings are read when a session starts: open a **new** session (quit and reopen the app if needed). To turn the mod off, remove those lines.

### One session only (terminal)

```
claude --plugin-dir "/path/to/secret-broker"
```

### Check that it loaded

In a new session, send `/secrets` (press Enter; the slash menu may not list it while you type). It should reply `secret-broker: nothing remembered this session.`

Then try a dummy secret: ask Claude *Use the secret broker to run: printf 'the value is %s\n' "{{secret:TEST_KEY}}"*, enter any value in the pane, and approve. The output should read `the value is [redacted:TEST_KEY]`.

For real use, ask for something that needs a credential, e.g. "log in to the GitHub CLI with my token". The pane titled **Secret needed** opens in the Claude Code view.

## In the pane

- Paste the value and press Enter, or use **From clipboard** (keeps it off the screen), or **Use saved**.
- **RELEASE THE LOG** (Y) approves. **Decline** (N) or Esc refuses.
- Approve within ~7 seconds and the command runs right away. Take longer and Claude is told to wait; when you approve, it gets a message to run the same command again and it goes through without asking.
- The "remember for this session" toggle keeps the value in memory for later commands until the session ends. `/secrets` lists what is remembered; `/secrets forget` clears it.

## Guards

- `printenv`, bare `env` / `set`, `export -p`, reading `/proc/*/environ`, referencing `$NAME` directly, and touching the mod's temp folder are refused.
- If Claude still hands a key step back to you, a bar appears above the prompt with **Feed the log**, which asks it to use the pop-up. Nothing is sent unless you press it.

## Notes

- Values live only in the mod's memory and in a private temp file that the command deletes before it runs. Nothing is written to settings or the transcript.
- macOS / Linux: values are staged through `/bin/sh` with `umask 077` (full paths, so a Finder-launched app with a minimal PATH works).
- Windows: Git Bash's `sh` is not needed on the PATH. Values are written to `%USERPROFILE%\.claude\secret-broker\tmp` (private to your account), and the command runs in Git Bash, the shell Claude Code's Bash tool uses. Leftover files are blanked, then deleted. A `{{secret:…}}` sent to the PowerShell tool is refused and redirected to the Bash tool.
- Files left behind by a crash are cleared when the next session starts.
- `claude plugin test .` runs the tests; `claude plugin validate .` checks the manifest and hooks.
