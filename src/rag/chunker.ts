export interface RawChunk {
  sourceFile: string;
  section: string;
  content: string;
}

export function chunkMarkdown(text: string, sourceFile: string): RawChunk[] {
  // Label for content that sits outside any ## heading — the whole of a
  // heading-less file, or the preamble before a file's first ## heading.
  // Use the document's first # h1, falling back to the filename.
  const h1Match = /^# (.+)$/m.exec(text);
  const fallbackSection = h1Match ? `# ${h1Match[1]}` : sourceFile;

  // Files with no ## headers (e.g. urvar-summary.md) become a single chunk.
  if (!/^## /m.test(text)) {
    const content = text.trim();
    if (!content) return [];
    return [{ sourceFile, section: fallbackSection, content }];
  }

  const lines = text.split('\n');
  const chunks: RawChunk[] = [];

  let currentH2 = '';
  let currentH3 = '';
  let buffer: string[] = [];

  function flushBuffer(nextH2: string, nextH3: string): void {
    const content = buffer.join('\n').trim();

    if (content) {
      // Outside any ## heading (preamble) → fall back to the doc's h1/filename.
      const section = currentH2
        ? currentH3
          ? `${currentH2} > ${currentH3}`
          : currentH2
        : fallbackSection;

      // If current chunk is too long and we're at a new ## boundary, it was already
      // sub-split at ### boundaries during accumulation — just flush as-is.
      if (content.length < 100 && chunks.length > 0) {
        // Merge tiny chunk into the previous one
        const prev = chunks[chunks.length - 1]!;
        chunks[chunks.length - 1] = {
          ...prev,
          content: prev.content + '\n\n' + content,
        };
      } else {
        chunks.push({ sourceFile, section, content });
      }
    }

    // Advance heading state even when the buffer was empty — otherwise the first
    // ## heading (always hit before any content) would never be recorded and its
    // section would come back as ''.
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

  return chunks;
}
