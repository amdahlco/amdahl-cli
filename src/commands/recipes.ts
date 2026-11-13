// src/commands/recipes.ts
//
// `amdahl recipes`: the console's recipe library, the questions that run as a
// search. `amdahl search --recipe <id> [--<fill-in> <value>]` runs one (search.ts).
// The ids, titles, fill-ins and questions are copied from the console
// (`recipes-data.ts` names the file and commit), so a recipe asks the same
// question here as there.

//
// The library is read from the server (`GET /search/suggestions`, which also
// says which recipes suit this workspace now: "For you"). The bundled copy is
// the fallback when that read cannot be made: not signed in, a server without
// the route (a 404), or any failure. It never prints an error of its own.

import { amdahlCommand } from '../command-name'
import { apiClient, resolveCredential, type Ctx } from '../context'
import { EXIT, usageError } from '../errors'
import { FILL_MAX, NEEDS_LABEL, RECIPES, RECIPE_CATEGORIES, type Recipe, type RecipeCategory } from '../recipes-data'
import { field, record, records, wrap } from '../text'

const PLATFORM = '/api/platform/v1'

/** The most "For you" rows shown. */
const FOR_YOU_MAX = 4

/** One suggestion for this workspace: a library recipe, why it suits now, and fill-ins it already knows. */
export interface ForYou {
  recipe_id: string
  kind: string
  reason: string
  fills: Record<string, string>
}

/** The library as the CLI holds it: where it came from, and what suits this workspace now. */
export interface Library {
  recipes: readonly Recipe[]
  categories: readonly { id: string; label: string }[]
  forYou: ForYou[]
  /** `server` when read from `search.suggestions`; `bundled` for the copy in this CLI. */
  source: 'server' | 'bundled'
  generatedAt?: string
  /** The server's message when it has no data to suggest from (nothing connected). */
  setup?: string
}

const BUNDLED: Library = { recipes: RECIPES, categories: RECIPE_CATEGORIES, forYou: [], source: 'bundled' }
const NEEDS: readonly string[] = ['nothing', 'crm', 'calls', 'crm_and_calls']

/** A library recipe from the server's shape, or null when it has no search question. */
function parseRecipe(entry: Record<string, unknown>): Recipe | null {
  const id = field(entry.id)
  const search = record(entry.search)
  const question = typeof search?.question === 'string' ? search.question : ''
  if (!id || !question) return null
  const needs = NEEDS.includes(field(entry.needs)) ? (field(entry.needs) as Recipe['needs']) : 'nothing'
  const fills = records(search?.fills).flatMap((f) => (field(f.key) ? [{ key: field(f.key), label: field(f.label) || field(f.key), example: field(f.example), ...(f.long === true ? { long: true } : {}) }] : []))
  return { id, title: field(entry.title) || id, blurb: field(entry.blurb), category: (field(entry.category) || 'other') as RecipeCategory, needs, question, fills }
}

/** The categories the recipes use: the known ones in their order, then any new one, named from its id. */
function categoriesOf(recipes: readonly Recipe[]): { id: string; label: string }[] {
  const known = RECIPE_CATEGORIES.filter((c) => recipes.some((r) => r.category === c.id))
  const extra = [...new Set(recipes.map((r) => r.category as string))].filter((id) => !RECIPE_CATEGORIES.some((c) => c.id === id))
  return [...known, ...extra.map((id) => ({ id, label: id.charAt(0).toUpperCase() + id.slice(1).replace(/[_-]/g, ' ') }))]
}

/**
 * The recipe library, from the server when it can be read (signed in, the route
 * exists, the answer has recipes), else the bundled copy. Never throws and never
 * prints: a server without the route (a 404) is the same as no server.
 */
export async function loadLibrary(ctx: Ctx): Promise<Library> {
  try {
    const credential = await resolveCredential(ctx)
    const answer = await apiClient(ctx, credential).request<Record<string, unknown>>(`${PLATFORM}/search/suggestions`)
    const recipes = records(answer.library).flatMap((e) => parseRecipe(e) ?? [])
    if (recipes.length === 0) return BUNDLED
    const forYou = records(answer.for_you).flatMap((s) => {
      const recipe_id = field(s.recipe_id)
      if (!recipes.some((r) => r.id === recipe_id)) return []
      const fills = Object.fromEntries(Object.entries(record(s.fills) ?? {}).flatMap(([k, v]) => (typeof v === 'string' && v.trim() ? [[k, v.trim()]] : [])))
      return [{ recipe_id, kind: field(s.kind), reason: field(s.reason), fills }]
    })
    const setup = field(record(answer.setup_needed)?.message)
    return { recipes, categories: categoriesOf(recipes), forYou: forYou.slice(0, FOR_YOU_MAX), source: 'server', ...(field(answer.generated_at) ? { generatedAt: field(answer.generated_at) } : {}), ...(setup ? { setup } : {}) }
  } catch {
    return BUNDLED
  }
}

/** The flag names a recipe's fill-ins use (`--account`, `--products`, ...): every one is a `search` flag. */
export const FILL_FLAGS = [...new Set(RECIPES.flatMap((r) => r.fills.map((f) => f.key)))]

/** The recipe with this id, or a usage error that names the ids. */
export function recipeById(id: string, library: Library = BUNDLED): Recipe {
  const found = library.recipes.find((r) => r.id === id)
  if (!found) {
    throw usageError(`No recipe called "${field(id).slice(0, 40)}".`, `${amdahlCommand('recipes')} lists them: ${library.recipes.map((r) => r.id).join(', ')}.`)
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
  const library = await loadLibrary(ctx)
  const forYouOf = (s: ForYou) => {
    const recipe = library.recipes.find((r) => r.id === s.recipe_id)!
    return { recipe, command: amdahlCommand(`search --recipe ${s.recipe_id}${Object.entries(s.fills).map(([k, v]) => ` --${k} "${v.replace(/"/g, '\\"')}"`).join('')}`) }
  }
  if (out.json) {
    out.result({
      ok: true,
      source: library.source,
      ...(library.generatedAt ? { generated_at: library.generatedAt } : {}),
      for_you: library.forYou.map((s) => ({ recipe_id: s.recipe_id, title: forYouOf(s).recipe.title, kind: s.kind, reason: s.reason, fills: s.fills, command: forYouOf(s).command })),
      ...(library.setup ? { setup_needed: { message: library.setup } } : {}),
      recipes: library.recipes.map((r) => ({
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
  const idWidth = Math.max(...library.recipes.map((r) => r.id.length)) + 2
  const lines: string[] = ['Questions the console\'s recipe library asks as a search.']
  // "For you": the recipes that suit this workspace now, each with why. Nothing to hide here: only the console can.
  if (library.forYou.length > 0) {
    lines.push('', 'For you')
    for (const s of library.forYou) {
      const { recipe, command } = forYouOf(s)
      lines.push(`  ${s.recipe_id.padEnd(idWidth)}${recipe.title}`)
      if (s.reason) lines.push(...wrap(`${s.reason}.`.replace(/\.\.$/, '.'), 80, '    '))
      lines.push(...wrap(`Run: ${command}`, 80, '    '))
    }
  } else if (library.setup) {
    lines.push('', ...wrap(library.setup))
  }
  for (const category of library.categories) {
    const rows = library.recipes.filter((r) => r.category === category.id)
    if (rows.length === 0) continue
    lines.push('', category.label)
    for (const r of rows) {
      lines.push(`  ${r.id.padEnd(idWidth)}${r.title}`, ...wrap(r.blurb, 80, '    '))
      const needs = NEEDS_LABEL[r.needs]
      const meta = [needs ? `Reads ${needs}.` : '', r.fills.length > 0 ? `Needs ${fillUsage(r)}.` : ''].filter(Boolean).join(' ')
      if (meta) lines.push(...wrap(meta, 80, '    '))
    }
  }
  const sample = library.recipes.find((r) => r.fills.length > 0) ?? library.recipes[0]!
  lines.push('', 'Run one:', `  ${recipeCommand(sample)}`, `The console has more recipes that are prompts for an AI client: ${amdahlCommand('open')}`)
  out.result({}, lines.join('\n'))
  return EXIT.ok
}
