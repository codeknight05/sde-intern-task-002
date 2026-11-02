import { createFileRoute } from '@tanstack/react-router'
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import './page.css'

type Member = { id: string; homeId: string; name: string }
type Share = { id: string; memberId: string; amountCents: number; paidAt: string | null }
type Bill = { id: string; homeId: string; title: string; totalCents: number; shares: Share[] }
type Home = { id: string; name: string; members: Member[] }
type Balance = { memberId: string; name: string; outstandingCents: number }
type ApiError = { error?: string }

export const Route = createFileRoute('/')({ component: HomePage })

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      body !== null && typeof body === 'object' && 'error' in body
        ? String((body as ApiError).error)
        : `Request failed (${response.status})`
    throw new Error(message)
  }
  return body as T
}

function money(cents: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(cents / 100)
}

function HomePage() {
  const [homeId, setHomeId] = useState(
    () => window.localStorage.getItem('bill-splitter-home') ?? '',
  )
  const [home, setHome] = useState<Home | null>(null)
  const [bills, setBills] = useState<Bill[]>([])
  const [balances, setBalances] = useState<Balance[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const retryKeys = useRef(new Map<string, string>())

  const refresh = useCallback(async (id: string) => {
    if (!id) return
    setLoading(true)
    setError('')
    try {
      const [nextHome, nextBills, nextBalances] = await Promise.all([
        request<Home>(`/homes/${encodeURIComponent(id)}`),
        request<{ bills: Bill[] }>(`/homes/${encodeURIComponent(id)}/bills`),
        request<{ balances: Balance[] }>(`/homes/${encodeURIComponent(id)}/balances`),
      ])
      setHome(nextHome)
      setBills(nextBills.bills)
      setBalances(nextBalances.balances)
    } catch (cause) {
      setHome(null)
      setBills([])
      setBalances([])
      setError(cause instanceof Error ? cause.message : 'Could not load this home.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (homeId) void refresh(homeId)
  }, [homeId, refresh])

  function selectHome(id: string) {
    setHomeId(id)
    window.localStorage.setItem('bill-splitter-home', id)
  }

  async function submit(event: FormEvent<HTMLFormElement>, action: () => Promise<void>) {
    event.preventDefault()
    setError('')
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed. Please try again.')
    }
  }

  async function createHome(event: FormEvent<HTMLFormElement>) {
    const form = event.currentTarget
    await submit(event, async () => {
      const data = new FormData(form)
      const created = await request<{ id: string }>('/homes', {
        method: 'POST',
        body: JSON.stringify({ name: data.get('name') }),
      })
      selectHome(created.id)
      form.reset()
    })
  }

  async function addMember(event: FormEvent<HTMLFormElement>) {
    const form = event.currentTarget
    await submit(event, async () => {
      const data = new FormData(form)
      await request<Member>(`/homes/${encodeURIComponent(homeId)}/members`, {
        method: 'POST',
        body: JSON.stringify({ name: data.get('name') }),
      })
      form.reset()
      await refresh(homeId)
    })
  }

  async function createBill(event: FormEvent<HTMLFormElement>) {
    const form = event.currentTarget
    await submit(event, async () => {
      const data = new FormData(form)
      const dollars = Number(data.get('amount'))
      if (!Number.isFinite(dollars) || dollars <= 0 || !Number.isSafeInteger(dollars * 100)) {
        throw new Error('Enter an amount greater than zero with at most two decimal places.')
      }
      await request<Bill>(`/homes/${encodeURIComponent(homeId)}/bills`, {
        method: 'POST',
        body: JSON.stringify({ title: data.get('title'), totalCents: Math.round(dollars * 100) }),
      })
      form.reset()
      await refresh(homeId)
    })
  }

  async function pay(billId: string, shareId: string) {
    const key = `${billId}:${shareId}`
    const idempotencyKey = retryKeys.current.get(key) ?? crypto.randomUUID()
    retryKeys.current.set(key, idempotencyKey)
    setPending(shareId)
    setError('')
    try {
      await request<Share>(
        `/bills/${encodeURIComponent(billId)}/shares/${encodeURIComponent(shareId)}/pay`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey },
        },
      )
      retryKeys.current.delete(key)
      await refresh(homeId)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Payment failed. The share is still unpaid.',
      )
    } finally {
      setPending(null)
    }
  }

  const memberNames = new Map(home?.members.map((member) => [member.id, member.name]) ?? [])

  return (
    <main className="shell">
      <header className="topbar">
        <a className="wordmark" href="/" aria-label="Commonplace home">
          <span className="mark">C</span> commonplace
        </a>
        <span className="top-note">SHARED HOUSEHOLD LEDGER</span>
      </header>

      <section className="intro">
        <p className="eyebrow">HOUSEHOLD EXPENSES</p>
        <h1>
          Keep the shared
          <br />
          costs in order.
        </h1>
        <p className="lede">
          A clear record of what the home owes, and who has settled their share.
        </p>
      </section>

      {error && (
        <div className="notice" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError('')} aria-label="Dismiss error">
            ×
          </button>
        </div>
      )}

      {!home && (
        <section className="setup-grid">
          <form className="panel form-panel" onSubmit={createHome}>
            <div className="section-heading">
              <span className="step">01</span>
              <div>
                <h2>Start a household</h2>
                <p>Create a shared place for bills and balances.</p>
              </div>
            </div>
            <label htmlFor="home-name">Household name</label>
            <div className="inline-form">
              <input
                id="home-name"
                name="name"
                placeholder="e.g. Cedar House"
                required
                maxLength={120}
              />
              <button className="button button-dark" type="submit">
                Create home <span>→</span>
              </button>
            </div>
          </form>
          <form
            className="panel form-panel"
            onSubmit={(event) => {
              event.preventDefault()
              const form = event.currentTarget
              const id = String(new FormData(form).get('homeId') ?? '').trim()
              if (id) selectHome(id)
            }}
          >
            <div className="section-heading">
              <span className="step">↗</span>
              <div>
                <h2>Return to a home</h2>
                <p>Open a household using its ID.</p>
              </div>
            </div>
            <label htmlFor="home-id">Home ID</label>
            <div className="inline-form">
              <input id="home-id" name="homeId" placeholder="Paste a home ID" required />
              <button className="button button-light" type="submit">
                Open <span>→</span>
              </button>
            </div>
          </form>
        </section>
      )}

      {home && (
        <>
          <section className="home-heading">
            <div>
              <p className="eyebrow">YOUR HOUSEHOLD</p>
              <h2>{home.name}</h2>
              <p className="home-id">
                ID <code>{home.id}</code>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(home.id)
                  }}
                >
                  Copy
                </button>
              </p>
            </div>
            <button
              type="button"
              className="button button-light change-home"
              onClick={() => {
                setHome(null)
                setHomeId('')
                window.localStorage.removeItem('bill-splitter-home')
              }}
            >
              Change home <span>↗</span>
            </button>
          </section>

          <section className="summary" aria-label="Household summary">
            <div>
              <span className="summary-label">PEOPLE</span>
              <strong>{home.members.length.toString().padStart(2, '0')}</strong>
            </div>
            <div>
              <span className="summary-label">OPEN BILLS</span>
              <strong>
                {bills
                  .filter((bill) => bill.shares.some((share) => !share.paidAt))
                  .length.toString()
                  .padStart(2, '0')}
              </strong>
            </div>
            <div>
              <span className="summary-label">OUTSTANDING</span>
              <strong>
                {money(balances.reduce((sum, balance) => sum + balance.outstandingCents, 0))}
              </strong>
            </div>
          </section>

          <section className="workspace-grid">
            <div className="ledger-column">
              <div className="section-title">
                <div>
                  <p className="eyebrow">THE LEDGER</p>
                  <h2>Bills & shares</h2>
                </div>
                <span className="count">
                  {bills.length} {bills.length === 1 ? 'bill' : 'bills'}
                </span>
              </div>
              {loading ? (
                <div className="state-panel" role="status">
                  <span className="loader" />
                  Loading household…
                </div>
              ) : bills.length === 0 ? (
                <div className="state-panel empty-state">
                  <span className="empty-mark">＋</span>
                  <h3>No bills recorded</h3>
                  <p>Once you add a bill, each person’s share will appear here.</p>
                </div>
              ) : (
                <div className="bill-list">
                  {bills.map((bill) => {
                    const settled = bill.shares.every((share) => share.paidAt !== null)
                    return (
                      <article className="bill-card" key={bill.id}>
                        <div className="bill-head">
                          <div>
                            <span className="bill-kicker">SHARED EXPENSE</span>
                            <h3>{bill.title}</h3>
                          </div>
                          <div className="bill-total">
                            <strong>{money(bill.totalCents)}</strong>
                            <span className={settled ? 'status status-paid' : 'status'}>
                              {settled ? 'SETTLED' : 'IN PROGRESS'}
                            </span>
                          </div>
                        </div>
                        <div className="share-list">
                          {bill.shares.map((share, index) => (
                            <div className="share-row" key={share.id}>
                              <span className="share-index">
                                {String(index + 1).padStart(2, '0')}
                              </span>
                              <span className="share-name">
                                {memberNames.get(share.memberId) ?? 'House member'}
                              </span>
                              <span className="share-amount">{money(share.amountCents)}</span>
                              {share.paidAt ? (
                                <span className="paid-label">
                                  <span>✓</span> Paid
                                </span>
                              ) : (
                                <button
                                  className="pay-button"
                                  type="button"
                                  disabled={pending !== null}
                                  onClick={() => void pay(bill.id, share.id)}
                                >
                                  {pending === share.id ? 'Paying…' : 'Mark paid'} <span>→</span>
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      </article>
                    )
                  })}
                </div>
              )}
            </div>

            <aside className="side-column">
              <form className="panel form-panel" onSubmit={addMember}>
                <div className="section-heading">
                  <span className="step">01</span>
                  <div>
                    <h2>House members</h2>
                    <p>
                      {home.members.length
                        ? `${home.members.length} on this household`
                        : 'Add people before recording a bill.'}
                    </p>
                  </div>
                </div>
                {home.members.length > 0 && (
                  <ul className="member-list">
                    {home.members.map((member, index) => (
                      <li key={member.id}>
                        <span className="member-number">{String(index + 1).padStart(2, '0')}</span>
                        <span>{member.name}</span>
                        <span className="member-check">✓</span>
                      </li>
                    ))}
                  </ul>
                )}
                <label htmlFor="member-name">Add someone</label>
                <div className="inline-form">
                  <input id="member-name" name="name" placeholder="Name" required maxLength={120} />
                  <button className="square-button" type="submit" aria-label="Add member">
                    ＋
                  </button>
                </div>
              </form>
              <form className="panel form-panel bill-form" onSubmit={createBill}>
                <div className="section-heading">
                  <span className="step">02</span>
                  <div>
                    <h2>Record a bill</h2>
                    <p>Split evenly across all current members.</p>
                  </div>
                </div>
                <label htmlFor="bill-title">What was it for?</label>
                <input
                  id="bill-title"
                  name="title"
                  placeholder="e.g. Electricity, rent"
                  required
                  maxLength={120}
                />
                <label htmlFor="bill-amount">
                  Total amount <span className="field-hint">INR</span>
                </label>
                <div className="amount-input">
                  <span>₹</span>
                  <input
                    id="bill-amount"
                    name="amount"
                    type="number"
                    min="0.01"
                    step="0.01"
                    placeholder="0.00"
                    required
                  />
                </div>
                <button
                  className="button button-dark full-button"
                  type="submit"
                  disabled={home.members.length === 0}
                >
                  Split bill <span>→</span>
                </button>
                {home.members.length === 0 && (
                  <p className="form-hint">Add at least one member to create a bill.</p>
                )}
              </form>
            </aside>
          </section>
        </>
      )}

      <footer>
        <span>
          COMMONPLACE <span className="footer-dot">●</span> SHARED COSTS, CLEARLY SETTLED
        </span>
        <span>Amounts split in whole paise</span>
      </footer>
    </main>
  )
}
