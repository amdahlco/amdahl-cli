// src/next-steps.ts
//
// What a person is pointed to after a run, as lines of human output. Used by
// `optimize` (one message) and `optimize --list` (a batch); never in `--json`.

import { amdahlCommand } from './command-name'
import { field } from './text'

/**
 * What to do once a message is sent, as two lines that each hold a command to
 * paste, with the run's own id and the flags it needs as placeholders:
 * `amdahl sent` (the server needs a send key) and `amdahl feedback`. Empty
 * when there is no run id. `atTerminal`: the person will be asked for what is
 * missing, so the commands are short; anywhere else they are written out in full.
 */
export function sentLines(runId: unknown, lead = 'Sent it?', atTerminal = false): string[] {
  const id = field(runId)
  if (!id) return []
  // At a terminal `sent` and `feedback` ask for what is missing, so the short command is enough.
  if (atTerminal) return [`${lead} ${amdahlCommand('sent')} ${id}`, `Or say how it went: ${amdahlCommand('feedback')} ${id}`]
  return [
    `${lead} ${amdahlCommand('sent')} ${id} --provider <provider> --channel <channel> --sent-as returned --provider-send-id <id>`,
    `Or say how it went: ${amdahlCommand('feedback')} ${id} --evidence did_it_myself --outcome used`,
  ]
}
