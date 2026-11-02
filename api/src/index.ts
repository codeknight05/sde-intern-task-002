import { type Context, Hono } from 'hono'

type Bindings = { DB: D1Database }
type Home = { id: string; name: string }
type Member = { id: string; homeId: string; name: string }
type Share = { id: string; memberId: string; amountCents: number; paidAt: string | null }
type Bill = { id: string; homeId: string; title: string; totalCents: number }
type JsonObject = Record<string, unknown>

const app = new Hono<{ Bindings: Bindings }>()

function error(c: Context<{ Bindings: Bindings }>, status: 400 | 404 | 409 | 422, message: string) {
  return c.json({ error: message }, status)
}

async function readBody(c: { req: { json: <T>() => Promise<T> } }): Promise<JsonObject | null> {
  try {
    const body: unknown = await c.req.json()
    return body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as JsonObject)
      : null
  } catch {
    return null
  }
}

function validName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 120
}

app.get('/api/health', (c) => c.json({ status: 'ok' }))

app.get('/api/homes/:homeId', async (c) => {
  const home = await c.env.DB.prepare('SELECT id, name FROM homes WHERE id = ?')
    .bind(c.req.param('homeId'))
    .first<Home>()
  if (!home) return error(c, 404, 'home not found')
  const { results: members } = await c.env.DB.prepare(
    'SELECT id, home_id AS homeId, name FROM members WHERE home_id = ? ORDER BY rowid',
  )
    .bind(home.id)
    .all<Member>()
  return c.json({ ...home, members })
})

app.post('/api/homes', async (c) => {
  const body = await readBody(c)
  if (!body || !validName(body.name))
    return error(c, 422, 'name must be a non-empty string of at most 120 characters')
  const home: Home = { id: crypto.randomUUID(), name: body.name.trim() }
  await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)')
    .bind(home.id, home.name)
    .run()
  return c.json(home, 201)
})

app.post('/api/homes/:homeId/members', async (c) => {
  const body = await readBody(c)
  if (!body || !validName(body.name))
    return error(c, 422, 'name must be a non-empty string of at most 120 characters')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(c.req.param('homeId'))
    .first<{ id: string }>()
  if (!home) return error(c, 404, 'home not found')
  const member: Member = { id: crypto.randomUUID(), homeId: home.id, name: body.name.trim() }
  await c.env.DB.prepare('INSERT INTO members (id, home_id, name) VALUES (?, ?, ?)')
    .bind(member.id, member.homeId, member.name)
    .run()
  return c.json(member, 201)
})

app.post('/api/homes/:homeId/bills', async (c) => {
  const body = await readBody(c)
  if (
    !body ||
    !validName(body.title) ||
    typeof body.totalCents !== 'number' ||
    !Number.isSafeInteger(body.totalCents) ||
    body.totalCents <= 0
  ) {
    return error(c, 422, 'title must be non-empty and totalCents must be a positive whole number')
  }
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<{ id: string }>()
  if (!home) return error(c, 404, 'home not found')
  const { results: members } = await c.env.DB.prepare(
    'SELECT id FROM members WHERE home_id = ? ORDER BY rowid',
  )
    .bind(homeId)
    .all<{ id: string }>()
  if (members.length === 0) return error(c, 422, 'cannot create a bill for a home with no members')

  const bill: Bill = {
    id: crypto.randomUUID(),
    homeId,
    title: body.title.trim(),
    totalCents: body.totalCents,
  }
  const baseCents = Math.floor(bill.totalCents / members.length)
  const remainder = bill.totalCents % members.length
  const shares: Share[] = members.map((member, index) => ({
    id: crypto.randomUUID(),
    memberId: member.id,
    amountCents: baseCents + (index < remainder ? 1 : 0),
    paidAt: null,
  }))
  const statements = [
    c.env.DB.prepare(
      'INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)',
    ).bind(bill.id, bill.homeId, bill.title, bill.totalCents),
    ...shares.map((share) =>
      c.env.DB.prepare(
        'INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?, ?, ?, ?)',
      ).bind(share.id, bill.id, share.memberId, share.amountCents),
    ),
  ]
  await c.env.DB.batch(statements)
  return c.json({ ...bill, shares }, 201)
})

app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const key = c.req.header('Idempotency-Key')?.trim()
  if (!key) return error(c, 400, 'Idempotency-Key header is required')
  if (key.length > 200) return error(c, 400, 'Idempotency-Key must be at most 200 characters')
  const billId = c.req.param('billId')
  const shareId = c.req.param('shareId')
  const shareQuery = c.env.DB.prepare(
    'SELECT s.id, s.member_id AS memberId, s.amount_cents AS amountCents, s.paid_at AS paidAt, s.idempotency_key AS idempotencyKey FROM shares s JOIN bills b ON b.id = s.bill_id WHERE b.id = ? AND s.id = ?',
  ).bind(billId, shareId)
  const share = await shareQuery.first<Share & { idempotencyKey: string | null }>()
  if (!share) return error(c, 404, 'bill or share not found')
  if (share.paidAt !== null) {
    if (share.idempotencyKey === key) {
      return c.json({
        id: share.id,
        memberId: share.memberId,
        amountCents: share.amountCents,
        paidAt: share.paidAt,
      })
    }
    return error(c, 409, 'share has already been paid')
  }

  const paidAt = new Date().toISOString()
  const update = await c.env.DB.prepare(
    'UPDATE shares SET paid_at = ?, idempotency_key = ? WHERE id = ? AND bill_id = ? AND paid_at IS NULL',
  )
    .bind(paidAt, key, shareId, billId)
    .run()
  if (update.meta.changes === 0) {
    const latest = await shareQuery.first<Share & { idempotencyKey: string | null }>()
    if (!latest) return error(c, 404, 'bill or share not found')
    if (latest.paidAt !== null && latest.idempotencyKey === key) {
      return c.json({
        id: latest.id,
        memberId: latest.memberId,
        amountCents: latest.amountCents,
        paidAt: latest.paidAt,
      })
    }
    return error(c, 409, 'share has already been paid')
  }
  return c.json({ id: share.id, memberId: share.memberId, amountCents: share.amountCents, paidAt })
})

app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<{ id: string }>()
  if (!home) return error(c, 404, 'home not found')
  const { results } = await c.env.DB.prepare(
    `SELECT m.id AS memberId, m.name,
      COALESCE(SUM(CASE WHEN s.paid_at IS NULL THEN s.amount_cents ELSE 0 END), 0) AS outstandingCents
     FROM members m LEFT JOIN shares s ON s.member_id = m.id
     WHERE m.home_id = ? GROUP BY m.id ORDER BY m.rowid`,
  )
    .bind(homeId)
    .all<{ memberId: string; name: string; outstandingCents: number }>()
  return c.json({ balances: results })
})

app.get('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<{ id: string }>()
  if (!home) return error(c, 404, 'home not found')
  const { results: bills } = await c.env.DB.prepare(
    'SELECT id, home_id AS homeId, title, total_cents AS totalCents FROM bills WHERE home_id = ? ORDER BY rowid',
  )
    .bind(homeId)
    .all<Bill>()
  const output = await Promise.all(
    bills.map(async (bill) => {
      const { results: shares } = await c.env.DB.prepare(
        'SELECT id, member_id AS memberId, amount_cents AS amountCents, paid_at AS paidAt FROM shares WHERE bill_id = ? ORDER BY rowid',
      )
        .bind(bill.id)
        .all<Share>()
      return { ...bill, shares }
    }),
  )
  return c.json({ bills: output })
})

app.notFound((c) => c.json({ error: 'not found' }, 404))
app.onError((err, c) => {
  console.error('request failed', err)
  return c.json({ error: 'internal server error' }, 500)
})

export default app
