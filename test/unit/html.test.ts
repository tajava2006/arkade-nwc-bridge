import { describe, expect, test } from 'bun:test'
import { html, htmlResponse, raw } from '../../src/lib/html'

describe('html templating', () => {
  test('escapes interpolated string values', () => {
    const evil = '<script>alert("xss")</script>'
    const out = html`<p>${evil}</p>`.value
    expect(out).toBe('<p>&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</p>')
  })

  test('raw() bypasses escaping for nested html results', () => {
    const inner = html`<b>bold</b>`
    const out = html`<div>${inner}</div>`.value
    expect(out).toBe('<div><b>bold</b></div>')
  })

  test('escapes all five entity characters', () => {
    const out = html`${`& < > " '`}`.value
    expect(out).toBe('&amp; &lt; &gt; &quot; &#39;')
  })

  test('drops null/undefined/false; renders arrays by recursion', () => {
    const out = html`${null}${undefined}${false}${[raw('a'), 'b', raw('c')]}`.value
    expect(out).toBe('abc')
  })

  test('htmlResponse wraps with doctype and HTML content-type', async () => {
    const res = htmlResponse(html`<p>hi</p>`)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    const body = await res.text()
    expect(body.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(body).toContain('<p>hi</p>')
  })
})
