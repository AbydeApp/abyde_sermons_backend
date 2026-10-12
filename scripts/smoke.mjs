// End-to-end smoke test against a running API + worker (local or staging).
// Exercises the MVP loop through the public HTTP API only:
// register → church → presign → upload → sermon → processing → READY → generate week → edit → approve
// → schedule → semantic search → ask → dashboard → Reels (video sermon → candidates → hooks → render).
//
// Usage: node scripts/smoke.mjs [baseUrl] [path-to-audio]
//   baseUrl defaults to http://localhost:4000/api/v1. Without an audio file, a 90s tone is generated with ffmpeg.
//   SMOKE_FAKE_BILLING=1 upgrades the church through the fake billing webhook (BILLING_PROVIDER=fake
//   only) so the Reel is actually rendered; otherwise the plan gate is checked instead.
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.argv[2] ?? 'http://localhost:4000/api/v1';
let audioPath = process.argv[3];
if (!audioPath) {
  audioPath = join(tmpdir(), 'abyde-smoke.mp3');
  execFileSync('ffmpeg', [
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=90',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '64k',
    audioPath,
  ]);
}

let cookie = '';
async function api(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok)
    throw new Error(`${method} ${path} → ${response.status} ${text}`);
  return json;
}

const step = (label, detail = '') =>
  console.log(`✔ ${label}${detail ? ` — ${detail}` : ''}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll(label, fn, done, timeoutMs = 120_000) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (done(value)) return value;
    if (Date.now() - started > timeoutMs)
      throw new Error(`${label} timed out: ${JSON.stringify(value)}`);
    await sleep(1000);
  }
}

const email = `smoke-${Date.now()}@example.com`;
const me = await api('POST', '/auth/register', {
  fullName: 'Smoke Test Pastor',
  email,
  password: 'Faith2026!',
});
step('register', `onboardingCompleted=${me.onboardingCompleted}`);

const onboarded = await api('POST', '/church', {
  name: 'Smoke Test Church',
  ownerRole: 'Lead Pastor',
});
step(
  'create church',
  `slug=${onboarded.church.slug} onboardingCompleted=${onboarded.onboardingCompleted}`,
);

const audio = readFileSync(audioPath);
const presigned = await api('POST', '/uploads/presign', {
  fileName: 'sermon.mp3',
  contentType: 'audio/mpeg',
  sizeBytes: audio.length,
  purpose: 'SERMON_MEDIA',
});
const upload = await fetch(presigned.uploadUrl, {
  method: 'PUT',
  headers: presigned.headers,
  body: audio,
});
if (!upload.ok)
  throw new Error(
    `direct upload failed: ${upload.status} ${await upload.text()}`,
  );
step('presign + direct upload to storage', presigned.objectKey);

const { id: sermonId } = await api('POST', '/sermons', {
  title: 'Walking By Faith',
  speaker: 'Pastor Smoke',
  sermonDate: new Date().toISOString(),
  series: 'Trust',
  mainScripture: '2 Corinthians 5:7',
  tags: ['faith'],
  objectKey: presigned.objectKey,
});
step('create sermon (202)', sermonId);

const stages = new Set();
const status = await poll(
  'processing',
  async () => {
    const s = await api('GET', `/sermons/${sermonId}/status`);
    if (s.processingStage) stages.add(s.processingStage);
    return s;
  },
  (s) => s.status === 'READY' || s.status === 'FAILED',
);
if (status.status !== 'READY')
  throw new Error(`processing failed: ${JSON.stringify(status)}`);
step(
  'sermon READY',
  `stages seen: ${[...stages].join(' → ') || '(too fast to observe)'}`,
);

const sermon = await api('GET', `/sermons/${sermonId}`);
const transcript = await api('GET', `/sermons/${sermonId}/transcript`);
const intelligence = await api('GET', `/sermons/${sermonId}/intelligence`);
step(
  'transcript + intelligence',
  `${transcript.length} segments, themes=${intelligence.themes.map((t) => t.text).join(', ')}, scriptures=${sermon.scriptures.join(', ')}`,
);

const group = await api('POST', `/sermons/${sermonId}/generate-week`, {
  contentTypes: [
    'DEVOTIONAL',
    'SOCIAL_POST',
    'PRAYER',
    'BIBLE_STUDY',
    'EMAIL',
    'WHATSAPP',
    'QUOTE',
    'VIDEO_IDEA',
  ],
});
const finished = await poll(
  'generation',
  () => api('GET', `/sermons/${sermonId}/generations/${group.id}`),
  (g) => g.done,
);
step(
  'generate week',
  finished.jobs.map((j) => `${j.contentType}:${j.status}`).join(' '),
);

const content = await api('GET', `/content?sermonId=${sermonId}&pageSize=100`);
step('content persisted as drafts', `${content.meta.total} items`);

const devotional = content.data.find((item) => item.type === 'DEVOTIONAL');
const edited = await api('PATCH', `/content/${devotional.id}`, {
  body: `${devotional.body}\n\nEdited during smoke test.`,
});
const approved = await api('POST', `/content/${devotional.id}/approve`);
step(
  'edit + approve',
  `version ${edited.currentVersion}, status ${approved.status}`,
);

const scheduledAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
const calendarItem = await api('POST', '/calendar', {
  contentItemId: devotional.id,
  scheduledAt,
});
step('schedule', `${calendarItem.status} at ${calendarItem.scheduledAt}`);

const semantic = await api('POST', '/library/semantic-search', {
  query: 'trusting God when the road is unclear',
});
step('semantic search', `${semantic.meta.total} result(s)`);

const answer = await api('POST', '/ask', {
  question: 'What has our church taught about faith?',
});
step(
  'ask your ministry',
  `${answer.sources.length} source(s): ${answer.answer.slice(0, 80)}…`,
);

const dashboard = await api('GET', '/dashboard');
step(
  'dashboard',
  `sermonsThisMonth=${dashboard.sermonsThisMonth} content=${dashboard.contentGenerated} scheduled=${dashboard.scheduled}`,
);

const usage = await api('GET', '/billing/usage');
step(
  'billing usage',
  `${usage.sermonsUsed}/${usage.sermonsLimit} sermons, ${usage.contentGenerated} content pieces`,
);

// ── Reels ────────────────────────────────────────────────────────────────
const videoPath = join(tmpdir(), 'abyde-smoke.mp4');
execFileSync('ffmpeg', [
  '-loglevel',
  'error',
  '-y',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=1280x720:rate=30',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=330:duration=120',
  '-t',
  '120',
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-c:a',
  'aac',
  videoPath,
]);
const video = readFileSync(videoPath);
const videoUpload = await api('POST', '/uploads/presign', {
  fileName: 'sermon.mp4',
  contentType: 'video/mp4',
  sizeBytes: video.length,
  purpose: 'SERMON_MEDIA',
});
const put = await fetch(videoUpload.uploadUrl, {
  method: 'PUT',
  headers: videoUpload.headers,
  body: video,
});
if (!put.ok) throw new Error(`video upload failed: ${put.status}`);
const { id: videoSermonId } = await api('POST', '/sermons', {
  title: 'Faith For The Next Step',
  speaker: 'Pastor Smoke',
  sermonDate: new Date().toISOString(),
  objectKey: videoUpload.objectKey,
});
await poll(
  'video sermon processing',
  () => api('GET', `/sermons/${videoSermonId}/status`),
  (s) => s.status === 'READY' || s.status === 'FAILED',
);
const candidates = await poll(
  'reel candidates',
  () => api('GET', `/sermons/${videoSermonId}/reel-candidates`),
  (list) => list.items.length > 0,
);
step(
  'reel candidates',
  `${candidates.items.length} moments, renderable=${candidates.renderable}`,
);
const draft = await api('POST', '/reels', {
  candidateId: candidates.items[0].id,
});
step('reel draft', `${draft.startMs}–${draft.endMs} ms, ${draft.captionStyle}`);

if (process.env.SMOKE_FAKE_BILLING === '1') {
  const event = JSON.stringify({
    id: `smoke-${Date.now()}`,
    type: 'charge.success',
    kind: 'PAYMENT_SUCCEEDED',
    amountKobo: 2_500_000,
    currency: 'NGN',
    churchId: onboarded.church.id,
    customerCode: `CUS_SMOKE_${Date.now()}`,
    planId: 'growth',
    subscriptionCode: `SUB_SMOKE_${Date.now()}`,
    nextPaymentDate: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  const webhook = await fetch(`${base}/webhooks/billing/fake`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-fake-signature': createHmac('sha256', 'fake-billing-secret')
        .update(event)
        .digest('hex'),
    },
    body: event,
  });
  if (!webhook.ok) throw new Error(`fake billing webhook: ${webhook.status}`);
  const { hooks } = await api('POST', `/reels/${draft.id}/hooks`);
  await api('PATCH', `/reels/${draft.id}`, { hook: hooks[0] });
  step(
    'reel hooks',
    hooks.map((hook) => `${hook.style}: ${hook.text}`).join(' | '),
  );
  await api('POST', `/reels/${draft.id}/render`);
  const seen = new Set();
  const rendered = await poll(
    'reel render',
    async () => {
      const current = await api('GET', `/reels/${draft.id}`);
      seen.add(current.status);
      return current;
    },
    (current) => current.status === 'COMPLETED' || current.status === 'FAILED',
    300_000,
  );
  if (rendered.status !== 'COMPLETED')
    throw new Error(`reel render failed: ${rendered.errorMessage}`);
  const file = await fetch(rendered.video.url);
  const bytes = (await file.arrayBuffer()).byteLength;
  if (!file.ok || bytes < 10_000)
    throw new Error(
      `rendered reel not downloadable (${file.status}, ${bytes} bytes)`,
    );
  step(
    'reel rendered',
    `${[...seen].join(' → ')}, ${rendered.video.durationMs} ms, ${bytes} bytes`,
  );
} else {
  const response = await fetch(`${base}/reels/${draft.id}/render`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
  });
  const body = await response.json();
  step('reel plan gate', `${response.status} ${body.code}`);
}

console.log('\nSmoke test passed.');
