import { Glob } from 'bun'
import { scenarioSchema } from './runner'

/** Every scenario file of the repo, parsed. */
export async function loadScenarios() {
  const dir = new URL('../../conformance/scenarios/', import.meta.url).pathname
  const files = [...new Glob('*.json').scanSync(dir)].sort()
  return Promise.all(
    files.map(async (file) => ({
      file,
      scenario: scenarioSchema.parse(await Bun.file(`${dir}${file}`).json()),
    }))
  )
}
