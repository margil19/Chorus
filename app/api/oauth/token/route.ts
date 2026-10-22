import { NextRequest } from 'next/server'

// Derives a stable access token from the MCP_API_KEY without exposing the key itself
async function deriveAccessToken(): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(process.env.MCP_API_KEY!),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('chorus-mcp-access-token-v1'))
  return Buffer.from(sig).toString('hex')
}

async function verifyCode(code: string, codeVerifier: string): Promise<boolean> {
  const [payloadB64, sigB64] = code.split('.')
  if (!payloadB64 || !sigB64) return false

  const payload = Buffer.from(payloadB64, 'base64url').toString()

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(process.env.MCP_API_KEY!),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  )
  const sigBytes = Buffer.from(sigB64, 'base64url')
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(payload))
  if (!valid) return false

  const { codeChallenge, method, exp } = JSON.parse(payload) as {
    codeChallenge: string
    method: string
    exp: number
  }

  if (Date.now() > exp) return false

  if (method === 'S256') {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
    const challenge = Buffer.from(digest).toString('base64url')
    return challenge === codeChallenge
  }

  return codeVerifier === codeChallenge
}

export async function POST(req: NextRequest) {
  const contentType = req.headers.get('content-type') ?? ''
  let body: Record<string, string>

  if (contentType.includes('application/x-www-form-urlencoded')) {
    body = Object.fromEntries(new URLSearchParams(await req.text()))
  } else {
    body = (await req.json().catch(() => ({}))) as Record<string, string>
  }

  const { grant_type, code, code_verifier } = body

  if (grant_type !== 'authorization_code') {
    return Response.json({ error: 'unsupported_grant_type' }, { status: 400 })
  }
  if (!code) {
    return Response.json({ error: 'invalid_request', error_description: 'Missing code' }, { status: 400 })
  }

  const valid = await verifyCode(code, code_verifier ?? '')
  if (!valid) {
    return Response.json({ error: 'invalid_grant', error_description: 'Code invalid or expired' }, { status: 400 })
  }

  return Response.json({
    access_token: await deriveAccessToken(),
    token_type: 'Bearer',
    expires_in: 31536000,
  })
}
