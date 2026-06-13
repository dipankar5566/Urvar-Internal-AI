export interface RawChunk {
  sourceFile: string;
  section: string;
  content: string;
}

export function chunkMarkdown(text: string, sourceFile: string): RawChunk[] {
  const lines = text.split('\n');
  const chunks: RawChunk[] = [];

  let currentH2 = '';
  let currentH3 = '';
  let buffer: string[] = [];

  function flushBuffer(nextH2: string, nextH3: string): void {
    const content = buffer.join('\n').trim();
    if (!content) return;

    const section = currentH3 ? `${currentH2} > ${currentH3}` : currentH2;

    // If current chunk is too long and we're at a new ## boundary, it was already
    // sub-split at ### boundaries during accumulation — just flush as-is.
    if (content.length < 100 && chunks.length > 0) {
      // Merge tiny chunk into the previous one
      const prev = chunks[chunks.length - 1]!;
      chunks[chunks.length - 1] = {
        ...prev,
        content: prev.content + '\n\n' + content,
      };
    } else if (content.length > 0) {
      chunks.push({ sourceFile, section, content });
    }

    buffer = [];
    currentH2 = nextH2;
    currentH3 = nextH3;
  }

  for (const line of lines) {
    if (line.startsWith('## ')) {
      // New ## section: flush current buffer, reset h3
      flushBuffer(line.trim(), '');
    } else if (line.startsWith('### ')) {
      // New ### section inside current ##
      const currentContent = buffer.join('\n').trim();
      if (currentContent.length > 4000) {
        // Current ## section is already long — sub-split here
        flushBuffer(currentH2, line.trim());
      } else {
        currentH3 = line.trim();
        buffer.push(line);
      }
    } else {
      buffer.push(line);
    }
  }

  // Flush the final buffer
  flushBuffer('', '');

  // If no ## headers found (e.g. urvar-summary.md), entire file is one chunk
  if (chunks.length === 0) {
    const content = text.trim();
    if (content) {
      // Use the first # heading as the section name, fall back to filename
      const h1Match = /^# (.+)$/m.exec(content);
      const section = h1Match ? `# ${h1Match[1]}` : sourceFile;
      chunks.push({ sourceFile, section, content });
    }
  }

  return chunks;
}
