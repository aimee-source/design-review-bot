import crypto from 'node:crypto';
import dotenv from 'dotenv';
import express from 'express';
import bolt from '@slack/bolt';
const { App, ExpressReceiver } = bolt;

dotenv.config();

// Claude: staging/dev link per repo. Add one line per repo ("owner/name": "url").
// Repos not listed here still get a review card, just without a staging link.
const STAGING_URLS: Record<string, string> = {
  // 'Fitmoola/web': 'https://staging.example.com',
};

const REVIEW_CHANNEL = process.env.SLACK_REVIEW_CHANNEL ?? 'C0CCFNCK37G';

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

function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Claude: one card layout for both the manual /design-review command and merged PRs.
// `reference` is carried in the button value so the Approve/Block message says which review it was.
function reviewCard(fallbackText: string, details: string, reference: string) {
  return {
    text: fallbackText,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'UI review requested' } },
      { type: 'section', text: { type: 'mrkdwn', text: details } },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Approve' },
            action_id: 'approve_review',
            style: 'primary',
            value: reference.slice(0, 1900),
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Block' },
            action_id: 'block_review',
            style: 'danger',
            value: reference.slice(0, 1900),
          },
        ],
      },
    ],
  };
}

app.command('/design-review', async ({ ack, body, client }) => {
  await ack();

  const previewUrl = process.env.PREVIEW_URL ?? 'https://designreview-two.vercel.app/';
  const summary = escapeMrkdwn(body.text || 'UI change detected');

  await client.chat.postMessage({
    channel: body.channel_id,
    ...reviewCard(
      `Design review: ${summary}`,
      `*Summary:* ${summary}\n*Preview:* <${previewUrl}|Open preview>`,
      summary,
    ),
  });
});

app.command('/total', async ({ ack, respond, client, body }) => {
  await ack();

  // Claude: count the bot's own result messages in this channel for the current quarter (UTC).
  // Assumes every button click posts exactly one message; deleting a message removes it from the count.
  // "needs fixes" messages from before the Block rename are counted as blocked.
  const now = new Date();
  const quarter = Math.floor(now.getUTCMonth() / 3);
  const quarterStart = Date.UTC(now.getUTCFullYear(), quarter * 3, 1) / 1000;

  let cards = 0;
  let approved = 0;
  let blocked = 0;
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
      // Claude: review cards are recognised by their fallback text (PR cards and /design-review cards).
      if (!(m.text.startsWith('UI review: ') || m.text.startsWith('Design review: '))) continue;
      cards++;
      // Claude: the decision lives on the card as a context note ("Approved by" / "Blocked by").
      const note = JSON.stringify((m as any).blocks ?? []);
      if (note.includes('Approved by')) approved++;
      else if (note.includes('Blocked by')) blocked++;
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);

  // Claude: share blocked = blocked / (approved + blocked); cards still awaiting review are left out.
  const decided = approved + blocked;
  const share = decided === 0 ? '0.0' : ((blocked / decided) * 100).toFixed(1);

  await respond({
    text: `Design review totals for Q${quarter + 1} ${now.getUTCFullYear()}\n- UI cards sent: ${cards}\n- Approved: ${approved}\n- Blocked: ${blocked}\n- Share blocked: ${share}%`,
  });
});

async function postDecision(body: any, client: any, verb: string) {
  const userId = body.user?.id ?? 'reviewer';
  const channelId = body.channel?.id ?? REVIEW_CHANNEL;
  const reference = body.actions?.[0]?.value;
  const prefix = reference ? `${reference}: ` : '';

  // Claude: replace the card's buttons with the decision so each card can only be decided once.
  // No separate channel message; /total counts the decision note on the card.
  const message = body.message;
  if (!message?.ts || !Array.isArray(message.blocks)) {
    await client.chat.postMessage({ channel: channelId, text: `${prefix}<@${userId}> ${verb} this UI review.` });
    return;
  }
  {
    const icon = verb === 'approved' ? ':white_check_mark:' : ':no_entry:';
    const blocks = message.blocks
      .filter((b: any) => b.type !== 'actions')
      .concat([{ type: 'context', elements: [{ type: 'mrkdwn', text: `${icon} ${verb[0].toUpperCase()}${verb.slice(1)} by <@${userId}>` }] }]);
    await client.chat.update({ channel: channelId, ts: message.ts, text: message.text, blocks });
  }
}

app.action('approve_review', async ({ ack, body, client }) => {
  await ack();
  await postDecision(body, client, 'approved');
});

app.action('block_review', async ({ ack, body, client }) => {
  await ack();
  await postDecision(body, client, 'blocked');
});

// Claude: older cards still have the "Needs fixes" button; treat a click as Block.
app.action('needs_fixes_review', async ({ ack, body, client }) => {
  await ack();
  await postDecision(body, client, 'blocked');
});

// ---------- GitHub: post a review card when a merged PR touches UI files ----------

// Claude: path-based guess at "affects the UI". Can give false alarms (logic-only .tsx changes)
// and can miss UI changes in files with other extensions.
const UI_EXTENSIONS = /\.(tsx|jsx|vue|svelte|css|scss|sass|less|html|svg)$/i;
const UI_FOLDERS = /(^|\/)(components|styles|pages|views|ui|layouts|screens)\//i;
const NOT_UI = /(\.test\.|\.spec\.|\.stories\.|__tests__\/|__snapshots__\/)/i;

function isUiFile(path: string): boolean {
  if (NOT_UI.test(path)) return false;
  return UI_EXTENSIONS.test(path) || UI_FOLDERS.test(path);
}

function validGithubSignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function listChangedFiles(repo: string, prNumber: number): Promise<string[]> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'design-review-bot',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const files: string[] = [];
  for (let page = 1; page <= 30; page++) {
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`, { headers });
    if (!res.ok) throw new Error(`GitHub API ${res.status} for ${repo}#${prNumber}`);
    const batch = (await res.json()) as Array<{ filename: string }>;
    files.push(...batch.map((f) => f.filename));
    if (batch.length < 100) break;
  }
  return files;
}

server.post('/github/webhook', express.raw({ type: '*/*', limit: '5mb' }), async (req, res) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    res.status(500).send('GITHUB_WEBHOOK_SECRET is not set');
    return;
  }
  if (!validGithubSignature(req.body, req.header('x-hub-signature-256'), secret)) {
    res.status(401).send('invalid signature');
    return;
  }

  const event = req.header('x-github-event');
  if (event === 'ping') {
    res.status(200).send('pong');
    return;
  }

  let payload: any;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    res.status(400).send('invalid JSON');
    return;
  }
  const pr = payload.pull_request;
  if (event !== 'pull_request' || payload.action !== 'closed' || !pr?.merged) {
    res.status(200).send('ignored: not a merged PR');
    return;
  }

  // Claude: only review merges into the repo's default branch (usually main), i.e. code queued for release.
  // Merges into feature branches are ignored. If GitHub doesn't send the default branch, nothing is filtered.
  const defaultBranch: string | undefined = payload.repository?.default_branch;
  if (defaultBranch && pr.base?.ref !== defaultBranch) {
    res.status(200).send(`ignored: merged into ${pr.base?.ref}, not ${defaultBranch}`);
    return;
  }

  try {
    const repo: string = payload.repository.full_name;
    const files = await listChangedFiles(repo, pr.number);
    const uiFiles = files.filter(isUiFile);
    if (uiFiles.length === 0) {
      res.status(200).send(`ignored: no UI files in ${repo}#${pr.number}`);
      return;
    }

    const title = escapeMrkdwn(pr.title);
    const stagingUrl = STAGING_URLS[repo];
    const shown = uiFiles.slice(0, 5).map((f) => `\`${f}\``).join(', ');
    const more = uiFiles.length > 5 ? ` and ${uiFiles.length - 5} more` : '';
    const details = [
      `*PR:* <${pr.html_url}|${repo}#${pr.number}: ${title}>`,
      `*Developer:* ${pr.user?.login ?? 'unknown'} · *Merged into:* \`${pr.base?.ref}\``,
      `*UI files changed (${uiFiles.length}):* ${shown}${more}`,
      stagingUrl
        ? `*Test on:* <${stagingUrl}|Open staging>`
        : `*Review:* check the screenshots in the <${pr.html_url}|PR description>`,
    ].join('\n');

    // Post before responding: Vercel can stop the function once the response is sent.
    await app.client.chat.postMessage({
      token: process.env.SLACK_BOT_TOKEN,
      channel: REVIEW_CHANNEL,
      ...reviewCard(`UI review: ${repo}#${pr.number} ${title}`, details, `<${pr.html_url}|${repo}#${pr.number}>`),
    });
    res.status(200).send(`posted review for ${repo}#${pr.number}`);
  } catch (err) {
    console.error('github webhook failed', err);
    res.status(500).send('failed to process PR');
  }
});

export default server;
