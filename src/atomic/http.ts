// subdustd REST helpers shared by the atomic send/receive orchestration
// (send.ts / receive.ts). Bridge-only (NOT vendored to subdustd) — kept here so
// the two flows don't each carry their own copy.

/** POST JSON to subdustd; throws with status + body on a non-2xx. */
export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`${url} -> ${res.status}: ${await res.text().catch(() => '')}`)
  }
  return (await res.json()) as T
}

/** GET JSON from subdustd; throws with status on a non-2xx. */
export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return (await res.json()) as T
}
