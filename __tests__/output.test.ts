// Which terminals get a clickable sign-in link (OSC 8), and what the link is.

import { describe, expect, it } from 'vitest'
import { hyperlink, supportsHyperlinks } from '../src/output'

describe('supportsHyperlinks', () => {
  it.each<[string, Record<string, string>, boolean, boolean]>([
    ['iTerm2', { TERM_PROGRAM: 'iTerm.app' }, true, true],
    ['VS Code', { TERM_PROGRAM: 'vscode' }, true, true],
    ['Warp', { TERM_PROGRAM: 'WarpTerminal' }, true, true],
    ['Terminal.app', { TERM_PROGRAM: 'Apple_Terminal' }, true, true],
    ['WezTerm', { TERM_PROGRAM: 'WezTerm' }, true, true],
    ['Ghostty', { TERM_PROGRAM: 'ghostty' }, true, true],
    ['VTE 0.50 (GNOME Terminal)', { VTE_VERSION: '5000' }, true, true],
    ['VTE 0.48', { VTE_VERSION: '4802' }, true, false],
    ['Windows Terminal', { WT_SESSION: 'abc' }, true, true],
    ['an unknown terminal', { TERM_PROGRAM: 'tmux' }, true, false],
    ['nothing set', {}, true, false],
    ['a known terminal without colour (NO_COLOR, --no-color, TERM=dumb, not a terminal)', { TERM_PROGRAM: 'iTerm.app' }, false, false],
    ['FORCE_HYPERLINK=0 in a known terminal', { TERM_PROGRAM: 'iTerm.app', FORCE_HYPERLINK: '0' }, true, false],
    ['FORCE_HYPERLINK=1 anywhere, colour or not', { FORCE_HYPERLINK: '1' }, false, true],
  ])('%s', (_name, env, color, expected) => {
    expect(supportsHyperlinks(env, color)).toBe(expected)
  })
})

describe('hyperlink', () => {
  it('wraps the text in OSC 8, with no control characters from the URL', () => {
    expect(hyperlink('Open the sign-in page', 'https://example.com/a?b=1\u001b\\x')).toBe(
      '\u001b]8;;https://example.com/a?b=1\\x\u001b\\Open the sign-in page\u001b]8;;\u001b\\'
    )
  })
})
