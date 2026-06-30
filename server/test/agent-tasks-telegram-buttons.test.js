/**
 * Phase 7 — inline button construction + Approval Telegram sender wiring.
 *
 * The worker cron's "real task complete" ping should carry Approve /
 * Requeue / Cancel inline buttons. We verify two things:
 *   1. notifyTaskForApproval builds a reply_markup with three buttons
 *      whose callback_data targets the callback endpoint with the
 *      expected action/id/token triple.
 *   2. sendAgentMessageWithButtons attaches the keyboard to the
 *      underlying sendMessage call as `reply_markup.inline_keyboard`.
 *
 * Both are exercised with a stubbed `fetch` so no real Telegram traffic
 * goes out during the test run.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { notifyTaskForApproval } from '../lib/notify.js';
import { sendAgentMessageWithButtons } from '../lib/agents.js';

const ORIGINAL_FETCH = global.fetch;

function mockFetchJson(body) {
  return vi.fn(async () => ({
    json: async () => body,
    ok: true,
    status: 200,
  }));
}

describe('Phase 7 — inline Telegram buttons', () => {
  beforeEach(() => {
    // Forge a Telegram-looking config so sendAgentMessage believes it's
    // safe to send. Real env values stay untouched.
    process.env.TELEGRAM_BOT_TOKEN = 'TEST-TOKEN';
    process.env.TELEGRAM_CHAT_ID = '0';
  });
  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    global.fetch = ORIGINAL_FETCH;
  });

  it('builds a 3-button Approve/Requeue/Cancel keyboard for a review task', async () => {
    const captured = mockFetchJson({ ok: true, result: { message_id: 1, chat: { id: 0 } } });
    global.fetch = captured;

    const task = {
      id: 42,
      uid: 'T-AB12CD',
      title: 'ship it',
      status: 'review',
      source: 'hq_ui',
      result_summary: 'Finished.',
    };

    const result = await notifyTaskForApproval(task);
    expect(result.ok).toBe(true);

    expect(captured).toHaveBeenCalledTimes(1);
    const [url, init] = captured.mock.calls[0];
    expect(url).toContain('/sendMessage');
    const payload = JSON.parse(init.body);
    expect(payload.chat_id).toBe('0');
    expect(payload.text).toMatch(/AB12CD/);

    // Inline keyboard: one row, three buttons.
    expect(payload.reply_markup).toBeTruthy();
    expect(payload.reply_markup.inline_keyboard).toHaveLength(1);
    const row = payload.reply_markup.inline_keyboard[0];
    expect(row).toHaveLength(3);
    expect(row.map((b) => b.text)).toEqual(['✅ Approve', '🔄 Requeue', '❌ Cancel']);

    // callback_data values must address the /api/agent-tasks/callback
    // endpoint with the right action/id/token triple.
    const dataByAction = Object.fromEntries(row.map((b) => [b.text, b.callback_data]));
    for (const [text, data] of Object.entries(dataByAction)) {
      expect(data).toBe(
        `action=${text.includes('Approve') ? 'approve' : text.includes('Requeue') ? 'requeue' : 'cancel'}` +
          `&id=42&token=T-AB12CD`
      );
    }
  });

  it('skips sending when the task is not in review', async () => {
    const captured = vi.fn();
    global.fetch = captured;

    const task = {
      id: 99,
      uid: 'T-XYZ',
      title: 'not review',
      status: 'done',
      source: 'hq_ui',
      result_summary: 'already done',
    };

    const result = await notifyTaskForApproval(task);
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('not_review_status');
    expect(captured).not.toHaveBeenCalled();
  });

  it('sendAgentMessageWithButtons attaches reply_markup to the outbound payload', async () => {
    const captured = mockFetchJson({ ok: true, result: { message_id: 7, chat: { id: 0 } } });
    global.fetch = captured;

    const buttons = [
      [
        { text: 'Yes', callback_data: 'action=approve' },
        { text: 'No',  callback_data: 'action=cancel' },
      ],
    ];
    const result = await sendAgentMessageWithButtons('default', 'pick one', buttons);
    expect(result.ok).toBe(true);
    const [, init] = captured.mock.calls[0];
    const payload = JSON.parse(init.body);
    expect(payload.reply_markup.inline_keyboard).toHaveLength(1);
    expect(payload.reply_markup.inline_keyboard[0]).toHaveLength(2);
  });
});
