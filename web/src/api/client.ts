export type WebRole = 'owner' | 'member'

export interface LeadRow {
  id: number
  name: string
  type: string
  location: string
  contact?: string | null
  source_url?: string | null
  fit_reason?: string | null
  status: 'new' | 'contacted' | 'responded' | 'converted' | 'dead'
  created_at: string
}

export interface LearnedRow {
  id: number
  fact: string
  source: string
  source_detail: string | null
  status: 'pending' | 'approved' | 'rejected'
  category: 'business' | 'agronomy'
}

export interface ChatResponse {
  sessionId: string
  response: string
  agentUsed: string
  usage: { tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number }
}

class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (res.status === 204) return undefined as T
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`)
  return body as T
}

export const api = {
  login: (password: string) =>
    request<{ role: WebRole }>('/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<{ role: WebRole }>('/auth/me'),
  health: () => request<{ uptimeMs: number; version: string }>('/health'),

  getChatHistory: (sessionId: string) =>
    request<{ messages: Array<{ role: 'user' | 'assistant'; content: string }> }>(
      `/chat/history?sessionId=${encodeURIComponent(sessionId)}`,
    ),
  listChatSessions: () =>
    request<{ sessions: Array<{ sessionId: string; lastAt: string; preview: string | null }> }>(
      '/chat/sessions',
    ),
  deleteChatSession: (sessionId: string) =>
    request<void>(`/chat/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),
  sendChat: (sessionId: string | null, message: string) =>
    request<ChatResponse>('/chat', { method: 'POST', body: JSON.stringify({ sessionId, message }) }),
  sendChatImage: (
    sessionId: string | null,
    caption: string,
    images: Array<{ base64: string; mediaType: string }>,
  ) =>
    request<ChatResponse>('/chat/image', {
      method: 'POST',
      body: JSON.stringify({ sessionId, caption, images }),
    }),

  listLeads: (opts: { status?: string; search?: string; limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams()
    if (opts.status) params.set('status', opts.status)
    if (opts.search) params.set('search', opts.search)
    if (opts.limit) params.set('limit', String(opts.limit))
    if (opts.offset) params.set('offset', String(opts.offset))
    const qs = params.toString()
    return request<{ leads: LeadRow[]; total: number; limit: number; offset: number; funnel: Record<string, number> }>(
      `/leads${qs ? `?${qs}` : ''}`,
    )
  },
  getLead: (id: number) => request<{ lead: LeadRow }>(`/leads/${id}`),
  createLead: (input: {
    name: string
    type: string
    location: string
    contact?: string
    source_url?: string
    fit_reason?: string
  }) => request<{ id: number }>('/leads', { method: 'POST', body: JSON.stringify(input) }),
  updateLeadStatus: (id: number, status: string) =>
    request<{ ok: true }>(`/leads/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  updateLeadContact: (id: number, contact: string, sourceUrl?: string) =>
    request<{ ok: true }>(`/leads/${id}/contact`, {
      method: 'PATCH',
      body: JSON.stringify({ contact, sourceUrl }),
    }),
  draftPitch: (id: number) => request<{ response: string }>(`/leads/${id}/pitch`, { method: 'POST' }),
  enrichLeads: () => request<{ enriched: number; response: string | null }>('/leads/enrich', { method: 'POST' }),

  listPendingKb: () => request<{ pending: LearnedRow[] }>('/kb/pending'),
  queryKb: (opts: {
    status?: string
    category?: string
    source?: string
    search?: string
    limit?: number
    offset?: number
  } = {}) => {
    const params = new URLSearchParams()
    if (opts.status) params.set('status', opts.status)
    if (opts.category) params.set('category', opts.category)
    if (opts.source) params.set('source', opts.source)
    if (opts.search) params.set('search', opts.search)
    if (opts.limit) params.set('limit', String(opts.limit))
    if (opts.offset) params.set('offset', String(opts.offset))
    const qs = params.toString()
    return request<{ facts: LearnedRow[]; total: number; limit: number; offset: number }>(
      `/kb${qs ? `?${qs}` : ''}`,
    )
  },
  approveKb: (id: number) =>
    request<{ status: string; fact?: string; of?: number }>(`/kb/${id}/approve`, { method: 'POST' }),
  rejectKb: (id: number) => request<{ ok: true }>(`/kb/${id}/reject`, { method: 'POST' }),
  editKb: (id: number, fact: string) =>
    request<{ ok: true }>(`/kb/${id}`, { method: 'PATCH', body: JSON.stringify({ fact }) }),

  weeklyReport: () =>
    request<{
      market: string | null
      competitive: string | null
      funnel: Record<string, number>
      addedThisWeek: number
    }>('/reports/weekly'),
  kbStats: () =>
    request<{
      stats: Array<{ status: string; category: string; source: string; n: number }>
      duplicates: Array<{ a: number; b: number; score: number; factA: string; factB: string }>
    }>('/reports/kbstats'),
  callsheetLeads: () => request<{ leads: LeadRow[] }>('/reports/callsheet-leads'),
  generateCallSheet: () =>
    request<{ ready: LeadRow[]; text: string | null }>('/reports/callsheet/generate', { method: 'POST' }),
  generateArticle: (topic?: string) =>
    request<{ text: string }>('/reports/article/generate', {
      method: 'POST',
      body: JSON.stringify({ topic }),
    }),
}

export { ApiError }
