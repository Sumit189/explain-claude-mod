import { expect, test } from 'claude-code/testing'

import { FORMATS } from './register'

test('sticky mode attaches the format to each prompt until off', async ($, on) => {
  const seen: (readonly string[] | undefined)[] = []
  on('prompt.submit', ($, e) => {
    seen.push(e.context)
    return { text: e.text, context: e.context }
  })

  await $.command.run({ command: 'explain', args: 'ste' })
  await $.prompt.submit({ text: 'how does TCP work' })
  await $.prompt.submit({ text: 'and UDP' })
  await $.command.run({ command: 'explain', args: 'off' })
  await $.prompt.submit({ text: 'thanks' })

  expect(seen[0]).toEqual([FORMATS.ste])
  expect(seen[1]).toEqual([FORMATS.ste])
  expect(seen[2]).toBeUndefined()
})

test('unknown format prints usage', async $ => {
  const out = await $.command.run({ command: 'explain', args: 'podcast' })
  expect(out.text).toContain('Usage')
})

test('picker band switches the mode', async ($, on) => {
  let context: readonly string[] | undefined
  on('prompt.submit', ($, e) => {
    context = e.context
    return { text: e.text, context: e.context }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    await $.command.run({ command: 'explain', args: '' })
    const band = await $.ui.mount({ plugin: 'explain-as', surface, component: 'AbovePrompt', props: { hasSurvey: false } })
    await band.press({ key: 'html' })
    await $.prompt.submit({ text: 'q' })
    expect(context).toEqual([FORMATS.html])
    await band.press({ key: 'off' })
    await $.prompt.submit({ text: 'q' })
    expect(context).toBeUndefined()
    await band.press({ key: 'close' })
  }
})

test('show tool refuses an unknown kind', async $ => {
  const out = await $.tool.call({ tool: 'mcp__explain-as__show', name: 'x', kind: 'podcast', source: 'a' })
  expect(out.deny).toContain('kind')
})

