const usage = { tokens: 0 }

/** Total Voyage tokens billed by this process so far. */
export const voyageTokens = () => usage.tokens

export async function voyageEmbed(texts: string[], inputType?: 'query' | 'document'): Promise<number[][]> {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'voyage-3-large', input: texts, ...(inputType && { input_type: inputType }) }),
  })
  if (!res.ok) throw new Error(`Voyage API ${res.status}: ${await res.text()}`)
  const json = (await res.json()) as { data: { embedding: number[]; index: number }[]; usage: { total_tokens: number } }
  usage.tokens += json.usage.total_tokens
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding)
}
