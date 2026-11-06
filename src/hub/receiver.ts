import { Hono } from 'hono'
import type { Decision } from '../shared/types.js'
import type { Hub } from './hub.js'
import { verifyLink } from './teams.js'

// The decision receiver: the only thing a tunnel exposes. It serves two routes and nothing else.
//   GET  /d/<token>  a confirm page for one option of one decision (a link preview or prefetch decides nothing)
//   POST /d/<token>  records the choice; the harness waiting on it (hh ask --wait) carries on
// The token is signed with the hub's secret, names one decision and one option, and expires. Once a
// decision is answered, every other link for it only shows what was decided.

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · hurray-harness</title><style>
:root{color-scheme:light dark;--bg:#faf9f6;--fg:#2c2c2a;--mute:#5f5e5a;--line:#d3d1c7;--go:#0f6e56;--warn:#854f0b}
@media (prefers-color-scheme:dark){:root{--bg:#1f1e1c;--fg:#ecebe6;--mute:#a9a79e;--line:#44433f;--go:#5dcaa5;--warn:#efb35c}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:520px;margin:0 auto;padding:28px 16px}
.k{font-size:13px;font-weight:600;color:var(--warn);text-transform:uppercase;letter-spacing:.04em}
h1{font-size:22px;line-height:1.3;margin:6px 0 10px}
p{margin:8px 0;color:var(--mute)}
.choice{border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:18px 0;font-size:18px}
button{width:100%;font:inherit;font-weight:600;padding:14px;border:0;border-radius:10px;background:var(--go);color:#fff;cursor:pointer}
.ok{color:var(--go)}
</style></head><body><main>${body}</main></body></html>`
}

function about(d: Decision): string {
  return `<h1>${esc(d.title)}</h1>${d.why ? `<p>${esc(d.why)}</p>` : ''}${d.recommendation ? `<p>Recommended: ${esc(d.recommendation)}</p>` : ''}`
}

export function createReceiver(hub: Hub, secret: Buffer): Hono {
  const app = new Hono()

  app.get('/health', (c) => c.text('ok'))

  const resolve = (token: string): { ok: false; status: 404 | 409 | 410; html: string } | { ok: true; d: Decision; option: string } => {
    const claim = verifyLink(secret, token)
    if (claim === 'invalid') return { ok: false, status: 404, html: page('Not found', '<h1>This link is not valid</h1><p>It may have been changed, or the hub has a new key.</p>') }
    if (claim === 'expired') return { ok: false, status: 410, html: page('Expired', '<h1>This link has expired</h1><p>Answer on the dashboard, or ask the harness to send the decision again.</p>') }
    const d = hub.decision(claim.d)
    if (!d) return { ok: false, status: 410, html: page('Closed', '<h1>This decision is no longer open</h1><p>It was closed or withdrawn before an answer came in.</p>') }
    if (d.answer) {
      return { ok: false, status: 409, html: page('Already decided', `<div class="k">Already decided</div>${about(d)}<div class="choice ok">${esc(d.answer.choice)}</div><p>Answered through ${esc(d.answer.via)}. Nothing changed.</p>`) }
    }
    const option = d.options?.[claim.c]
    if (option == null) return { ok: false, status: 404, html: page('Not found', '<h1>This option is no longer offered</h1>') }
    return { ok: true, d, option }
  }

  app.get('/d/:token', (c) => {
    const r = resolve(c.req.param('token'))
    if (!r.ok) return c.body(r.html, r.status, HEADERS)
    return c.body(page('Confirm', `<div class="k">Needs your decision</div>${about(r.d)}
<form method="post"><div class="choice">${esc(r.option)}</div><button type="submit">Confirm: ${esc(r.option)}</button></form>
<p>Picked the wrong option? Close this page and tap another one in Teams.</p>`), 200, HEADERS)
  })

  app.post('/d/:token', (c) => {
    const r = resolve(c.req.param('token'))
    if (!r.ok) return c.body(r.html, r.status, HEADERS)
    const res = hub.answer(r.d.id, r.option, 'teams')
    if (!res.ok) return c.body(page('Not recorded', `<h1>Not recorded</h1><p>${esc(res.error)}</p>`), 409, HEADERS)
    return c.body(page('Decided', `<div class="k ok">Decided</div>${about(r.d)}<div class="choice ok">${esc(r.option)}</div><p>Recorded. The harness carries on. You can close this page.</p>`), 200, HEADERS)
  })

  app.all('*', (c) => c.text('Not found', 404))
  return app
}
