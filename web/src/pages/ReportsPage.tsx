import { useEffect, useState } from 'react'
import { api, ApiError, type LeadRow } from '../api/client'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { MarkdownLite } from '../lib/markdown-lite'

interface Weekly {
  market: string | null
  competitive: string | null
  funnel: Record<string, number>
  addedThisWeek: number
}

interface KbStats {
  stats: Array<{ status: string; category: string; source: string; n: number }>
  duplicates: Array<{ a: number; b: number; score: number; factA: string; factB: string }>
}

export function ReportsPage() {
  const { role } = useAuth()
  const toast = useToast()
  const [weekly, setWeekly] = useState<Weekly | null>(null)
  const [callReady, setCallReady] = useState<LeadRow[]>([])
  const [kbStats, setKbStats] = useState<KbStats | null>(null)

  const [callSheetDraft, setCallSheetDraft] = useState<string | null>(null)
  const [callSheetLoading, setCallSheetLoading] = useState(false)

  const [articleTopic, setArticleTopic] = useState('')
  const [articleDraft, setArticleDraft] = useState<string | null>(null)
  const [articleLoading, setArticleLoading] = useState(false)

  useEffect(() => {
    api.weeklyReport().then(setWeekly).catch(() => toast.error('Failed to load weekly report.'))
    api.callsheetLeads().then((r) => setCallReady(r.leads)).catch(() => {})
    if (role === 'owner') {
      api.kbStats().then(setKbStats).catch(() => {})
    }
  }, [role])

  const onGenerateCallSheet = async (): Promise<void> => {
    setCallSheetLoading(true)
    try {
      const r = await api.generateCallSheet()
      setCallSheetDraft(r.text ?? 'No phone-ready leads in the pipeline right now.')
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to generate call sheet.')
    } finally {
      setCallSheetLoading(false)
    }
  }

  const onGenerateArticle = async (): Promise<void> => {
    setArticleLoading(true)
    try {
      const r = await api.generateArticle(articleTopic.trim() || undefined)
      setArticleDraft(r.text)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to generate article.')
    } finally {
      setArticleLoading(false)
    }
  }

  return (
    <div className="page">
      <h2>Reports</h2>

      <section className="report-section">
        <h3>This week's leads</h3>
        <p className="muted">
          {weekly ? `${weekly.addedThisWeek} added this week` : 'Loading…'} ·{' '}
          {weekly &&
            Object.entries(weekly.funnel)
              .map(([s, n]) => `${s}: ${n}`)
              .join(' · ')}
        </p>
      </section>

      <section className="report-section">
        <h3>Market intelligence (latest weekly briefing)</h3>
        <div className="report-text">
          {weekly?.market ? <MarkdownLite text={weekly.market} /> : 'No briefing archived yet — runs every Monday.'}
        </div>
      </section>

      <section className="report-section">
        <h3>Competitive intelligence (latest weekly briefing)</h3>
        <div className="report-text">
          {weekly?.competitive ? (
            <MarkdownLite text={weekly.competitive} />
          ) : (
            'No briefing archived yet — runs every Monday.'
          )}
        </div>
      </section>

      <section className="report-section">
        <h3>Call-ready leads</h3>
        {callReady.length === 0 && <p className="muted">No phone-ready leads right now.</p>}
        <ul className="plain-list">
          {callReady.map((l) => (
            <li key={l.id}>
              #{l.id} {l.name} — {l.type}, {l.location} · {l.contact}
            </li>
          ))}
        </ul>
        <div className="toolbar">
          <button type="button" onClick={() => void onGenerateCallSheet()} disabled={callSheetLoading}>
            {callSheetLoading ? 'Drafting…' : 'Generate call sheet'}
          </button>
        </div>
        {callSheetDraft && (
          <div className="report-text">
            <MarkdownLite text={callSheetDraft} />
          </div>
        )}
      </section>

      <section className="report-section">
        <h3>Website article</h3>
        <div className="toolbar">
          <input
            placeholder="Optional topic (leave blank for a seasonal pick)"
            value={articleTopic}
            onChange={(e) => setArticleTopic(e.target.value)}
          />
          <button type="button" onClick={() => void onGenerateArticle()} disabled={articleLoading}>
            {articleLoading ? 'Drafting…' : 'Generate article'}
          </button>
        </div>
        {articleDraft && (
          <div className="report-text">
            <MarkdownLite text={articleDraft} />
          </div>
        )}
      </section>

      {role === 'owner' && kbStats && (
        <section className="report-section">
          <h3>Knowledge base stats</h3>
          <ul className="plain-list">
            {kbStats.stats.map((s, i) => (
              <li key={i}>
                <span className={`pill status-${s.status}`}>{s.status}</span> {s.category} · {s.source}: {s.n}
              </li>
            ))}
          </ul>
          {kbStats.duplicates.length > 0 && (
            <>
              <h4>Flagged near-duplicates</h4>
              <ul className="plain-list">
                {kbStats.duplicates.map((d, i) => (
                  <li key={i}>
                    #{d.a} / #{d.b} ({d.score.toFixed(3)})
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  )
}
