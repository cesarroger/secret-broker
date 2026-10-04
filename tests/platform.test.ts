import { expect, mock, test } from 'claude-code/testing'

const SECRET = 'win-SECRET-value-98765'
const PANE_PROPS = {
  title: 'Secret needed',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 24 },
  view: {},
}

const OK = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

test('on Windows, stages through the engine without sh and runs in Git Bash paths', async ($, on) => {
  mock.clock(on)
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\tester', HOME: '/c/Users/tester' })

  const writes: { path: string; text: string }[] = []
  on('fs.write', (_$, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  // The command removed its own file, so cleanup finds nothing left.
  on('fs.exists', () => ({ value: false }))

  const argvs: string[][] = []
  on('process.run', (_$, e) => {
    argvs.push([...e.argv])
    return { value: OK }
  })

  let ranCommand = ''
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash') ranCommand = e.command
    return { result: { stdout: `token ${SECRET} accepted`, stderr: '', interrupted: false } }
  })

  let opened!: () => void
  const paneOpen = new Promise<void>(resolve => (opened = resolve))
  on('ui.open', () => {
    opened()
    return { value: { isPlaced: true as const } }
  })

  const call = $.tool.call({ tool: 'Bash', command: 'gh auth login --with-token <<< "{{secret:GH_TOKEN}}"' })
  await paneOpen
  const ui = await $.ui.mount({
    plugin: 'secret-broker',
    surface: 'desktop',
    component: 'Pane',
    props: PANE_PROPS,
    requestId: 'secret-broker',
  })
  await ui.input({ key: 'input-GH_TOKEN', text: SECRET })
  await ui.press({ key: 'approve' })
  const ran = await call

  expect(ran.deny).toBeUndefined()
  // Written by the engine to the profile folder, forward slashes, never via sh.
  expect(writes.length).toBe(1)
  expect(writes[0]!.text).toBe(SECRET)
  expect(writes[0]!.path.startsWith('C:/Users/tester/.claude/secret-broker/tmp/')).toBe(true)
  expect(argvs.some(a => a[0] === 'sh' || a[0] === '/bin/sh')).toBe(false)
  expect(JSON.stringify(argvs)).not.toContain(SECRET)

  expect(ranCommand).toContain("'C:/Users/tester/.claude/secret-broker/tmp/")
  expect(ranCommand).not.toContain(SECRET)
  expect(ranCommand).toContain('"${GH_TOKEN}"')
  expect(JSON.stringify(ran)).not.toContain(SECRET)
  expect(JSON.stringify(ran)).toContain('[redacted:GH_TOKEN]')
})

test('on macOS and Linux, stages with /bin/sh by full path', async ($, on) => {
  mock.clock(on)
  mock.env(on, { HOME: '/Users/tester' })
  const argvs: string[][] = []
  on('process.run', (_$, e) => {
    argvs.push([...e.argv])
    return { value: OK }
  })
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  let opened!: () => void
  const paneOpen = new Promise<void>(resolve => (opened = resolve))
  on('ui.open', () => {
    opened()
    return { value: { isPlaced: true as const } }
  })

  const call = $.tool.call({ tool: 'Bash', command: 'cli --key "{{secret:MAC_KEY}}"' })
  await paneOpen
  const ui = await $.ui.mount({
    plugin: 'secret-broker',
    surface: 'terminal',
    component: 'Pane',
    props: PANE_PROPS,
    requestId: 'secret-broker',
  })
  await ui.input({ key: 'input-MAC_KEY', text: 'mac-secret-1234' })
  await ui.press({ key: 'approve' })
  const ran = await call

  expect(ran.deny).toBeUndefined()
  expect(argvs[0]?.[0]).toBe('/bin/sh')
  expect(argvs[0]?.[4]).toBe('/Users/tester/.claude/secret-broker/tmp')
  expect(argvs.some(a => a[0] === '/bin/rm')).toBe(true)
})

test('a placeholder in the PowerShell tool is sent to the Bash tool instead', async $ => {
  const ran = await $.tool.call({ tool: 'PowerShell', command: '$env:K = "{{secret:K_TOKEN}}"; cli login' })
  expect(ran.deny).toContain('Bash tool')
})
