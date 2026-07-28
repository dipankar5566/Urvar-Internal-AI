import type { JSX, ReactNode } from 'react'

// Minimal, dependency-free markdown renderer for agent replies. Emits React
// nodes directly (never dangerouslySetInnerHTML / raw HTML strings), so there
// is no HTML-injection surface regardless of what text a model produces.
// Supports: headings, bold, italic, inline code, links, and un/ordered lists —
// the subset actually used by this project's agent prompts.

const SAFE_URL = /^https?:\/\//i;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/g;
  return text
    .split(pattern)
    .filter((part) => part.length > 0)
    .map((part, i) => {
      const key = `${keyPrefix}-${i}`;
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={key}>{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith('`') && part.endsWith('`')) {
        return <code key={key}>{part.slice(1, -1)}</code>;
      }
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
      if (link) {
        const [, label, href] = link;
        if (SAFE_URL.test(href)) {
          return (
            <a key={key} href={href} target="_blank" rel="noopener noreferrer">
              {label}
            </a>
          );
        }
        return label;
      }
      if (part.startsWith('*') && part.endsWith('*') && part.length > 1) {
        return <em key={key}>{part.slice(1, -1)}</em>;
      }
      return part;
    });
}

const HEADING_RE = /^(#{1,4})\s+(.*)$/;
const LIST_RE = /^\s*([-*]|\d+\.)\s+(.*)$/;

export function MarkdownLite({ text }: { text: string }): JSX.Element {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let blockIndex = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6);
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      blocks.push(<Tag key={blockIndex++}>{renderInline(heading[2], `h${blockIndex}`)}</Tag>);
      i++;
      continue;
    }

    const list = LIST_RE.exec(line);
    if (list) {
      const ordered = /^\d+\./.test(list[1]);
      const items: ReactNode[] = [];
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]);
        if (!m) break;
        items.push(<li key={items.length}>{renderInline(m[2], `li${blockIndex}-${items.length}`)}</li>);
        i++;
      }
      const ListTag = ordered ? 'ol' : 'ul';
      blocks.push(<ListTag key={blockIndex++}>{items}</ListTag>);
      continue;
    }

    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() && !HEADING_RE.test(lines[i]) && !LIST_RE.test(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push(<p key={blockIndex}>{renderInline(paraLines.join(' '), `p${blockIndex++}`)}</p>);
  }

  return <div className="bubble-md">{blocks}</div>;
}
