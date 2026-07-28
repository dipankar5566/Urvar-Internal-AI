import { useEffect, useState } from 'react'
import { api, ApiError, type LeadRow } from '../api/client'
import { useToast } from '../context/ToastContext'
import { MarkdownLite } from '../lib/markdown-lite'

const STATUSES = ['new', 'contacted', 'responded', 'converted', 'dead'] as const
const PAGE_SIZE = 20

const EMPTY_FORM = { name: '', type: '', location: '', contact: '', source_url: '', fit_reason: '' }

export function LeadsPage() {
  const toast = useToast()
  const [leads, setLeads] = useState<LeadRow[]>([])
  const [total, setTotal] = useState(0)
  const [funnel, setFunnel] = useState<Record<string, number>>({})
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)

  const [selected, setSelected] = useState<LeadRow | null>(null)
  const [contactDraft, setContactDraft] = useState('')
  const [pitch, setPitch] = useState<string | null>(null)
  const [pitchLoading, setPitchLoading] = useState(false)

  const [showAddForm, setShowAddForm] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [enriching, setEnriching] = useState(false)

  const load = (): void => {
    setLoading(true)
    api
      .listLeads({ status: statusFilter || undefined, search: search || undefined, limit: PAGE_SIZE, offset })
      .then((r) => {
        setLeads(r.leads)
        setTotal(r.total)
        setFunnel(r.funnel)
      })
      .catch((err) => toast.error(err instanceof ApiError ? err.message : 'Failed to load leads.'))
      .finally(() => setLoading(false))
  }

  useEffect(load, [statusFilter, search, offset])
  useEffect(() => setOffset(0), [statusFilter, search])

  const openLead = (lead: LeadRow): void => {
    setSelected(lead)
    setContactDraft('')
    setPitch(null)
  }

  const onStatusChange = async (id: number, status: string): Promise<void> => {
    try {
      await api.updateLeadStatus(id, status)
      load()
      if (selected?.id === id) setSelected({ ...selected, status: status as LeadRow['status'] })
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to update status.')
    }
  }

  const onSaveContact = async (id: number): Promise<void> => {
    if (!contactDraft.trim()) return
    try {
      await api.updateLeadContact(id, contactDraft.trim())
      toast.success('Contact updated.')
      setContactDraft('')
      load()
      if (selected) setSelected({ ...selected, contact: contactDraft.trim() })
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to update contact.')
    }
  }

  const onDraftPitch = async (id: number): Promise<void> => {
    setPitchLoading(true)
    try {
      const r = await api.draftPitch(id)
      setPitch(r.response)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to draft pitch.')
    } finally {
      setPitchLoading(false)
    }
  }

  const onEnrich = async (): Promise<void> => {
    setEnriching(true)
    try {
      const r = await api.enrichLeads()
      toast.success(r.enriched === 0 ? 'No leads are missing a phone number.' : `Enrichment ran for ${r.enriched} lead(s).`)
      load()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Enrichment failed.')
    } finally {
      setEnriching(false)
    }
  }

  const onCreate = async (): Promise<void> => {
    if (!form.name.trim() || !form.type.trim() || !form.location.trim()) {
      toast.error('Name, type, and location are required.')
      return
    }
    setSaving(true)
    try {
      await api.createLead(form)
      toast.success('Lead added.')
      setForm(EMPTY_FORM)
      setShowAddForm(false)
      load()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to add lead.')
    } finally {
      setSaving(false)
    }
  }

  const from = total === 0 ? 0 : offset + 1
  const to = Math.min(offset + PAGE_SIZE, total)

  return (
    <div className="page">
      <div className="page-header">
        <h2>Leads pipeline</h2>
        <div className="funnel-line">
          {Object.entries(funnel)
            .map(([status, n]) => `${status}: ${n}`)
            .join(' · ') || 'No leads yet.'}
        </div>
      </div>
      <div className="toolbar">
        <input
          placeholder="Search name, type, location…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button type="button" className="ghost" onClick={() => void onEnrich()} disabled={enriching}>
          {enriching ? 'Enriching…' : 'Enrich missing contacts'}
        </button>
        <button type="button" onClick={() => setShowAddForm(true)}>
          + Add lead
        </button>
      </div>

      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Type</th>
              <th>Location</th>
              <th>Contact</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.id} className="clickable" onClick={() => openLead(l)}>
                <td className="mono">#{l.id}</td>
                <td>{l.name}</td>
                <td>{l.type}</td>
                <td>{l.location}</td>
                <td>{l.contact || <span className="muted">none</span>}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <select value={l.status} onChange={(e) => void onStatusChange(l.id, e.target.value)}>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && leads.length === 0 && <div className="empty-state">No leads match this view.</div>}

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

      {selected && (
        <>
          <div className="drawer-backdrop" onClick={() => setSelected(null)} />
          <div className="drawer">
            <div className="drawer-header">
              <h3>{selected.name}</h3>
              <button type="button" className="icon-btn" onClick={() => setSelected(null)}>
                ✕
              </button>
            </div>
            <div className={`pill status-${selected.status}`}>{selected.status}</div>
            <div className="drawer-field">
              <label>Type</label>
              {selected.type}
            </div>
            <div className="drawer-field">
              <label>Location</label>
              {selected.location}
            </div>
            <div className="drawer-field">
              <label>Contact</label>
              {selected.contact || <span className="muted">none on file</span>}
              <div className="inline-edit">
                <input
                  placeholder="Add/replace contact…"
                  value={contactDraft}
                  onChange={(e) => setContactDraft(e.target.value)}
                />
                <button type="button" className="ghost" onClick={() => void onSaveContact(selected.id)}>
                  Save
                </button>
              </div>
            </div>
            {selected.source_url && (
              <div className="drawer-field">
                <label>Source</label>
                <a href={selected.source_url} target="_blank" rel="noopener noreferrer">
                  {selected.source_url}
                </a>
              </div>
            )}
            {selected.fit_reason && (
              <div className="drawer-field">
                <label>Fit</label>
                {selected.fit_reason}
              </div>
            )}
            <div className="drawer-field">
              <label>Added</label>
              <span className="mono">{selected.created_at}</span>
            </div>
            <div className="drawer-field">
              <button type="button" onClick={() => void onDraftPitch(selected.id)} disabled={pitchLoading}>
                {pitchLoading ? 'Drafting…' : 'Draft pitch'}
              </button>
            </div>
            {pitch && (
              <div className="panel">
                <MarkdownLite text={pitch} />
              </div>
            )}
          </div>
        </>
      )}

      {showAddForm && (
        <>
          <div className="drawer-backdrop" onClick={() => setShowAddForm(false)} />
          <div className="drawer">
            <div className="drawer-header">
              <h3>Add lead</h3>
              <button type="button" className="icon-btn" onClick={() => setShowAddForm(false)}>
                ✕
              </button>
            </div>
            <div className="form-grid">
              <div className="field span-2">
                <label>Name *</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="field">
                <label>Type *</label>
                <input value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} />
              </div>
              <div className="field">
                <label>Location *</label>
                <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
              </div>
              <div className="field span-2">
                <label>Contact</label>
                <input value={form.contact} onChange={(e) => setForm({ ...form, contact: e.target.value })} />
              </div>
              <div className="field span-2">
                <label>Source URL</label>
                <input value={form.source_url} onChange={(e) => setForm({ ...form, source_url: e.target.value })} />
              </div>
              <div className="field span-2">
                <label>Fit reason</label>
                <textarea
                  rows={2}
                  value={form.fit_reason}
                  onChange={(e) => setForm({ ...form, fit_reason: e.target.value })}
                />
              </div>
            </div>
            <div className="drawer-field">
              <button type="button" onClick={() => void onCreate()} disabled={saving}>
                {saving ? 'Saving…' : 'Save lead'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
