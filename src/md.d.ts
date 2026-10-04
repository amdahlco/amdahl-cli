// src/md.d.ts
//
// Markdown files import as their text. tsup's `.md` text loader and the
// transform in vitest.config.ts both provide it.

declare module '*.md' {
  const text: string
  export default text
}
