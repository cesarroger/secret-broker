import { expect, mock, test } from 'claude-code/testing'

const SECRET = 'slow-but-SURE-7777'
const COMMAND = 'cli login --token "{{secret:SLOW_KEY}}"'
const PANE_PROPS = {
  title: 'Secret needed',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 24 },
  view: {},
}

test('when approval takes longer than the hook may wait, the pane keeps waiting and Claude re-runs on approval', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/tester' })
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))

  let opens = 0
  on('ui.open', () => {
    opens += 1
    return { value: { isPlaced: true as const } }
  })

  const ranCommands: string[] = []
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash') ranCommands.push(e.command)
    return { result: { stdout: 'done', stderr: '', interrupted: false } }
  })

  const submitted: string[] = []
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })

  // First call: nobody answers within the inline window.
  const first = $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.settle()
  expect(opens).toBe(1)
  await clock.advance(7000)
  const firstResult = await first
  expect(firstResult.deny).toContain('pop-up')
  // Nothing ran: the raw command never went through with an empty value.
  expect(ranCommands).toHaveLength(0)

  // The person takes their time, then approves in the pane.
  const ui = await $.ui.mount({
    plugin: 'secret-broker',
    surface: 'terminal',
    component: 'Pane',
    props: PANE_PROPS,
    requestId: 'secret-broker',
  })
  await ui.input({ key: 'input-SLOW_KEY', text: SECRET })
  await ui.press({ key: 'approve' })
  await clock.settle()

  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain('approved SLOW_KEY')
  expect(submitted[0]).toContain(COMMAND)
  expect(submitted[0]).not.toContain(SECRET)

  // Claude issues the same command again: no second pane, runs inline, injected.
  const second = await $.tool.call({ tool: 'Bash', command: COMMAND })
  expect(second.deny).toBeUndefined()
  expect(opens).toBe(1)
  expect(ranCommands).toHaveLength(1)
  expect(ranCommands[0]).toContain('"${SLOW_KEY}"')
  expect(ranCommands[0]).not.toContain(SECRET)

  // A pre-approval is spent once: a third identical call asks again.
  const third = $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.settle()
  expect(opens).toBe(2)
  await clock.advance(7000)
  expect((await third).deny).toContain('pop-up')
})

test('declining on the slow path tells Claude, and nothing runs', async ($, on) => {
  const clock = mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  const ranCommands: string[] = []
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash') ranCommands.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  const submitted: string[] = []
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })

  const call = $.tool.call({ tool: 'Bash', command: 'deploy --key {{secret:D_KEY}}' })
  await clock.settle()
  await clock.advance(7000)
  expect((await call).deny).toContain('pop-up')

  const ui = await $.ui.mount({
    plugin: 'secret-broker',
    surface: 'desktop',
    component: 'Pane',
    props: PANE_PROPS,
    requestId: 'secret-broker',
  })
  await ui.press({ key: 'deny' })
  await clock.settle()
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain('declined')
  expect(ranCommands).toHaveLength(0)
})
