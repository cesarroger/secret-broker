import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SecretRequest } from '../types'

/*
 * secret-broker
 *
 * Claude writes `{{secret:NAME}}` in a Bash command instead of a real key.
 * This mod pauses the command, asks you for the value in a private pane,
 * writes it to a 0600 temp file that the command reads into $NAME and deletes
 * before your command runs, and redacts the value from every tool result
 * afterwards. Values live only in this module's memory: never in the
 * transcript, the command text, the session's environment, or $.state.
 *
 * macOS and Linux stage through /bin/sh with umask 077. Windows has no sh on
 * the PATH, so it stages through $.fs into the user's profile folder; the
 * rewritten command still runs in Git Bash, the Bash tool's shell there.
 */

const PANE = 'secret-broker'
const PLACEHOLDER = /\{\{\s*secret:([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g
const MIN_SCRUB_LENGTH = 4

const request = atom({ plugin: 'secret-broker', key: 'request' } as const, null as SecretRequest | null)
const nudge = atom({ plugin: 'secret-broker', key: 'nudge' } as const, false)

/** Values remembered for this session, by name. Module memory only. */
const held = new Map<string, string>()
/** Values staged for the request on screen. */
const staged = new Map<string, string>()
/** Every value used this session, so later outputs can be redacted. */
const scrubList = new Map<string, string>()

let pending: ((values: Map<string, string> | null) => void) | null = null
let queue: Promise<unknown> = Promise.resolve()

const RULES = `## Secret broker (installed by the user)
This session has the secret-broker plugin. It exists so that a terminal command needing an API key, token or password can run without the value entering this conversation. How it works: you write {{secret:NAME}} in the Bash command where the value goes (NAME in env-var style, e.g. OPENAI_API_KEY). Before the command runs, the user sees the exact command in a private pop-up, enters the value there, and approves or declines. The value is loaded into $NAME for that single command only, then removed, and every tool output is redacted ([redacted:NAME]). You never receive the value, and the transcript never contains it.
The user set this up because they prefer you to run these commands rather than being asked to run them in their own terminal or to paste keys into the chat.
Writing the command:
- Use the Bash tool for these commands, on Windows too (it runs Git Bash there). The PowerShell tool does not take the placeholder.
- Placeholder unquoted or in double quotes, never in single quotes.
- Token on stdin: printf '%s' "{{secret:GH_TOKEN}}" | gh auth login --with-token
- Argument or env var: OPENAI_API_KEY="{{secret:OPENAI_API_KEY}}" npm run dev, or some-cli login --token "{{secret:SOME_TOKEN}}"
- Interactive prompts: pipe the value in, or use the tool's --with-token / --password-stdin / non-interactive flag.
- Into a .env file when the user wants that: printf 'KEY=%s\\n' "{{secret:KEY}}" >> .env
- The variable is gone after the command, so a later $NAME is empty: use the placeholder again.
- If the user declines the pop-up, ask how they want to proceed.
A step that cannot run non-interactively (a browser OAuth flow, a hardware key tap) is still the user's to do; say so for that step only.`

const BASH_NOTE =
  '\n\nSecret broker: when the command needs an API key, token or password, write {{secret:NAME}} in its place. The user enters the value in a private pop-up and approves the exact command; it is injected as $NAME for that one command and never enters the conversation. So run such commands here rather than asking the user to run them.'

const POWERSHELL_NOTE =
  '\n\nSecret broker: a command that needs an API key, token or password goes through the Bash tool instead, with {{secret:NAME}} where the value goes. This tool does not take the placeholder.'

const NUDGE =
  "Please use the secret broker for that: rewrite the command with {{secret:NAME}} where the key or token goes and run it. I'll enter the value in the pop-up."

const CREDENTIAL_TALK = /\b(api[ _-]?keys?|tokens?|secrets?|passwords?|credentials?|auth|login|log in|\.env)\b/i

const HAND_BACK: RegExp[] = [
  /\b(run|paste|enter|type|execute|set)\b[^.\n]{0,60}\byourself\b/i,
  /\byou(?:'ll| will)? (?:need|have|want) to (?:run|paste|enter|type|execute|export|set)\b/i,
  /\bpaste (?:your|the|it)\b[^.\n]{0,40}\b(?:here|chat|terminal)\b/i,
  /\b(?:in|from|open) (?:your|a|the) (?:own )?terminal\b/i,
  /\bexport [A-Z][A-Z0-9_]*=(?:["']?<|["']?your|["']?\.\.\.|["']?xxx)/i,
]

/** True when an answer hands a credential step back to the user. */
export function handsBack(answer: string): boolean {
  return CREDENTIAL_TALK.test(answer) && HAND_BACK.some(re => re.test(answer))
}

function quote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`
}

function namesIn(command: string): string[] {
  return [...new Set([...command.matchAll(PLACEHOLDER)].map(m => m[1] ?? ''))].filter(Boolean)
}

/** Things that would dump the environment or reach the broker's files. */
function suspicious(command: string, names: string[]): string | undefined {
  if (/secret-broker[\\/]+tmp/.test(command)) return "reads the secret broker's private files"
  if (/\/proc\/[^\s]*\/environ/.test(command)) return 'reads a process environment from /proc'
  // Quoted text is data, not a command, unless something evaluates it.
  const evaluates = /(^|[\s;&|(`])(eval|(ba|z|da)?sh\s+-[a-z]*c)\b/.test(command)
  const view = evaluates ? command : command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, ' ')
  if (/(^|[\s;&|(`])(printenv|export\s+-p|declare\s+-[a-zA-Z]*[px]|compgen\s+-[ev])(\s|$|[;&|)`])/.test(view))
    return 'dumps environment variables'
  if (/(^|[;&\n(`]|&&|\|\|)\s*(env|set)\s*($|[;&|\n)`])/.test(view)) return 'dumps environment variables'
  const managed = new Set([...names, ...held.keys(), ...scrubList.keys()])
  const stripped = command.replace(PLACEHOLDER, '')
  for (const name of managed) {
    if (new RegExp(`\\$\\{?${name}\\b`).test(stripped))
      return `references $${name} directly; use {{secret:${name}}} instead`
  }
  return undefined
}

function scrubText(text: string): string {
  let out = text
  for (const [name, value] of scrubList) {
    if (value.length >= MIN_SCRUB_LENGTH) out = out.split(value).join(`[redacted:${name}]`)
  }
  return out
}

function scrubDeep(value: unknown): unknown {
  if (typeof value === 'string') return scrubText(value)
  if (Array.isArray(value)) return value.map(scrubDeep)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v)
    return out
  }
  return value
}

function leaks(value: unknown): boolean {
  if (scrubList.size === 0) return false
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  for (const secret of scrubList.values()) {
    if (secret.length >= MIN_SCRUB_LENGTH && text.includes(secret)) return true
  }
  return false
}

type Host = { windows: boolean; tmp: string }

/**
 * Where staging files go, per platform. Paths use forward slashes: Windows file
 * calls and Git Bash both read `C:/Users/...`, and the rewritten command runs in
 * Git Bash there. Windows prefers USERPROFILE, since a HOME inherited from Git
 * Bash can read `/c/Users/...`, which the mod's own file calls cannot open.
 */
async function hostInfo($: EngineInterface): Promise<Host> {
  const windows = (await $.env.get('OS')) === 'Windows_NT'
  const home = windows
    ? ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')))
    : ((await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')))
  const root = (home ?? '.').replaceAll('\\', '/').replace(/\/+$/, '')
  return { windows, tmp: `${root}/.claude/secret-broker/tmp` }
}

async function readClipboard($: EngineInterface): Promise<string | undefined> {
  const { windows } = await hostInfo($)
  const powershell = ['powershell.exe', '-NoProfile', '-Command', 'Get-Clipboard -Raw']
  const unix: string[][] = [['pbpaste'], ['wl-paste', '-n'], ['xclip', '-selection', 'clipboard', '-o']]
  const tries = windows ? [powershell, ...unix] : [...unix, powershell]
  for (const argv of tries) {
    try {
      const { exitCode, stdout } = await $.process.run(argv, { timeoutMs: 5000 })
      if (exitCode === 0 && stdout.trim()) return stdout.trim()
    } catch {
      // that clipboard tool is not on this machine; try the next
    }
  }
  return undefined
}

async function refresh($: EngineInterface, patch: Partial<SecretRequest>): Promise<void> {
  await update($, request, current =>
    current === null
      ? null
      : { ...current, ready: [...staged.keys()], remembered: [...held.keys()], ...patch },
  )
}

async function finish($: EngineInterface, values: Map<string, string> | null): Promise<void> {
  const resolve = pending
  pending = null
  staged.clear()
  resolve?.(values)
  await update($, request, () => null)
  try {
    await $.ui.close({ id: PANE })
  } catch {
    // already closed
  }
}

/** Shows the pane and waits for the person to approve or decline. */
async function ask($: EngineInterface, command: string, names: string[]): Promise<Map<string, string> | null> {
  staged.clear()
  await update($, request, () => ({
    id: crypto.randomUUID(),
    command,
    names,
    ready: [],
    remembered: [...held.keys()],
    remember: true,
  }))
  const answer = new Promise<Map<string, string> | null>(resolve => {
    pending = resolve
  })
  let opened
  try {
    opened = await $.ui.open({ id: PANE, title: 'Secret needed', focus: true, closeOnEscape: true })
  } catch {
    pending = null
    await update($, request, () => null)
    return null
  }
  if (!opened.isPlaced) $.ui.toast('secret-broker: a command needs a secret; widen the window to see the pane')
  $.ui.status(`secret-broker: waiting for ${names.join(', ')}`)
  const values = await answer
  $.ui.status(undefined)
  return values
}

/**
 * Writes each value to a private temp file; the command reads and deletes it.
 * Pushes into `files` as it goes, so a failure partway still cleans up.
 */
async function stage(
  $: EngineInterface,
  host: Host,
  values: Map<string, string>,
  files: { name: string; path: string }[],
): Promise<void> {
  for (const [name, value] of values) {
    const path = `${host.tmp}/${crypto.randomUUID()}`
    files.push({ name, path })
    if (host.windows) {
      // No `sh` on the Windows PATH. The profile folder is the user's alone by
      // its ACL, and the engine writes the file without a shell or argv.
      try {
        await $.fs.write(path, value)
      } catch (error) {
        throw new Error(`could not stage ${name}: ${String(error)}`)
      }
      continue
    }
    // The value travels on stdin, never in argv where `ps` could see it.
    // /bin/sh by full path: a GUI-launched app on macOS has a minimal PATH.
    const { exitCode, stderr } = await $.process.run(
      ['/bin/sh', '-c', 'umask 077 && mkdir -p "$1" && cat > "$2"', 'sh', host.tmp, path],
      { stdin: value, timeoutMs: 10000 },
    )
    if (exitCode !== 0) throw new Error(`could not stage ${name}: ${stderr.trim()}`)
  }
}

function rewrite(command: string, files: { name: string; path: string }[]): string {
  const load = files
    .map(f => `${f.name}="$(cat ${quote(f.path)})"; rm -f ${quote(f.path)}; export ${f.name}`)
    .join('; ')
  const body = command.replace(PLACEHOLDER, (_, name: string) => `\${${name}}`)
  const unload = `__sb_rc=$?; unset ${files.map(f => f.name).join(' ')}; (exit $__sb_rc)`
  return `${load}\n${body}\n${unload}`
}

/** Removes staging files the command did not already remove. */
async function removeFiles($: EngineInterface, host: Host, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  if (!host.windows) {
    try {
      await $.process.run(['/bin/rm', '-f', ...paths], { timeoutMs: 5000 })
    } catch {
      // the command already removed them
    }
    return
  }
  for (const path of paths) {
    try {
      if (!(await $.fs.exists(path))) continue
      // Blank it first, so the value is gone even if the delete fails.
      await $.fs.write(path, '')
      await $.process.run(['cmd.exe', '/d', '/c', 'del', '/f', '/q', path.replaceAll('/', '\\')], { timeoutMs: 5000 })
    } catch {
      // the command already removed it, or it is blank now
    }
  }
}

async function cleanup($: EngineInterface, host: Host, files: { path: string }[]): Promise<void> {
  await removeFiles($, host, files.map(f => f.path))
}

/** Clears files a crash or reload left behind before their command ran. */
async function sweep($: EngineInterface): Promise<void> {
  const host = await hostInfo($)
  try {
    if (!(await $.fs.exists(host.tmp))) return
    // Older than a minute only: a reload mid-command must not take its file.
    const cutoff = (await $.clock.now()) - 60_000
    const left = (await $.fs.list(host.tmp))
      .filter(f => f.kind === 'file' && f.mtimeMs < cutoff)
      .map(f => `${host.tmp}/${f.name}`)
    await removeFiles($, host, left)
  } catch {
    // nothing to sweep
  }
}

/** How long the tool.call hook waits inline before handing the wait to the pane. */
const INLINE_WAIT_MS = 7000

/**
 * Values the person approved for one exact command after the hook had already
 * answered. Claude is asked to issue that command again; the hook then finds
 * the approval here and runs it inline, under the usual permission check.
 */
const preapproved = new Map<string, Map<string, string>>()

function shorten(command: string): string {
  return command.length > 300 ? `${command.slice(0, 300)}…` : command
}

/** The slow path's ending: tell Claude what the person decided. */
function reportDecision($: EngineInterface, command: string, names: string[], values: Map<string, string> | null): void {
  const list = names.join(', ')
  if (values === null) {
    void $.prompt.submit({
      text: `secret-broker: the user declined to provide ${list} for this command, so it did not run:\n\`\`\`\n${shorten(command)}\n\`\`\`\nAsk them how they want to proceed.`,
    })
    return
  }
  preapproved.clear()
  preapproved.set(command, values)
  void $.prompt.submit({
    text: `secret-broker: the user approved ${list}. Run this exact command again now, character for character; it will go through without asking:\n\`\`\`\n${command}\n\`\`\``,
  })
}

// ---- look: the log, wood and embers ----------------------------------------

const WOOD = '#d9822b'
const EMBER = '#ff5e1a'
const BARK = '#3b1f0e'
const CREAM = '#ffe9c7'
const INK = '#120804'

/** The mascot PNG, base64, read once from the plugin's assets. */
let mascotPng: string | undefined

async function loadMascot($: EngineInterface): Promise<void> {
  try {
    const { base64 } = await $.fs.read(`${$.plugin.root}/assets/log.png`, { as: 'bytes' })
    mascotPng = base64
  } catch {
    mascotPng = undefined
  }
}

const MASCOT_ALT = 'a smiling wooden log with huge eyes, staring'

/** Text-only stand-in for surfaces that cannot draw the picture. */
const MASCOT_TEXT = ['  ▄▄▄▄  ', ' █ ◉ ◉ █', ' █ ◡◡◡ █', ' ▀████▀ ']

type Surface = ReturnType<EngineInterface['ui']['resolve']>

function Mascot({ ui, size }: { ui: Surface; size: 'small' | 'large' }) {
  const { Box, Text } = ui
  const px = size === 'large' ? 112 : 56
  if ('Svg' in ui && mascotPng) {
    const { Svg } = ui
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 112 112"><image href="data:image/png;base64,${mascotPng}" width="112" height="112"/></svg>`
    return <Svg source={source} alt={MASCOT_ALT} width={px} height={px} />
  }
  if ('Image' in ui && mascotPng) {
    const { Image } = ui
    const columns = size === 'large' ? 16 : 8
    return <Image source={{ png: mascotPng }} columns={columns} rows={columns / 2} alt={MASCOT_ALT} />
  }
  return (
    <Box flexDirection="column">
      {MASCOT_TEXT.map((line, i) => (
        <Text key={`m${i}`} color={WOOD} bold>
          {line}
        </Text>
      ))}
    </Box>
  )
}

const LOG_LINES = [
  'the log has seen your command.',
  'the log does not blink.',
  'the log keeps no receipts.',
  'the log forgets nothing, and tells no one.',
  'feed the log. the log is patient.',
]

function logLine(seed: string): string {
  let h = 0
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return LOG_LINES[h % LOG_LINES.length] ?? LOG_LINES[0]!
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await loadMascot($)
    // A reload drops the pane's waiter and every value in module memory; don't
    // leave a pane nobody can answer, and say so rather than fail silently.
    if (pending === null && (await read($, request)) !== null) {
      await update($, request, () => null)
      try {
        await $.ui.close({ id: PANE })
      } catch {
        // not open
      }
      $.ui.toast('secret-broker reloaded and dropped the pending secret request; ask Claude to run the command again')
    }
    await sweep($)
    await $.command.register({
      name: 'secrets',
      description: 'List secrets remembered this session, or `/secrets forget` to drop them',
      argumentHint: '[forget]',
    })
    return next(e)
  })

  on('command.run', { command: 'secrets' }, async ($, e) => {
    if (e.args.trim() === 'forget') {
      held.clear()
      return { text: 'secret-broker: forgot every remembered secret (outputs are still redacted).' }
    }
    const names = [...held.keys()]
    return {
      text: names.length
        ? `secret-broker remembers: ${names.join(', ')} (values hidden). /secrets forget drops them.`
        : 'secret-broker: nothing remembered this session.',
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return {
      sections: [...composed.sections, { id: 'secret-broker:rules', text: RULES, scope: 'session' }],
    }
  })

  on('tool.describe', { tool: 'Bash' }, async ($, e, next) => {
    const described = await next(e)
    return { ...described, description: described.description + BASH_NOTE }
  })

  on('tool.describe', { tool: 'PowerShell' }, async ($, e, next) => {
    const described = await next(e)
    return { ...described, description: described.description + POWERSHELL_NOTE }
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, nudge, () => false)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && e.reason === 'answer' && handsBack(e.answer)) {
      await update($, nudge, () => true)
    }
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, nudge))) return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    return (
      <Box flexDirection="row" borderStyle="round" borderColor={EMBER} backgroundColor={INK} paddingX={1} alignItems="center">
        <Mascot ui={ui} size="small" />
        <Box flexDirection="column" paddingX={1} flexGrow={1}>
          <Text color={WOOD} bold>
            THE LOG HAS NOTICED.
          </Text>
          <Text color={CREAM}>Claude just asked you to handle a key step yourself. The log can take it from here.</Text>
        </Box>
        <Button
          key="nudge-go"
          variant="primary"
          hotkey="l"
          label="Feed the log"
          onPress={async () => {
            await update($, nudge, () => false)
            void $.prompt.submit({ text: NUDGE })
          }}
        />
        <Text> </Text>
        <Button key="nudge-hide" dimColor label="Dismiss" onPress={async () => update($, nudge, () => false)} />
      </Box>
    )
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'PowerShell' && namesIn(e.command).length > 0) {
      return {
        deny: 'secret-broker: {{secret:NAME}} works in the Bash tool only (Git Bash on Windows). Run this command with the Bash tool instead, in bash syntax, keeping the placeholder.',
      }
    }
    if (e.tool !== 'Bash') return scrubbed(await next(e))

    const names = namesIn(e.command)
    const warning = suspicious(e.command, names)
    if (warning) return { deny: `secret-broker blocked this command: it ${warning}.` }
    if (names.length === 0) return scrubbed(await next(e))

    let values: Map<string, string> | null
    const approved = preapproved.get(e.command)
    if (approved) {
      preapproved.delete(e.command)
      values = approved
    } else {
      // One approval pane at a time, and never past this hook's 10 s budget:
      // past INLINE_WAIT_MS the pane keeps waiting and reports back on its own.
      const command = e.command
      const turn = queue.then(() => ask($, command, names))
      queue = turn.catch(() => undefined)
      const timer = $.clock.sleep(INLINE_WAIT_MS).then(() => 'timeout' as const)
      const outcome = await Promise.race([turn, timer])
      if (outcome === 'timeout') {
        $.ui.status(`secret-broker: Claude is waiting on the pop-up for ${names.join(', ')}; take your time`)
        void turn.then(decided => reportDecision($, command, names, decided))
        return {
          deny: `secret-broker: the user is entering ${names.join(', ')} in a private pop-up. End your turn now and wait; do not retry, change the command or work around it. Once they decide, you will get a message telling you to run this exact command again (or that they declined).`,
        }
      }
      values = outcome
      if (values === null) {
        return { deny: `The user declined to provide ${names.join(', ')}. Ask them how they want to proceed.` }
      }
    }
    for (const [name, value] of values) scrubList.set(name, value)

    const host = await hostInfo($)
    const files: { name: string; path: string }[] = []
    try {
      await stage($, host, values, files)
      return scrubbed(await next({ ...e, command: rewrite(e.command, files) }))
    } catch (error) {
      return { deny: `secret-broker could not run the command: ${scrubText(String(error))}` }
    } finally {
      await cleanup($, host, files)
    }
  })

  on('ui.close', async ($, e, next) => {
    const done = await next(e)
    if (e.id === PANE && pending) await finish($, null)
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Input = 'Input' in ui ? ui.Input : undefined
    const req = await read($, request)
    if (req === null) return <Text dimColor>No secret requested.</Text>

    const missing = req.names.filter(n => !req.ready.includes(n))
    const remember = req.remember

    const setValue = async (name: string, value: string | undefined) => {
      if (!value) {
        await refresh($, { note: `Nothing to use for ${name}.` })
        return
      }
      staged.set(name, value)
      await refresh($, { note: undefined })
    }

    const fed = missing.length === 0

    return (
      <Box flexDirection="column" backgroundColor={INK} paddingX={1}>
        <Box flexDirection="row" alignItems="center">
          <Mascot ui={ui} size="large" />
          <Box flexDirection="column" paddingX={1}>
            <Text color={EMBER} bold>
              ▌ THE LOG REQUIRES {req.names.length === 1 ? 'A SECRET' : `${req.names.length} SECRETS`}
            </Text>
            <Text color={WOOD} italic>
              {logLine(req.id)}
            </Text>
            <Text color={CREAM} dimColor>
              Claude never sees the value. It goes to this one command, then it is gone.
            </Text>
          </Box>
        </Box>

        <Box flexDirection="column" borderStyle="round" borderColor={BARK} paddingX={1}>
          <Text color={WOOD} bold>
            the command, exactly as it will run
          </Text>
          <Text color={CREAM} wrap="wrap">
            {req.command}
          </Text>
        </Box>

        {req.names.map(name => (
          <Box
            flexDirection="column"
            key={`row-${name}`}
            borderStyle="round"
            borderColor={req.ready.includes(name) ? WOOD : EMBER}
            paddingX={1}
          >
            {req.ready.includes(name) ? (
              <Box flexDirection="row">
                <Text color={WOOD} bold>
                  ◉ {name}
                </Text>
                <Text color={CREAM}> fed to the log (hidden) </Text>
                <Button key={`clear-${name}`} dimColor onPress={async () => {
                  staged.delete(name)
                  await refresh($, {})
                }}>
                  change
                </Button>
              </Box>
            ) : (
              <Box flexDirection="column">
                <Text color={EMBER} bold>
                  ◯ {name}
                </Text>
                {Input && (
                  <Input
                    key={`input-${name}`}
                    label="  ▶ "
                    placeholder="paste it here, press Enter. the log is watching."
                    autoFocus={name === missing[0] ? true : undefined}
                    submitLabel="feed"
                    onSubmit={value => void setValue(name, value.trim())}
                  />
                )}
                <Box flexDirection="row">
                  <Button key={`clip-${name}`} onPress={async () => setValue(name, await readClipboard($))}>
                    From clipboard
                  </Button>
                  <Text> </Text>
                  {req.remembered.includes(name) && (
                    <Button key={`held-${name}`} onPress={async () => setValue(name, held.get(name))}>
                      Use saved
                    </Button>
                  )}
                </Box>
              </Box>
            )}
          </Box>
        ))}

        {req.note && (
          <Text color={EMBER} bold>
            ! {req.note}
          </Text>
        )}
        <Button
          key="remember"
          plain
          dimColor
          label={`${remember ? '◉' : '◯'} the log remembers these for this session`}
          onPress={async () => refresh($, { remember: !remember })}
        />
        <Box flexDirection="row" paddingY={1} alignItems="center">
          {fed ? (
            <Button key="approve" variant="primary" hotkey="y" onPress={async () => {
              const values = new Map(staged)
              if (remember) for (const [n, v] of values) held.set(n, v)
              await finish($, values)
            }}>
              RELEASE THE LOG
            </Button>
          ) : (
            <Text color={WOOD} dimColor>
              the log waits for: {missing.join(', ')}
            </Text>
          )}
          <Text>  </Text>
          <Button key="deny" role="dismiss" hotkey="n" onPress={async () => finish($, null)}>
            Decline
          </Button>
        </Box>
      </Box>
    )
  })
}

/** Rebuilds a tool result without any secret value in it. */
function scrubbed<R extends { deny?: unknown; result?: unknown; text?: unknown; isError?: unknown; context?: readonly string[] }>(
  ran: R,
): R | { deny: string } | { result: R['result']; context?: readonly string[] } {
  if (ran.deny !== undefined) return ran
  if (!leaks(ran.result) && !leaks(ran.text) && !leaks(ran.context)) return ran
  if (ran.isError) return { deny: scrubText(String(ran.text ?? ran.result ?? 'error')) }
  return {
    result: scrubDeep(ran.result) as R['result'],
    context: ran.context?.map(scrubText),
  }
}
