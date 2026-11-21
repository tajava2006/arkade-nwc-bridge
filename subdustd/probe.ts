import type { Logger } from './log.ts'

export interface ProbeTarget<T> {
  name: string
  ask: () => Promise<T>
  /** A reason to refuse to run (wrong chain), or undefined. */
  mismatch: (answer: T) => string | undefined
  describe: (answer: T) => string
}

/**
 * Boot-time look at a dependency, in the background. A mismatch is fatal (a
 * regtest config against a mainnet node would act on real money with drill
 * knobs). Silence is not: old swaps still need settling and refunding, and new
 * swaps refuse on their own until the dependency answers. Resolves with the
 * first answer, or undefined if stopped or fatal.
 */
export const probeUntilAnswered = async <T>(
  target: ProbeTarget<T>,
  log: Logger,
  onFatal: (reason: string) => void,
  opts: { retryMs?: number; stopped?: () => boolean } = {},
): Promise<T | undefined> => {
  const retryMs = opts.retryMs ?? 10_000
  for (let attempt = 1; !opts.stopped?.(); attempt++) {
    try {
      const answer = await target.ask()
      const mismatch = target.mismatch(answer)
      if (mismatch) {
        onFatal(mismatch)
        return undefined
      }
      log.info(target.describe(answer))
      return answer
    } catch (e) {
      if (attempt === 1 || attempt % 30 === 0) {
        log.warn(`${target.name} unreachable (attempt ${attempt}, new swaps will refuse until it answers): ${(e as Error).message}`)
      }
    }
    await Bun.sleep(retryMs)
  }
  return undefined
}
