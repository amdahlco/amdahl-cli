// src/skill.ts
//
// The Amdahl capability map (an agent skill), bundled into the CLI from
// skill/SKILL.md. `pnpm sync:skill` refreshes that file from SKILL_URL.

import { join } from 'node:path'
import SKILL from '../skill/SKILL.md'

/** Where the capability map is published. */
export const SKILL_URL = 'https://docs.amdahl.ai/skills/amdahl/SKILL.md'

/** The bundled SKILL.md text. */
export const SKILL_TEXT: string = SKILL

/**
 * Each client's documented user-level skills directory:
 * Claude Code `~/.claude/skills` (code.claude.com/docs/en/skills),
 * Codex `$HOME/.agents/skills` (developers.openai.com/codex/skills),
 * Cursor `~/.cursor/skills` (cursor.com/docs/skills).
 */
const SKILL_DIRS: Record<'claude-code' | 'codex' | 'cursor', string[]> = {
  'claude-code': ['.claude', 'skills'],
  codex: ['.agents', 'skills'],
  cursor: ['.cursor', 'skills'],
}

/** Where `amdahl install <client>` writes the skill. */
export function skillPath(client: keyof typeof SKILL_DIRS, home: string): string {
  return join(home, ...SKILL_DIRS[client], 'amdahl', 'SKILL.md')
}
