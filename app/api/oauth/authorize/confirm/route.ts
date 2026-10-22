import { NextRequest } from 'next/server'

// Redirects back to the OAuth client with the auth code after user clicks Authorize
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const code = searchParams.get('code') ?? ''
  const redirectUri = searchParams.get('redirect_uri') ?? ''
  const state = searchParams.get('state') ?? ''

  if (!code || !redirectUri) {
    return Response.json({ error: 'invalid_request' }, { status: 400 })
  }

  const redirect = new URL(redirectUri)
  redirect.searchParams.set('code', code)
  if (state) redirect.searchParams.set('state', state)

  return Response.redirect(redirect.toString(), 302)
}
