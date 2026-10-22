import { NextRequest } from 'next/server'

// Creates a short-lived auth code signed with the MCP_API_KEY (stateless PKCE)
async function makeCode(clientId: string, codeChallenge: string, method: string): Promise<string> {
  const exp = Date.now() + 5 * 60 * 1000
  const payload = JSON.stringify({ clientId, codeChallenge, method, exp })
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(process.env.MCP_API_KEY!),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  const sigB64 = Buffer.from(sig).toString('base64url')
  return Buffer.from(payload).toString('base64url') + '.' + sigB64
}

// GET — show a confirmation page the user clicks once to authorize the connection
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const clientId = searchParams.get('client_id') ?? ''
  const redirectUri = searchParams.get('redirect_uri') ?? ''
  const state = searchParams.get('state') ?? ''
  const codeChallenge = searchParams.get('code_challenge') ?? ''
  const codeChallengeMethod = searchParams.get('code_challenge_method') ?? 'S256'

  if (!redirectUri || !codeChallenge) {
    return Response.json({ error: 'invalid_request', error_description: 'Missing required parameters' }, { status: 400 })
  }

  const code = await makeCode(clientId, codeChallenge, codeChallengeMethod)
  const encodedCode = encodeURIComponent(code)
  const encodedRedirect = encodeURIComponent(redirectUri)
  const encodedState = encodeURIComponent(state)

  const confirmUrl = `/api/oauth/authorize/confirm?code=${encodedCode}&redirect_uri=${encodedRedirect}&state=${encodedState}`

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize — Chorus</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,-apple-system,sans-serif;background:#fafafa;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:40px;max-width:420px;width:100%;text-align:center}
    .icon{width:48px;height:48px;background:#000;border-radius:12px;display:flex;align-items:center;justify-content:center;margin:0 auto 20px}
    .icon svg{width:24px;height:24px;fill:#fff}
    h1{font-size:1.25rem;font-weight:600;margin-bottom:8px;color:#111}
    p{color:#6b7280;font-size:0.95rem;line-height:1.5;margin-bottom:32px}
    a.btn{display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 32px;border-radius:8px;font-size:0.95rem;font-weight:500}
    a.btn:hover{background:#333}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">
      <svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zm1 14.93V17a1 1 0 0 1-2 0v-.07A8.01 8.01 0 0 1 4.07 11H4a1 1 0 0 1 0-2h.07A8.01 8.01 0 0 1 11 3.07V3a1 1 0 0 1 2 0v.07A8.01 8.01 0 0 1 19.93 9H20a1 1 0 0 1 0 2h-.07A8.01 8.01 0 0 1 13 16.93z"/></svg>
    </div>
    <h1>Connect to Chorus</h1>
    <p>An application is requesting access to your Chorus MCP server. Click below to authorize the connection.</p>
    <a class="btn" href="${confirmUrl}">Authorize</a>
  </div>
</body>
</html>`

  return new Response(html, { headers: { 'Content-Type': 'text/html' } })
}
