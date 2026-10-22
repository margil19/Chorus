import { NextRequest } from 'next/server'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  return Response.json(
    {
      client_id: crypto.randomUUID(),
      redirect_uris: body.redirect_uris ?? [],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    { status: 201 }
  )
}
