import { LOG_LEVELS, type LogLevel } from './config.ts'

export interface Logger {
  debug(msg: string): void
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
}

export const createLogger = (level: LogLevel, write: (line: string, isError: boolean) => void = defaultWrite): Logger => {
  const floor = LOG_LEVELS.indexOf(level)
  const at = (l: LogLevel) => (msg: string) => {
    if (LOG_LEVELS.indexOf(l) < floor) return
    write(`${new Date().toISOString()} ${l.toUpperCase().padEnd(5)} ${msg}`, l === 'warn' || l === 'error')
  }
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }
}

const defaultWrite = (line: string, isError: boolean) => {
  if (isError) console.error(line)
  else console.log(line)
}
