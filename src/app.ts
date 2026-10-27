import dotenv from 'dotenv';
import express from 'express';
import bolt from '@slack/bolt';
const { App, ExpressReceiver } = bolt;

dotenv.config();

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET ?? '',
  endpoints: '/slack/events',
  processBeforeResponse: true,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

const server = express();

server.use(receiver.app);
server.get('/healthz', (_req, res) => {
  res.status(200).send('ok');
});

app.command('/design-review', async ({ ack, body, client }) => {
  await ack();

  const previewUrl = process.env.PREVIEW_URL ?? 'https://designreview-two.vercel.app/';
  const summary = body.text || 'UI change detected';

  await client.chat.postMessage({
    channel: body.channel_id,
    text: `Design review: ${summary}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: 'UI review requested',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Summary:* ${summary}\n*Preview:* <${previewUrl}|Open preview>`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Approve' },
            action_id: 'approve_review',
            style: 'primary',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Needs fixes' },
            action_id: 'needs_fixes_review',
            style: 'danger',
          },
        ],
      },
    ],
  });
});

app.command('/total', async ({ ack, respond, client, body }) => {
  await ack();

  // Claude: count the bot's own result messages in this channel for the current quarter (UTC).
  // Assumes every button click posts exactly one message; deleting a message removes it from the count.
  const now = new Date();
  const quarter = Math.floor(now.getUTCMonth() / 3);
  const quarterStart = Date.UTC(now.getUTCFullYear(), quarter * 3, 1) / 1000;

  let approved = 0;
  let needsFixes = 0;
  let cursor: string | undefined;
  do {
    const page = await client.conversations.history({
      channel: body.channel_id,
      oldest: String(quarterStart),
      limit: 200,
      cursor,
    });
    for (const m of page.messages ?? []) {
      if (!m.bot_id || !m.text) continue;
      if (m.text.endsWith('approved this UI review.')) approved++;
      else if (m.text.endsWith('marked this UI review as needs fixes.')) needsFixes++;
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);

  const totalReviews = approved + needsFixes;
  const share = totalReviews === 0 ? '0.0' : ((needsFixes / totalReviews) * 100).toFixed(1);

  await respond({
    text: `Design review totals for Q${quarter + 1} ${now.getUTCFullYear()}\n- Total reviews: ${totalReviews}\n- Approved: ${approved}\n- Needs fixes: ${needsFixes}\n- Share needing fixes: ${share}%`,
  });
});

app.action('approve_review', async ({ ack, body, client }) => {
  await ack();

  const userId = body.user?.id ?? 'reviewer';
  const channelId = body.channel?.id ?? process.env.SLACK_REVIEW_CHANNEL ?? 'C0CCFNCK37G';

  await client.chat.postMessage({
    channel: channelId,
    text: `<@${userId}> approved this UI review.`,
  });
});

app.action('needs_fixes_review', async ({ ack, body, client }) => {
  await ack();

  const userId = body.user?.id ?? 'reviewer';
  const channelId = body.channel?.id ?? process.env.SLACK_REVIEW_CHANNEL ?? 'C0CCFNCK37G';

  await client.chat.postMessage({
    channel: channelId,
    text: `<@${userId}> marked this UI review as needs fixes.`,
  });
});

export default server;
