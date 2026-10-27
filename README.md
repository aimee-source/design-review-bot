# Design Review Bot

This is the separate Slack bot app for the design review workflow.

## Purpose

- exposes `/design-review`
- exposes `/total`
- posts the preview URL from `PREVIEW_URL`
- accepts Approve / Needs fixes button responses

## Environment variables

Create a `.env` file from `.env.example` and fill in:

```env
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
PREVIEW_URL=https://designreview-three.vercel.app/
PORT=3000
```

## Run locally

```bash
npm install
npm run dev
```

## Deploy to Vercel

1. Import this repo into a new Vercel project.
2. Add the environment variables above.
3. Set the Slack slash-command request URL to:

```text
https://your-bot-project.vercel.app/slack/events
```

4. Keep the review app preview URL in `PREVIEW_URL`.

## Slack slash commands

- `/design-review` — posts a new review request with buttons
- `/total` — reports totals and share needing fixes

## Important separation

- This bot project is the Slack webhook app.
- `PREVIEW_URL` is the app being reviewed.
- The two URLs are different.
# design-review-bot
