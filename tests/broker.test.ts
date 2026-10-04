import { expect, mock, test } from 'claude-code/testing'

const SECRET = 'sk-test-SUPERSECRET-123456'
const PANE_PROPS = {
  title: 'Secret needed',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 24 },
  view: {},
}

test('blocks commands that dump the environment', async $ => {
  for (const command of ['printenv', 'env', 'env | grep KEY', 'cat /proc/self/environ', 'export -p']) {
    const ran = await $.tool.call({ tool: 'Bash', command })
    expect(ran.deny).toBeDefined()
  }
})

test('lets ordinary commands through untouched', async ($, on) => {
  let seen = ''
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash') seen = e.command
    return { result: { stdout: 'ok', stderr: '', interrupted: false } }
  })
  const ran = await $.tool.call({ tool: 'Bash', command: 'env FOO=1 npm test' })
  expect(ran.deny).toBeUndefined()
  expect(seen).toBe('env FOO=1 npm test')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`asks privately, injects, and redacts (${surface})`, async ($, on) => {
    mock.clock(on)
    mock.env(on, { HOME: '/home/tester' })

    const stdins: string[] = []
    const argvs: string[][] = []
    on('process.run', (_$, e) => {
      argvs.push([...e.argv])
      if (e.init?.stdin !== undefined) stdins.push(e.init.stdin)
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })

    let ranCommand = ''
    on('tool.call', (_$, e) => {
      if (e.tool === 'Bash') ranCommand = e.command
      // Pretend the CLI echoed the token back.
      return { result: { stdout: `logged in with ${SECRET}`, stderr: '', interrupted: false } }
    })

    let opened!: () => void
    const paneOpen = new Promise<void>(resolve => (opened = resolve))
    on('ui.open', (_$, e) => {
      if (e.id === 'secret-broker') opened()
      return { value: { isPlaced: true as const } }
    })

    const call = $.tool.call({ tool: 'Bash', command: 'mycli login --token "{{secret:API_KEY}}"' })
    await paneOpen

    const ui = await $.ui.mount({
      plugin: 'secret-broker',
      surface,
      component: 'Pane',
      props: PANE_PROPS,
      requestId: 'secret-broker',
    })
    expect(await ui.find({ key: 'approve' })).toBeUndefined()
    await ui.input({ key: 'input-API_KEY', text: SECRET })
    await ui.press({ key: 'approve' })

    const ran = await call
    expect(ran.deny).toBeUndefined()

    // The secret reached the staging file over stdin only, never argv or the command.
    expect(stdins).toContain(SECRET)
    expect(JSON.stringify(argvs)).not.toContain(SECRET)
    expect(ranCommand).not.toContain(SECRET)
    expect(ranCommand).not.toContain('{{secret:')
    expect(ranCommand).toContain('"${API_KEY}"')
    expect(ranCommand).toContain('/home/tester/.claude/secret-broker/tmp/')

    // What the model reads is redacted.
    expect(JSON.stringify(ran)).not.toContain(SECRET)
    expect(JSON.stringify(ran)).toContain('[redacted:API_KEY]')

    // A later attempt to reference the variable directly is refused.
    const sneaky = await $.tool.call({ tool: 'Bash', command: 'echo $API_KEY' })
    expect(sneaky.deny).toBeDefined()
  })
}

test('declining denies the command', async ($, on) => {
  mock.clock(on)
  let opened!: () => void
  const paneOpen = new Promise<void>(resolve => (opened = resolve))
  on('ui.open', () => {
    opened()
    return { value: { isPlaced: true as const } }
  })
  const call = $.tool.call({ tool: 'Bash', command: 'deploy --key {{secret:DEPLOY_KEY}}' })
  await paneOpen
  const ui = await $.ui.mount({
    plugin: 'secret-broker',
    surface: 'terminal',
    component: 'Pane',
    props: PANE_PROPS,
    requestId: 'secret-broker',
  })
  await ui.press({ key: 'deny' })
  const ran = await call
  expect(ran.deny).toContain('declined')
})
