import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Import `.md` files as their text, like tsup's text loader in the build.
  plugins: [
    {
      name: 'md-text',
      transform(code, id) {
        if (id.endsWith('.md')) return { code: `export default ${JSON.stringify(code)}`, map: null }
      },
    },
  ],
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    testTimeout: 20000,
  },
})
