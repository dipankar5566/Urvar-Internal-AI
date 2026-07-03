import { test } from 'node:test';
import assert from 'node:assert/strict';
import type TelegramBot from 'node-telegram-bot-api';
import { sendMarkdownSafe, isMarkdownParseError } from '../../src/utils/message.js';

interface SentCall {
  text: string;
  options?: { parse_mode?: string };
}

// Minimal fake bot: fails Markdown sends when `failMarkdown` is set, the same
// way node-telegram-bot-api surfaces Telegram's 400 entity-parse error.
function fakeBot(failMarkdown: boolean): { bot: TelegramBot; calls: SentCall[] } {
  const calls: SentCall[] = [];
  const bot = {
    async sendMessage(_chatId: unknown, text: string, options?: { parse_mode?: string }) {
      if (failMarkdown && options?.parse_mode) {
        throw new Error("ETELEGRAM: 400 Bad Request: can't parse entities: Can't find end of the entity");
      }
      calls.push({ text, options });
    },
  } as unknown as TelegramBot;
  return { bot, calls };
}

test('sends once with Markdown when the text parses', async () => {
  const { bot, calls } = fakeBot(false);
  await sendMarkdownSafe(bot, 1, '*fine*');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.options?.parse_mode, 'Markdown');
});

test('falls back to plain text on a parse error', async () => {
  const { bot, calls } = fakeBot(true);
  await sendMarkdownSafe(bot, 1, 'broken _entity https://x.test/a_b');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.options, undefined);
  assert.equal(calls[0]!.text, 'broken _entity https://x.test/a_b');
});

test('non-parse errors are rethrown, not swallowed', async () => {
  const bot = {
    async sendMessage() {
      throw new Error('ETELEGRAM: 403 Forbidden: bot was blocked by the user');
    },
  } as unknown as TelegramBot;
  await assert.rejects(() => sendMarkdownSafe(bot, 1, 'hi'), /403 Forbidden/);
});

test('isMarkdownParseError matches only entity-parse failures', () => {
  assert.ok(isMarkdownParseError(new Error("400 Bad Request: can't parse entities")));
  assert.ok(!isMarkdownParseError(new Error('429 Too Many Requests')));
  assert.ok(!isMarkdownParseError('not an error'));
});
