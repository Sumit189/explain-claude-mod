import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

export const FORMATS: Record<string, string> = {
  ste:
    'Write the explanation about 80% of the way to ASD-STE100 Simplified Technical English: ' +
    'short sentences (max 20 words for steps, 25 for descriptions), one instruction per sentence, ' +
    'active voice, simple approved words with one meaning each, no idioms or filler. ' +
    'Keep code, identifiers and technical names exactly as they are.',
  diagram:
    'Explain with a diagram first, prose second. Write a Mermaid diagram that shows the real mechanism ' +
    '(prefer `flowchart TD` or a layout about 3:2 wide; it is shown in a 3:2 pane, so avoid long single rows) ' +
    '(components, flow, state) and pass it to the mcp__explain-as__show tool with kind "diagram" (not the Write ' +
    'tool): it is rendered and shown as a picture inside Claude Code. Do not paste the Mermaid source in the reply; ' +
    'give short captions only.',
  html:
    'Deliver the explanation as one self-contained, interactive HTML page (inline CSS and JS, no build step): ' +
    'clear visual hierarchy, diagrams, and controls or animations where they aid understanding. ' +
    'Pass it to the mcp__explain-as__show tool with kind "html" (not the Write tool): a screenshot of its ' +
    'first 1200x800 screen is shown inside Claude Code, so put the key picture there. ' +
    'Do not paste the HTML in the reply; summarize it in two or three lines.',
  video:
    'Make a 3Blue1Brown-style explainer video as one self-contained web page and pass it to the ' +
    'mcp__explain-as__show tool with kind "video" (not the Write tool); it opens and plays in Chrome. ' +
    'Draw on a 1920x1080 <canvas> scaled to the window: dark background, smooth eased transitions, shapes and ' +
    'equations that build up and transform step by step. Split it into timed scenes driven by one clock, with ' +
    'play/pause, a seek bar and arrow-key scene skipping. Narrate each scene with on-screen captions. ' +
    'By default use the device\'s own text-to-speech through the browser speechSynthesis API, picking the best ' +
    'local English voice (prefer names with "Premium", "Enhanced" or "Natural"). Only if the ELEVENLABS_API_KEY ' +
    'environment variable is set (check with `[ -n "$ELEVENLABS_API_KEY" ]`, never print it), generate one mp3 per ' +
    'scene into `.explain/<short-name>/` with curl before showing the page and play them in sync instead ' +
    '(relative paths from `.explain/`); ' +
    'never put the key in the page. ' +
    'Add a "Record" button that saves a .webm of the canvas (and the mp3 audio, if any) with MediaRecorder. ' +
    'No build step, no external libraries. In the reply give the scene list only.',
}

const LABELS: Record<string, string> = { ste: 'STE', diagram: 'Diagram', html: 'HTML', video: 'Video' }
const LOOK = {
  off: { icon: '○', color: 'gray', blurb: 'Claude answers as usual' },
  ste: { icon: '¶', color: 'cyan', blurb: 'short, plain sentences in Simplified Technical English' },
  diagram: { icon: '◇', color: 'green', blurb: 'a rendered diagram in a pane, short captions after' },
  html: { icon: '◱', color: 'magenta', blurb: 'a web page, previewed in a pane' },
  video: { icon: '▶', color: 'yellow', blurb: 'a 3Blue1Brown-style narrated animation that plays in Chrome' },
}
const lookOf = (fmt: string | null) => LOOK[(fmt ?? 'off') as keyof typeof LOOK]
const HINT = `[${Object.keys(FORMATS).join('|')}|off|show] [topic]`
const PANE = 'explain-preview'
const SOURCE = /\/\.explain\/[^/]+\.(html|mmd)$/
const VIDEO = /\.video\.html$/
const BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  'google-chrome',
  'chromium',
]
const SIZE = { width: 1200, height: 800 }
const EXTENSIONS = { diagram: '.mmd', html: '.html', video: '.video.html' }

const mode = atom({ plugin: 'explain-as', key: 'mode' } as const, null)
const isPickerOpen = atom({ plugin: 'explain-as', key: 'isPickerOpen' } as const, false)
const preview = atom({ plugin: 'explain-as', key: 'preview' } as const, null)
const view = atom({ plugin: 'explain-as', key: 'view' } as const, { zoom: 1, x: 0.5, y: 0.5 })
const SCALE = 2 // screenshots are taken at 2x so a zoomed crop stays sharp

// Crops the screenshot to the zoom and pan in `view`, for the terminal pane.
async function applyView($: EngineInterface) {
  const shown = await read($, preview)
  if (!shown) {
    return
  }
  const { zoom, x, y } = await read($, view)
  const [fullW, fullH] = [SIZE.width * SCALE, SIZE.height * SCALE]
  const [w, h] = [Math.round(fullW / zoom), Math.round(fullH / zoom)]
  const left = Math.round(Math.min(Math.max(x * fullW - w / 2, 0), fullW - w))
  const top = Math.round(Math.min(Math.max(y * fullH - h / 2, 0), fullH - h))
  const cropped = `${shown.png}.view.png`
  // ponytail: needs ffmpeg (sips ignores --cropOffset); without it zoom stays at 100%.
  const run = zoom === 1
    ? null
    : await $.process
        .run(['ffmpeg', '-y', '-loglevel', 'error', '-i', shown.png, '-vf', `crop=${w}:${h}:${left}:${top}`, cropped])
        .catch(() => null)
  if (zoom !== 1 && run?.exitCode !== 0) {
    $.ui.toast('explain: zoom needs ffmpeg (brew install ffmpeg)')
  }
  await update($, preview, () => ({ ...shown, view: run?.exitCode === 0 ? cropped : null, generation: Date.now() }))
}

async function moveView($: EngineInterface, change: { zoom?: number; dx?: number; dy?: number } | null) {
  await update($, view, ({ zoom, x, y }) => {
    if (!change) {
      return { zoom: 1, x: 0.5, y: 0.5 }
    }
    const next = Math.min(8, Math.max(1, zoom * (change.zoom ?? 1)))
    const edge = 0.5 / next
    const clamp = (v: number) => Math.min(1 - edge, Math.max(edge, v))
    return { zoom: next, x: clamp(x + (change.dx ?? 0) / next), y: clamp(y + (change.dy ?? 0) / next) }
  })
  await applyView($)
}

async function setMode($: EngineInterface, fmt: string | null) {
  await update($, mode, () => fmt)
  $.ui.status(fmt ? `explain: ${LABELS[fmt]}` : undefined)
}

function mermaidPage(source: string) {
  const escaped = source.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  return `<!doctype html><html><head><style>
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#fff}
svg{width:96vw!important;max-width:none!important;max-height:96vh}
</style></head><body><pre class="mermaid">${escaped}</pre><script type="module">
import m from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'
m.initialize({ startOnLoad: true, theme: 'default' })
</script></body></html>`
}

// Screenshots `.explain/*.html` (or a Mermaid `.mmd`, wrapped in a page) and shows it in the pane.
// ponytail: static screenshot of the first screen; the page's interactivity stays in the browser.
// Opens a `.video.html` explainer in Chrome so it plays there.
async function playVideo($: EngineInterface, path: string) {
  for (const argv of [['open', '-a', 'Google Chrome', path], ['open', path], ['xdg-open', path]]) {
    try {
      if ((await $.process.run(argv)).exitCode === 0) {
        $.ui.toast(`explain: playing ${path.split('/').pop()} in the browser`)
        return
      }
    } catch {
      // not on this platform, try the next one
    }
  }
  $.ui.toast(`explain: open ${path} in a browser to play it`)
}

// Refreshes any Chrome tab already showing the page, so "live" stays current as Claude updates it.
// ponytail: macOS + Chrome only (AppleScript); other browsers need a manual refresh.
async function refreshLive($: EngineInterface, page: string) {
  const url = `file://${page}`.replaceAll('"', '\\"')
  const script = [
    'if application "Google Chrome" is running then',
    '  tell application "Google Chrome"',
    '    repeat with w in windows',
    `      repeat with t in (tabs of w whose URL is "${url}")`,
    '        reload t',
    '      end repeat',
    '    end repeat',
    '  end tell',
    'end if',
  ].join('\n')
  await $.process.run(['osascript', '-e', script]).catch(() => null)
}

async function showPreview($: EngineInterface, path: string) {
  const page = path.endsWith('.mmd') ? `${path}.html` : path
  if (page !== path) {
    await $.fs.write(page, mermaidPage(await $.fs.read(path)))
  }
  const png = `${path}.png`
  const args = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${SIZE.width},${SIZE.height}`,
    `--force-device-scale-factor=${SCALE}`,
    '--virtual-time-budget=8000', `--screenshot=${png}`, `file://${page}`,
  ]
  for (const browser of BROWSERS) {
    try {
      const run = await $.process.run([browser, ...args], { timeoutMs: 60_000 })
      if (run.exitCode === 0) {
        // The desktop panel draws the picture inside an Svg, capped at 131072 characters: a small JPEG fits.
        // ponytail: sips is macOS only; elsewhere the desktop panel shows the link alone.
        const jpg = `${path}.jpg`
        const shrunk = await $.process
          .run(['sips', '-Z', '1000', '-s', 'format', 'jpeg', '-s', 'formatOptions', '55', png, '--out', jpg])
          .catch(() => null)
        const isVideo = VIDEO.test(path)
        await update($, view, () => ({ zoom: 1, x: 0.5, y: 0.5 }))
        void refreshLive($, page)
        await update($, preview, () => ({ png, page, jpg: shrunk?.exitCode === 0 ? jpg : null, view: null, isVideo, generation: Date.now() }))
        const opened = await $.ui.open({ id: PANE, title: `explain · ${path.split('/').pop()}` })
        if (!opened.isPlaced) {
          $.ui.toast('explain: preview ready, run /explain show')
        }
        return
      }
    } catch {
      // not installed here, try the next one
    }
  }
  $.ui.toast('explain: no Chrome, Chromium or Brave found to render the preview')
}

export const register: Register = on => {
  let once: string | undefined // applies to the next prompt only

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'explain',
      description: 'Answer as ASD-STE100 prose, a diagram, an HTML page, or a video',
      argumentHint: HINT,
    })
    // The mod writes the file itself, so showing a picture needs no Write permission.
    await $.tool.register({
      name: 'show',
      description:
        'Save an explanation into .explain/ in the working directory and show it to the user inside Claude Code: ' +
        'a Mermaid diagram or HTML page is rendered as a picture in a pane, a video page opens and plays in Chrome. ' +
        'Pass the whole source each time; calling again with the same name replaces it.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'short kebab-case name, e.g. "tcp-handshake"' },
          kind: { type: 'string', enum: Object.keys(EXTENSIONS) },
          source: { type: 'string', description: 'the Mermaid text, or the whole self-contained HTML page' },
        },
        required: ['name', 'kind', 'source'],
      },
    })
    const fmt = await read($, mode)
    $.ui.status(fmt ? `explain: ${LABELS[fmt]}` : undefined)

    return next(e)
  })

  on('command.run', { command: 'explain' }, async ($, e) => {
    const [fmt = '', ...rest] = e.args.trim().split(/\s+/)
    const topic = rest.join(' ')

    if (fmt === '') {
      await update($, isPickerOpen, open => !open)
      return { text: 'explain: picker toggled' }
    }
    if (fmt === 'show') {
      const shown = await read($, preview)
      if (!shown) {
        return { text: 'explain: nothing to show yet' }
      }
      await $.ui.open({ id: PANE, title: 'explain preview', focus: true })
      return { text: 'explain: preview opened' }
    }
    if (fmt === 'off') {
      await setMode($, null)
      return { text: 'explain: off' }
    }
    if (!(fmt in FORMATS)) {
      return { text: `Usage: /explain ${HINT}` }
    }
    if (topic) {
      once = fmt
      void $.prompt.submit({ text: topic, asUser: true })
      return { text: `explain (${fmt}): ${topic}` }
    }
    await setMode($, fmt)
    return { text: `explain: every answer as ${fmt} until /explain off` }
  })

  on('prompt.submit', async ($, e, next) => {
    const rule = FORMATS[once ?? (await read($, mode)) ?? '']
    once = undefined
    if (!rule) {
      return next(e)
    }
    return next({ ...e, context: [...(e.context ?? []), rule] })
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (VIDEO.test(e.file_path) && ran.deny === undefined && !ran.isError) {
      await playVideo($, e.file_path)
    } else if (SOURCE.test(e.file_path) && ran.deny === undefined && !ran.isError) {
      await showPreview($, e.file_path)
    }
    return ran
  })

  // The cast only quiets tsc: the plugin's own MCP tool is not in the generated tool names until it loads.
  on('tool.call', { tool: 'mcp__explain-as__show' as 'Bash' }, async ($, e) => {
    const { name, kind, source } = e as unknown as { name: string; kind: keyof typeof EXTENSIONS; source: string }
    const slug = String(name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'explain'
    if (!(kind in EXTENSIONS) || typeof source !== 'string' || !source.trim()) {
      return { deny: 'show needs kind "diagram", "html" or "video" and a non-empty source.' }
    }
    const path = `${await $.session.cwd()}/.explain/${slug}${EXTENSIONS[kind]}`
    await $.fs.write(path, source)
    if (kind === 'video') {
      await showPreview($, path)
      await playVideo($, path)
      return { result: `Saved ${path} and opened it in the browser.` }
    }
    await showPreview($, path)
    return { result: `Saved ${path} and showed it to the user in a pane.` }
  })

  // An edited video is not reopened: reloading the tab already playing it is enough.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (SOURCE.test(e.file_path) && !VIDEO.test(e.file_path) && ran.deny === undefined && !ran.isError) {
      await showPreview($, e.file_path)
    }
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link } = $.ui.resolve(e)
    const shown = await read($, preview)
    if (!shown) {
      return <Text dimColor>No preview yet.</Text>
    }
    const link = (
      <Link href={`file://${shown.page}`} label={shown.isVideo ? '▶ play live in browser' : '● live in browser'} />
    )
    if (e.surface !== 'terminal') {
      const { Svg } = $.ui.resolve(e)
      const jpeg = shown.jpg ? await $.fs.read(shown.jpg, { as: 'bytes' }).catch(() => null) : null
      const svg = jpeg
        ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE.width} ${SIZE.height}">` +
          `<image href="data:image/jpeg;base64,${jpeg.base64}" width="${SIZE.width}" height="${SIZE.height}"/></svg>`
        : ''
      return (
        <Box flexDirection="column" gap={1}>
          {svg && svg.length <= 131072 && <Svg source={svg} alt="explain preview" />}
          {link}
        </Box>
      )
    }
    const { Button, Image } = $.ui.resolve(e)
    const { zoom } = await read($, view)
    // A terminal cell is about twice as tall as it is wide.
    const columns = Math.min(255, e.props.bodyColumns)
    const rows = Math.min(255, Math.max(1, e.props.scroll.bodyRows - 4), Math.round((columns * SIZE.height) / SIZE.width / 2))
    const control = (key: string, label: string, onPress: () => unknown) => (
      <Button key={key} label={label} hotkey={key} plain onPress={onPress} />
    )
    return (
      <Box flexDirection="column">
        <Image
          source={{ file: shown.view ?? shown.png, format: 'png', generation: shown.generation }}
          columns={columns}
          rows={rows}
          alt="explain preview"
        />
        <Box gap={2} flexWrap="wrap">
          {control('i', 'zoom in', () => moveView($, { zoom: 1.5 }))}
          {control('o', 'zoom out', () => moveView($, { zoom: 1 / 1.5 }))}
          {control('h', '←', () => moveView($, { dx: -0.25 }))}
          {control('j', '↓', () => moveView($, { dy: 0.25 }))}
          {control('k', '↑', () => moveView($, { dy: -0.25 }))}
          {control('l', '→', () => moveView($, { dx: 0.25 }))}
          {control('r', 'reset', () => moveView($, null))}
          <Button key="live" label={shown.isVideo ? '▶ play live' : '● live'} hotkey="v" variant="primary" onPress={() => $.process.run(['open', shown.page])} />
          <Text dimColor>{Math.round(zoom * 100)}%</Text>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, mode)
    if (e.props.hasSurvey || !(await read($, isPickerOpen))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const choices: [string | null, string][] = [[null, 'Off'], ...Object.entries(LABELS)]
    const look = lookOf(current)

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={look.color} paddingX={1}>
        <Box justifyContent="space-between">
          <Text>
            <Text color={look.color} bold>✦ explain as</Text>
            <Text dimColor>  pick how Claude answers</Text>
          </Text>
          <Button key="close" label="×" plain role="dismiss" dimColor onPress={() => update($, isPickerOpen, () => false)} />
        </Box>
        <Box gap={2} marginTop={1}>
          {choices.map(([fmt, label], i) => (
            <Button
              key={fmt ?? 'off'}
              label={`${lookOf(fmt).icon} ${label}`}
              hotkey={String(i)}
              plain={fmt === current ? undefined : true}
              variant={fmt === current ? 'primary' : undefined}
              dimColor={fmt !== current}
              onPress={() => setMode($, fmt)}
            />
          ))}
        </Box>
        <Text>
          <Text color={look.color}>▸ </Text>
          <Text italic dimColor>{look.blurb}</Text>
        </Text>
      </Box>
    )
  })
}
