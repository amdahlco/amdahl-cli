// src/ci.ts
//
// Whether this runs in CI, for the commands that would otherwise ask a
// question at a terminal (bare `amdahl`, `amdahl optimize` with no file).

/** A variable that is set and not `false` or `0`. */
const isSet = (value: string | undefined) => Boolean(value) && value !== 'false' && value !== '0'

/**
 * The CI system this runs in, as the variable that says so, or null. `CI`
 * covers most; Jenkins, Azure Pipelines, AWS CodeBuild and TeamCity do not
 * set it. BUILD_NUMBER alone is too common a name, so it counts only beside
 * JENKINS_HOME.
 */
export function ciVariable(env: Record<string, string | undefined>): string | null {
  const named = ['CI', 'JENKINS_URL', 'TF_BUILD', 'CODEBUILD_BUILD_ID', 'TEAMCITY_VERSION', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI'].find((name) => isSet(env[name]))
  if (named) return named
  return isSet(env.BUILD_NUMBER) && isSet(env.JENKINS_HOME) ? 'BUILD_NUMBER with JENKINS_HOME' : null
}
