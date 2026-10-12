import type { ContentType, RewriteAction } from '../../domain/content-types.js';

export interface ContentSpec {
  count: number;
  label: string;
  instructions: string;
  tone: 'devotional' | 'social';
  maxBodyChars: number;
}

/** What each content type produces (B16–B20). Counts follow the "Generate My Week" targets. */
export const CONTENT_SPECS: Record<ContentType, ContentSpec> = {
  DEVOTIONAL: {
    count: 7,
    label: 'daily devotionals (Day 1 to Day 7)',
    instructions:
      'Write one devotional per day for 7 days, each 200–350 words. Each builds on one idea from the sermon, opens with a scripture the preacher used, reflects on it, and ends with a one-line prayer and a practical step. Title format: "Day N: <title>".',
    tone: 'devotional',
    maxBodyChars: 4000,
  },
  SOCIAL_POST: {
    count: 7,
    label: 'social media posts',
    instructions:
      'Write 7 social posts (Facebook/Instagram) of 40–120 words each, one per day of the week. Vary the format: reflection, question, scripture highlight, application, invitation. End each with 2–4 relevant hashtags. The title is a short internal label.',
    tone: 'social',
    maxBodyChars: 1200,
  },
  PRAYER: {
    count: 5,
    label: 'prayer points',
    instructions:
      "Write 5 prayers or prayer points (60–150 words each) the congregation can pray this week, rooted in the sermon's message.",
    tone: 'devotional',
    maxBodyChars: 1500,
  },
  BIBLE_STUDY: {
    count: 1,
    label: 'small-group Bible study guide',
    instructions:
      'Write one small-group study guide with these sections: Overview (2–3 sentences), Read (the passages the sermon used), Discuss (6–8 open questions), Apply (2–3 practical challenges), Pray (a closing prayer). Use simple Markdown headings.',
    tone: 'devotional',
    maxBodyChars: 8000,
  },
  EMAIL: {
    count: 1,
    label: 'email newsletter',
    instructions:
      "Write one church email newsletter (250–450 words) recapping Sunday's message for people who were there and people who missed it, with a clear encouragement for the week. The title is the email subject line.",
    tone: 'devotional',
    maxBodyChars: 6000,
  },
  WHATSAPP: {
    count: 5,
    label: 'WhatsApp broadcast messages',
    instructions:
      'Write 5 short WhatsApp messages (30–90 words) for the church broadcast list, one for each weekday. Plain text, friendly, at most two emoji, no hashtags.',
    tone: 'social',
    maxBodyChars: 900,
  },
  QUOTE: {
    count: 6,
    label: 'quotable lines',
    instructions:
      'Select up to 6 memorable sentences the preacher actually said. Copy each word-for-word from its numbered segment; do not edit, merge or paraphrase. The title is a 2–5 word label.',
    tone: 'social',
    maxBodyChars: 500,
  },
  VIDEO_IDEA: {
    count: 4,
    label: 'short-form video ideas',
    instructions:
      'Suggest 4 short-form video (Reels/Shorts/TikTok, 30–60s) ideas drawn from moments in the sermon. For each: a hook line, which segment to clip, a 3-step outline, and an on-screen caption. Reference the segments you would clip.',
    tone: 'social',
    maxBodyChars: 2000,
  },
};

export const REWRITE_INSTRUCTIONS: Record<RewriteAction, string> = {
  SHORTEN:
    'Make it noticeably shorter (about half the length) while keeping the core message.',
  EXPAND:
    'Expand it with more depth and one more practical example, keeping the same message.',
  WARMER: 'Make the tone warmer, more pastoral and encouraging.',
  CONVERSATIONAL:
    'Make it more conversational and easy to read, like talking to a friend.',
  ALTERNATIVE:
    'Write a fresh alternative version with a different angle on the same idea.',
};
