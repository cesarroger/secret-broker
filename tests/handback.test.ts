import { expect, test } from 'claude-code/testing'

test('adds the broker note to the Bash tool description', async ($, on) => {
  on('tool.describe', (_$, e) => ({ description: e.description }))
  const provider = { plugin: 'engine', tier: 'core' as const }
  const described = await $.tool.describe({ tool: 'Bash', description: 'base description of Bash', provider })
  expect(described.description).toContain('base description of Bash')
  expect(described.description).toContain('{{secret:NAME}}')
  const other = await $.tool.describe({ tool: 'Read', description: 'base description of Read', provider })
  expect(other.description).not.toContain('{{secret:NAME}}')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`shows a bar when Claude hands a key step back, and the button asks again (${surface})`, async ($, on) => {
    on('turn.complete', (_$, e) => ({ text: e.answer }))
    on('ui.render', () => ({ type: 'Text' as const, props: {}, children: [] }))
    const submitted: string[] = []
    on('prompt.submit', (_$, e) => {
      submitted.push(e.text)
      return { text: e.text }
    })

    const band = () =>
      $.ui.mount({
        plugin: 'secret-broker',
        surface,
        component: 'AbovePrompt',
        props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 80, scroll: { offset: 0, bodyRows: 4 }, view: {} },
      })

    await $.turn.complete({
      answer: 'All set. Run `npm run deploy` with no further changes.',
      reason: 'answer',
      durationMs: 10,
      isAborted: false,
      turnId: 't1',
    })
    expect(await (await band()).find({ key: 'nudge-go' })).toBeUndefined()

    await $.turn.complete({
      answer: "I can't use your API key directly, so you'll need to run `vercel login --token <token>` yourself in your terminal.",
      reason: 'answer',
      durationMs: 10,
      isAborted: false,
      turnId: 't2',
    })
    const shown = await band()
    expect(await shown.find({ key: 'nudge-go' })).toBeDefined()

    // Nothing is submitted on the person's behalf until they press the button.
    expect(submitted).toHaveLength(0)
    await shown.press({ key: 'nudge-go' })
    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toContain('{{secret:NAME}}')
    expect(await (await band()).find({ key: 'nudge-go' })).toBeUndefined()
  })
}

test('a regex containing "set" is not mistaken for an env dump', async ($, on) => {
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  const quoted = `python3 -c "import re; print(re.sub('(env|set)', 'x', 'reset'))"`
  const ran = await $.tool.call({ tool: 'Bash', command: quoted })
  expect(ran.deny).toBeUndefined()
  const bare = ['cd app', 'set'].join(' && ')
  const plain = await $.tool.call({ tool: 'Bash', command: bare })
  expect(plain.deny).toBeDefined()
})
