#!/usr/bin/env node
// bin/amdahl.js
//
// The `amdahl` command. It checks the Node.js version before it loads the
// CLI: dist/amdahl.js is built for Node 22, and an older Node fails to parse
// it or crashes in it, while npx only warns about `engines`. So this file
// uses no syntax newer than Node 14 (no `??=`, no top-level await, no class
// fields), and an old Node can run it far enough to say what to do.

var version = process.versions.node
var major = parseInt(version.split('.')[0], 10)

if (!(major >= 22)) {
  process.stderr.write(
    'amdahl needs Node.js 22 or later. This computer has Node.js ' +
      version +
      '.\nInstall a newer one from https://nodejs.org/en/download, then run the same command again.\n'
  )
  process.exitCode = 1
} else {
  import('../dist/amdahl.js')
}
