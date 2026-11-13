// src/recipes-data.ts
//
// The console's recipe library: the recipes that run as a search, with the same
// ids, titles, blurbs, fill-ins and search questions.
//
// Copied from amdahl-frontend, apps/universal-ui/lib/prompt-library.ts, as of
// commit dd187f42d94617414eda3f35c36e891854a343d1 (the last commit to touch that
// file; origin/main was 2054c61952728815107506839d44c4a21650c4ce on 2026-11-13).
// Only the 12 entries that have a `search` are here: the other 5 are prompts
// for an AI client or the optimizer, and have no search question. The prompt
// bodies are not copied. A change to the library there belongs here too.

export type RecipeCategory = 'accounts' | 'expansion' | 'pipeline' | 'messaging' | 'outbound'

/** What a person fills in before the recipe can run (`{key}` in the question). */
export interface RecipeFill {
  key: string
  label: string
  example: string
  long?: boolean
}

export interface Recipe {
  id: string
  title: string
  blurb: string
  category: RecipeCategory
  needs: 'nothing' | 'crm' | 'calls' | 'crm_and_calls'
  /** The search question, with `{key}` where a fill-in goes. */
  question: string
  fills: readonly RecipeFill[]
}

export const RECIPE_CATEGORIES: readonly { id: RecipeCategory; label: string }[] = [
  { id: 'accounts', label: 'Accounts' },
  { id: 'expansion', label: 'Expansion' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'messaging', label: 'Messaging' },
  { id: 'outbound', label: 'Outbound' },
]

export const NEEDS_LABEL: Readonly<Record<Recipe['needs'], string>> = {
  nothing: '',
  crm: 'your CRM',
  calls: 'your calls',
  crm_and_calls: 'your CRM and calls',
}

/** The longest a fill-in may be, in characters (the console cuts it there). */
export const FILL_MAX = 300

export const RECIPES: readonly Recipe[] = [
  {
    id: "account-brief",
    title: "Account brief",
    blurb: "What they told us, who we know, open deals and who is missing",
    category: "accounts",
    needs: "crm_and_calls",
    question: "Brief me on {account}: why they talk to us in their own words, who we have spoken with there by seniority and when each last spoke, their open deals, who we have never reached, and the three things to raise next.",
    fills: [{ key: "account", label: "Account", example: "Acme" }],
  },
  {
    id: "call-prep",
    title: "Call prep and follow-ups",
    blurb: "A one-page brief and two follow-up drafts, ready before the call",
    category: "accounts",
    needs: "crm_and_calls",
    question: "Prep me for my call with {account}: what they care about, who we know there by seniority, which deals are open, three things to raise, and the two likely objections with the answer that worked with other buyers.",
    fills: [{ key: "account", label: "Account", example: "Acme" }],
  },
  {
    id: "qbr-prep",
    title: "QBR and renewal prep",
    blurb: "A one-page review: value delivered, risks, people and next asks",
    category: "accounts",
    needs: "crm_and_calls",
    question: "Prep my QBR with {account}: why they bought in their own words and whether later calls show we delivered it, wins and complaints since then, who we reach now compared with before they signed, risks to the renewal, and the two expansion asks with the best evidence.",
    fills: [{ key: "account", label: "Account", example: "Acme" }],
  },
  {
    id: "expansion-signals",
    title: "Expansion signals",
    blurb: "Customers showing signs they will buy more, ranked, with quotes",
    category: "expansion",
    needs: "crm_and_calls",
    question: "Which current customers showed expansion signals in the last 90 days, such as new teams or regions, pain a product they do not own solves, more senior people on calls, budget timing or a renewal coming up? Rank them, with a quote for each.",
    fills: [],
  },
  {
    id: "churn-risk",
    title: "Early churn warnings",
    blurb: "Customers at risk, why, and whether anyone has responded",
    category: "expansion",
    needs: "crm_and_calls",
    question: "Which current customers show early churn risk, such as a stalled rollout, a workaround, questions about price or contract terms, a competitor named or a champion leaving, and did our side respond?",
    fills: [],
  },
  {
    id: "whitespace",
    title: "Whitespace by account",
    blurb: "What each customer could still buy, and the pain behind each gap",
    category: "expansion",
    needs: "crm_and_calls",
    question: "Which current customers describe a need that {products} would meet, and have they bought it? Give the strongest quote for each gap.",
    fills: [{ key: "products", label: "Your products", example: "Analytics, Forecasting, Extra seats" }],
  },
  {
    id: "asked-for-never-sold",
    title: "Asked for, never sold",
    blurb: "What customers asked for that no deal followed",
    category: "expansion",
    needs: "crm_and_calls",
    question: "What have our customers asked for that we never sold them? Group the asks by how many accounts raised them, with their words and dates.",
    fills: [],
  },
  {
    id: "stalled-deals",
    title: "Stalled deal review",
    blurb: "Open deals gone quiet, what was last said, and a next step",
    category: "pipeline",
    needs: "crm",
    question: "Which open deals have had no conversation with the buyer in 30 days or are past their close date, and what did the buyer say last?",
    fills: [],
  },
  {
    id: "why-deals-die",
    title: "Why we lose deals",
    blurb: "Lost deals grouped by what killed them, and what would have helped",
    category: "pipeline",
    needs: "crm_and_calls",
    question: "Why do we lose deals? Group our closed-lost deals from the last two quarters by what killed them, and name the proof that would have answered each group.",
    fills: [],
  },
  {
    id: "competitors",
    title: "Competitors in buyer words",
    blurb: "Who buyers name, why we win or lose, and quotes for each",
    category: "pipeline",
    needs: "crm_and_calls",
    question: "Which competitors and alternatives do buyers name on calls, and why do we win or lose against each one?",
    fills: [],
  },
  {
    id: "positioning-vs-buyers",
    title: "Positioning vs buyer words",
    blurb: "Where our messages match how buyers talk, and where they do not",
    category: "messaging",
    needs: "crm_and_calls",
    question: "Compare these messages with how buyers describe the problem in their own words: {messages}. Where do buyers use our words, and what do they keep raising that we never say?",
    fills: [{ key: "messages", label: "Your messages", example: "Ship in days, not months. One price for every seat.", long: true }],
  },
  {
    id: "objection-handling",
    title: "Objection answers that work",
    blurb: "How buyers raise an objection, and the answers that moved deals",
    category: "messaging",
    needs: "crm_and_calls",
    question: "How do buyers raise {objection}, how do executives put it differently from managers, and which of our answers came before deals moved forward?",
    fills: [{ key: "objection", label: "Objection", example: "Too expensive" }],
  },
]
