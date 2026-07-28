import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { api, ApiError } from '../api/client'
import { MarkdownLite } from '../lib/markdown-lite'
import { useToast } from '../context/ToastContext'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  agentUsed?: string
}

interface SessionSummary {
  sessionId: string
  lastAt: string
  preview: string | null
}

const SESSION_KEY = 'urvar_web_chat_session'
const MAX_IMAGES = 3

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '')
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

interface ChatPageProps {
  initialPrompt?: string | null
  onPromptConsumed?: () => void
}

export function ChatPage({ initialPrompt, onPromptConsumed }: ChatPageProps) {
  const toast = useToast()
  const [sessionId, setSessionId] = useState<string | null>(() => localStorage.getItem(SESSION_KEY))
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [images, setImages] = useState<File[]>([])
  const [imagePreviews, setImagePreviews] = useState<string[]>([])
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const loadSessions = (): void => {
    api
      .listChatSessions()
      .then((r) => setSessions(r.sessions))
      .catch(() => {})
  }

  useEffect(loadSessions, [])

  useEffect(() => {
    if (!sessionId) {
      setMessages([])
      return
    }
    api
      .getChatHistory(sessionId)
      .then((r) => setMessages(r.messages))
      .catch(() => {})
  }, [sessionId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (!initialPrompt) return
    setInput(initialPrompt)
    onPromptConsumed?.()
  }, [initialPrompt, onPromptConsumed])

  useEffect(() => {
    const urls = images.map((f) => URL.createObjectURL(f))
    setImagePreviews(urls)
    return () => urls.forEach((u) => URL.revokeObjectURL(u))
  }, [images])

  const addImages = (files: FileList | null): void => {
    if (!files) return
    const next = [...images, ...Array.from(files)].slice(0, MAX_IMAGES)
    if (images.length + files.length > MAX_IMAGES) {
      toast.info(`Only the first ${MAX_IMAGES} photos are used per diagnosis.`)
    }
    setImages(next)
  }

  const send = async (): Promise<void> => {
    if (!input.trim() && images.length === 0) return
    setSending(true)
    const userText = input.trim()
    const pendingImages = images
    setInput('')
    setImages([])

    setMessages((prev) => [
      ...prev,
      { role: 'user', content: pendingImages.length ? `[${pendingImages.length} photo(s)] ${userText}` : userText },
    ])

    try {
      const result = pendingImages.length
        ? await api.sendChatImage(
            sessionId,
            userText,
            await Promise.all(
              pendingImages.map(async (f) => ({ base64: await fileToBase64(f), mediaType: f.type })),
            ),
          )
        : await api.sendChat(sessionId, userText)

      if (result.sessionId !== sessionId) {
        setSessionId(result.sessionId)
        localStorage.setItem(SESSION_KEY, result.sessionId)
      }
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: result.response, agentUsed: result.agentUsed },
      ])
      loadSessions()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Something went wrong.')
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  const newChat = (): void => {
    localStorage.removeItem(SESSION_KEY)
    setSessionId(null)
  }

  const switchTo = (id: string): void => {
    localStorage.setItem(SESSION_KEY, id)
    setSessionId(id)
  }

  const deleteSession = async (id: string): Promise<void> => {
    try {
      await api.deleteChatSession(id)
      if (id === sessionId) newChat()
      loadSessions()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to delete conversation.')
    }
  }

  return (
    <div className="chat-page">
      <div className="chat-sidebar">
        <button type="button" onClick={newChat}>
          + New chat
        </button>
        {sessions.map((s) => (
          <div key={s.sessionId} className={`chat-session-item ${s.sessionId === sessionId ? 'active' : ''}`}>
            <button type="button" className="session-open" onClick={() => switchTo(s.sessionId)}>
              {s.preview ?? 'New conversation'}
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Delete conversation"
              onClick={() => void deleteSession(s.sessionId)}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="chat-main">
        <div className="chat-messages">
          {messages.length === 0 && (
            <p className="muted">
              Ask about market research, competitors, leads, sales content, or attach up to {MAX_IMAGES} crop
              photos for diagnosis. New here? Check the <strong>Guide</strong> in the sidebar for examples.
            </p>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`bubble ${m.role}`}>
              {m.agentUsed && <div className="bubble-label">{m.agentUsed.replace(/_/g, ' ')}</div>}
              {m.role === 'assistant' ? <MarkdownLite text={m.content} /> : m.content}
            </div>
          ))}
          {sending && <div className="bubble assistant muted">Thinking…</div>}
          <div ref={bottomRef} />
        </div>
        <div className="chat-input-row">
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            disabled={images.length >= MAX_IMAGES}
            onChange={(e) => {
              addImages(e.target.files)
              e.target.value = ''
            }}
          />
          <textarea
            rows={2}
            placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending || (!input.trim() && images.length === 0)}
          >
            Send
          </button>
        </div>
        {imagePreviews.length > 0 && (
          <div className="image-previews">
            {imagePreviews.map((src, i) => (
              <div key={src} className="image-preview">
                <img src={src} alt={`Attachment ${i + 1}`} />
                <button
                  type="button"
                  className="remove"
                  onClick={() => setImages((prev) => prev.filter((_, idx) => idx !== i))}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
