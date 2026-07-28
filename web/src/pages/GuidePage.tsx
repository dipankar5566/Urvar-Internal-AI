import { useAuth } from '../context/AuthContext'

interface Example {
  label: string
  prompt: string
}

const CHAT_EXAMPLES: Array<{ agent: string; blurb: string; examples: Example[] }> = [
  {
    agent: '📈 Market Research',
    blurb: 'Market size, trends, seasonal demand, pricing strategy, distribution channels.',
    examples: [
      { label: 'Market size', prompt: 'What is the market size for bio-fertilizers in India?' },
      { label: 'Seasonal demand', prompt: 'What should we expect for kharif season demand this year?' },
    ],
  },
  {
    agent: '🔍 Competitive Analysis',
    blurb: 'Competitor profiling, pricing, positioning, SWOT.',
    examples: [
      { label: 'Competitor check', prompt: 'Give me a competitor analysis of IFFCO and Coromandel.' },
      { label: 'Pricing comparison', prompt: 'How does our vermicompost pricing compare to competitors on Amazon?' },
    ],
  },
  {
    agent: '🧪 R&D / Product Development',
    blurb: 'New formulations, certifications, packaging ideas.',
    examples: [{ label: 'New product idea', prompt: 'Should we develop a new bio-stimulant formulation?' }],
  },
  {
    agent: '📣 Sales & Marketing',
    blurb: 'WhatsApp outreach drafts, call scripts, dealer pitches, website SEO articles.',
    examples: [
      { label: 'WhatsApp intro', prompt: 'Draft a WhatsApp intro for a nursery lead in Bally.' },
      { label: 'SEO article', prompt: 'Write an SEO article about monsoon composting.' },
    ],
  },
  {
    agent: '🤝 Lead Generation',
    blurb: 'Finds distributors, retailers, FPOs, B2B leads and saves them to the pipeline.',
    examples: [{ label: 'Find leads', prompt: 'Find distributors and agro dealers in Nadia district.' }],
  },
  {
    agent: '🌿 Crop Doctor',
    blurb: 'Attach up to 3 photos of a sick plant, or describe symptoms in words.',
    examples: [{ label: 'Describe symptoms', prompt: 'My tomato leaves are turning yellow, what could be wrong?' }],
  },
]

export function GuidePage({ onTryPrompt }: { onTryPrompt?: (prompt: string) => void }) {
  const { role } = useAuth()

  return (
    <div className="page guide-page">
      <h2>Guide</h2>
      <p className="muted">
        This dashboard is Urvar Natural's internal AI assistant — six specialists in one chat, plus tools for
        running the B2B leads pipeline and reviewing what the system has learned.
      </p>

      <section className="report-section">
        <h3>Chat — ask a specialist</h3>
        <p className="muted">
          Just type your question in plain language; it's routed to the right specialist automatically. Click any
          example below to try it.
        </p>
        <div className="guide-grid">
          {CHAT_EXAMPLES.map((c) => (
            <div key={c.agent} className="panel guide-card">
              <h4>{c.agent}</h4>
              <p className="tiny muted">{c.blurb}</p>
              <div className="guide-examples">
                {c.examples.map((ex) => (
                  <button
                    key={ex.prompt}
                    type="button"
                    className="ghost tiny"
                    onClick={() => onTryPrompt?.(ex.prompt)}
                  >
                    {ex.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="report-section">
        <h3>Leads pipeline</h3>
        <p>
          Every lead the system finds (or that you add manually) lives here with a status:{' '}
          <span className="pill status-new">new</span> → <span className="pill status-contacted">contacted</span> →{' '}
          <span className="pill status-responded">responded</span> →{' '}
          <span className="pill status-converted">converted</span> (or <span className="pill status-dead">dead</span>
          ). Search and filter to find a lead, click a row to open its details, and use:
        </p>
        <ul className="plain-list">
          <li>
            <strong>Draft pitch</strong> — writes a ready-to-send WhatsApp intro + call opener for that specific
            lead.
          </li>
          <li>
            <strong>Enrich missing contacts</strong> — hunts the web for phone numbers on leads saved without one.
          </li>
          <li>
            <strong>+ Add lead</strong> — save a lead you found yourself (e.g. from a trade show or referral).
          </li>
        </ul>
      </section>

      <section className="report-section">
        <h3>Reports</h3>
        <p>
          The <strong>market</strong> and <strong>competitive intelligence</strong> sections update automatically
          every Monday morning — this page always shows the latest one. <strong>Generate call sheet</strong> and{' '}
          <strong>Generate article</strong> run on demand: the call sheet turns today's phone-ready leads into a
          prioritized calling list with a pitch line each; the article drafts a website SEO post (optionally on a
          topic you choose).
        </p>
      </section>

      {role === 'owner' && (
        <section className="report-section">
          <h3>Knowledge base (owner only)</h3>
          <p>
            The system learns facts from conversations and web research as it's used — new pricing, competitor
            moves, useful contacts. Nothing it learns affects future answers until you review and approve it here,
            so bad or stale information can't quietly creep in. <strong>Approve</strong> makes a fact live
            immediately; <strong>Reject</strong> discards it; edit the text first if it needs a correction.
          </p>
        </section>
      )}

      <section className="report-section">
        <h3>Roles</h3>
        <p className="muted">
          <strong>Owner</strong> can do everything, including reviewing the knowledge base and seeing token/cost
          details. <strong>Team members</strong> can chat, work the leads pipeline, and view reports — the
          knowledge base review queue is owner-only so bad information can't be approved by mistake.
        </p>
      </section>
    </div>
  )
}
