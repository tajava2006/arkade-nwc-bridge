// Minimal tagged-template HTML builder with auto-escaping. The escape
// hatch is `raw(...)`, for nesting html`` results that have already been
// escaped — anything else (strings, numbers, arrays of values) gets
// HTML-entity-escaped on interpolation. Keeps the bridge from needing a
// dependency on a templating engine and works fine for the handful of
// server-rendered pages the operator UI needs.

const RAW = Symbol('raw')

export interface RawHtml {
  [RAW]: true
  value: string
}

export function raw(value: string): RawHtml {
  return { [RAW]: true, value }
}

function isRaw(v: unknown): v is RawHtml {
  return typeof v === 'object' && v !== null && RAW in v
}

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPE_MAP[c] ?? c)
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined || v === false) return ''
  if (isRaw(v)) return v.value
  if (Array.isArray(v)) return v.map(renderValue).join('')
  return escape(String(v))
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): RawHtml {
  let out = ''
  for (let i = 0; i < strings.length; i++) {
    out += strings[i]
    if (i < values.length) out += renderValue(values[i])
  }
  return raw(out)
}

export function htmlResponse(body: RawHtml, init?: ResponseInit): Response {
  return new Response(`<!DOCTYPE html>\n${body.value}`, {
    ...init,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...(init?.headers ?? {}),
    },
  })
}
