// src/commands/recipes.ts
//
// `amdahl recipes`: the console's recipe library, the questions that run as a
// search. `amdahl search --recipe <id> [--<fill-in> <value>]` runs one (search.ts).
// The ids, titles, fill-ins and questions are copied from the console
// (`recipes-data.ts` names the file and commit), so a recipe asks the same
// question here as there.

import { amdahlCommand } from '../command-name'
import { EXIT, usageError } from '../errors'
import { FILL_MAX, NEEDS_LABEL, RECIPES, RECIPE_CATEGORIES, type Recipe } from '../recipes-data'
import { field, wrap } from '../text'
import type { Ctx } from '../context'

/** The flag names a recipe's fill-ins use (`--account`, `--products`, ...): every one is a `search` flag. */
export const FILL_FLAGS = [...new Set(RECIPES.flatMap((r) => r.fills.map((f) => f.key)))]

/** The recipe with this id, or a usage error that names the ids. */
export function recipeById(id: string): Recipe {
  const found = RECIPES.find((r) => r.id === id)
  if (!found) {
    throw usageError(`No recipe called "${field(id).slice(0, 40)}".`, `${amdahlCommand('recipes')} lists them: ${RECIPES.map((r) => r.id).join(', ')}.`)
  }
  return found
}

/** `--account <Account>` for each fill-in of the recipe. */
function fillUsage(recipe: Recipe): string {
  return recipe.fills.map((f) => `--${f.key} <${f.label}>`).join(' ')
}

/** The command that runs a recipe, with an example value for each fill-in. */
export function recipeCommand(recipe: Recipe): string {
  const fills = recipe.fills.map((f) => ` --${f.key} "${f.example}"`).join('')
  return amdahlCommand(`search --recipe ${recipe.id}${fills}`)
}

/**
 * The question a recipe asks, from the fill-ins given. A fill-in has its
 * whitespace collapsed and is cut at {@link FILL_MAX} characters, as the console
 * does; `cut` names the ones that were cut.
 *
 * @throws a usage error when a fill-in is missing, or one is given that the recipe has no use for.
 */
export function recipeQuestion(recipe: Recipe, values: Record<string, string | undefined>): { question: string; cut: string[] } {
  const own = new Set(recipe.fills.map((f) => f.key))
  for (const key of FILL_FLAGS) {
    if (values[key] !== undefined && !own.has(key)) {
      throw usageError(`${recipe.id} has no --${key}.`, recipe.fills.length > 0 ? `It takes ${fillUsage(recipe)}.` : 'It takes no fill-in: just --recipe.')
    }
  }
  let question = recipe.question
  const cut: string[] = []
  for (const fill of recipe.fills) {
    const value = (values[fill.key] ?? '').replace(/\s+/g, ' ').trim()
    if (!value) throw usageError(`${recipe.title} needs --${fill.key} <${fill.label}>.`, `For example: ${recipeCommand(recipe)}`)
    if (value.length > FILL_MAX) cut.push(fill.key)
    question = question.replaceAll(`{${fill.key}}`, value.slice(0, FILL_MAX))
  }
  return { question, cut }
}

/** `amdahl recipes`. */
export async function recipes(ctx: Ctx): Promise<number> {
  const { out } = ctx
  if (out.json) {
    out.result({
      ok: true,
      recipes: RECIPES.map((r) => ({
        id: r.id,
        title: r.title,
        blurb: r.blurb,
        category: r.category,
        needs: r.needs,
        question: r.question,
        fill_ins: r.fills.map((f) => ({ flag: `--${f.key}`, label: f.label, example: f.example })),
        command: recipeCommand(r),
      })),
    })
    return EXIT.ok
  }
  // Every id's column is as wide as the longest id and two spaces, so no id runs into its title.
  const idWidth = Math.max(...RECIPES.map((r) => r.id.length)) + 2
  const lines: string[] = ['Questions the console\'s recipe library asks as a search.']
  for (const category of RECIPE_CATEGORIES) {
    const rows = RECIPES.filter((r) => r.category === category.id)
    if (rows.length === 0) continue
    lines.push('', category.label)
    for (const r of rows) {
      lines.push(`  ${r.id.padEnd(idWidth)}${r.title}`, ...wrap(r.blurb, 80, '    '))
      const needs = NEEDS_LABEL[r.needs]
      const meta = [needs ? `Reads ${needs}.` : '', r.fills.length > 0 ? `Needs ${fillUsage(r)}.` : ''].filter(Boolean).join(' ')
      if (meta) lines.push(...wrap(meta, 80, '    '))
    }
  }
  const sample = RECIPES.find((r) => r.fills.length > 0) ?? RECIPES[0]!
  lines.push('', 'Run one:', `  ${recipeCommand(sample)}`, `The console has more recipes that are prompts for an AI client: ${amdahlCommand('open')}`)
  out.result({}, lines.join('\n'))
  return EXIT.ok
}
