import { useEffect, useState } from 'react'
import { api, ApiError, type LearnedRow } from '../api/client'
import { useToast } from '../context/ToastContext'

const TABS = ['pending', 'approved', 'rejected', 'all'] as const
type Tab = (typeof TABS)[number]

const CATEGORIES = ['business', 'agronomy'] as const
const SOURCES = ['teach', 'conversation', 'web_research', 'periodic', 'crop_doctor'] as const
const PAGE_SIZE = 20

export function KbPage() {
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('pending')
  const [category, setCategory] = useState('')
  const [source, setSource] = useState('')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)

  const [facts, setFacts] = useState<LearnedRow[]>([])
  const [total, setTotal] = useState(0)
  const [edits, setEdits] = useState<Record<number, string>>({})

  const load = (): void => {
    api
      .queryKb({
        status: tab === 'all' ? undefined : tab,
        category: category || undefined,
        source: source || undefined,
        search: search || undefined,
        limit: PAGE_SIZE,
        offset,
      })
      .then((r) => {
        setFacts(r.facts)
        setTotal(r.total)
      })
      .catch((err) => toast.error(err instanceof ApiError ? err.message : 'Failed to load facts.'))
  }

  useEffect(load, [tab, category, source, search, offset])
  useEffect(() => setOffset(0), [tab, category, source, search])

  const onApprove = async (id: number, editedFact?: string): Promise<void> => {
    try {
      if (editedFact && editedFact.trim()) {
        await api.editKb(id, editedFact.trim())
      }
      const result = await api.approveKb(id)
      toast[result.status === 'approved' ? 'success' : 'info'](
        result.status === 'approved'
          ? 'Approved and live.'
          : result.status === 'duplicate'
            ? `Skipped — near-duplicate of #${result.of}.`
            : 'Already decided.',
      )
      load()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to approve.')
    }
  }

  const onReject = async (id: number): Promise<void> => {
    try {
      await api.rejectKb(id)
      load()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to reject.')
    }
  }

  const from = total === 0 ? 0 : offset + 1
  const to = Math.min(offset + PAGE_SIZE, total)

  return (
    <div className="page">
      <h2>Knowledge base</h2>

      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            className={t === tab ? 'tab-btn active' : 'tab-btn'}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="toolbar">
        <input placeholder="Search facts…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">All sources</option>
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {facts.length === 0 && <div className="empty-state">No facts match this view.</div>}

      <div className="kb-list">
        {facts.map((row) => (
          <div key={row.id} className="kb-card">
            <div className="kb-meta">
              <span className={`pill status-${row.status}`}>{row.status}</span>
              #{row.id} · {row.source} · {row.category}
            </div>
            {row.status === 'pending' ? (
              <>
                <textarea
                  rows={2}
                  value={edits[row.id] ?? row.fact}
                  onChange={(e) => setEdits((prev) => ({ ...prev, [row.id]: e.target.value }))}
                />
                <div className="kb-actions">
                  <button type="button" onClick={() => void onApprove(row.id, edits[row.id])}>
                    Approve
                  </button>
                  <button type="button" className="danger" onClick={() => void onReject(row.id)}>
                    Reject
                  </button>
                </div>
              </>
            ) : (
              <p>{row.fact}</p>
            )}
          </div>
        ))}
      </div>

      {total > PAGE_SIZE && (
        <div className="pagination">
          <button type="button" className="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
            Previous
          </button>
          <span className="mono">
            {from}–{to} of {total}
          </span>
          <button type="button" className="ghost" disabled={to >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
            Next
          </button>
        </div>
      )}
    </div>
  )
}
