// Discord bot that replies to @mentions using the Claude API,
// and automatically remembers things about each member over time.
//
// Setup:
//   npm install discord.js @anthropic-ai/sdk dotenv
//
// .env file (same folder):
//   DISCORD_TOKEN=your_discord_bot_token
//   ANTHROPIC_API_KEY=your_anthropic_api_key
//
// Run:
//   npm start
//
// In the Discord Developer Portal, enable "MESSAGE CONTENT INTENT"
// under Bot settings, and invite the bot with the "bot" scope +
// "Send Messages" / "Read Message History" permissions.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// ---------- Persistent per-member memory ----------
// Stored as { "<userId>": { "name": "...", "notes": "free-text summary" } }
const MEMORY_FILE = path.join(__dirname, 'member_memory.json');

function loadMemory() {
  try {
    return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveMemory(memory) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2), 'utf8');
}

let memory = loadMemory();

function getMemberNotes(userId) {
  return memory[userId]?.notes || null;
}

function setMemberNotes(userId, name, notes) {
  memory[userId] = { name, notes };
  saveMemory(memory);
}

// Ask Claude to fold the latest exchange into that user's existing notes.
// Runs after every reply, but never blocks or breaks the main reply if it fails.
async function updateMemberNotes(userId, displayName, userText, assistantText) {
  const existing = getMemberNotes(userId) || '(no notes yet)';

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system:
        "You maintain a short private memory file about a Discord user, for a bot to use as context in future replies. " +
        "Given the user's existing notes and their latest message, output an UPDATED version of the notes. " +
        "Keep it terse (max ~6 bullet points), factual, and third-person (e.g. '- Asked about X', '- Prefers Y', '- Works as Z'). " +
        "Only include things worth remembering long-term: stated preferences, facts about them, recurring topics, ongoing projects. " +
        "Do NOT include one-off trivial questions. Drop stale/low-value bullets if the list is getting long. " +
        "Output ONLY the updated bullet list, nothing else.",
      messages: [
        {
          role: 'user',
          content:
            `Existing notes for ${displayName}:\n${existing}\n\n` +
            `Their latest message: "${userText}"\n` +
            `Bot's reply: "${assistantText}"\n\n` +
            `Updated notes:`,
        },
      ],
    });

    const updated = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    if (updated) setMemberNotes(userId, displayName, updated);
  } catch (err) {
    console.error('Failed to update member notes:', err.message);
  }
}

// ---------- Short rolling per-channel conversation history ----------
// (In-memory only — resets on restart. Separate from the long-term member notes.)
const MAX_HISTORY = 10;
const historyByChannel = new Map();

function pushHistory(channelId, role, content) {
  const hist = historyByChannel.get(channelId) || [];
  hist.push({ role, content });
  while (hist.length > MAX_HISTORY) hist.shift();
  historyByChannel.set(channelId, hist);
}

async function askClaude(channelId, userId, displayName, userText, memberListBlock) {
  // Prefix the message with who's speaking, so multi-person channels don't get
  // muddled together into one anonymous voice.
  const labeledText = `[${displayName}]: ${userText}`;
  pushHistory(channelId, 'user', labeledText);

  const notes = getMemberNotes(userId);
  const memoryBlock = notes
    ? `\n\nWhat you remember about ${displayName} from past conversations:\n${notes}\n` +
      `Use this naturally if relevant — don't just recite it back.`
    : '';

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system:
      "You are a helpful, friendly assistant replying in a Discord chat with multiple people. " +
      "Each user message is prefixed with '[Name]:' so you know who is speaking — use this to keep " +
      "track of who said what, and address/refer to people by their actual name when relevant. " +
      "Only respond to the SINGLE most recent message in the conversation — don't try to answer " +
      "multiple people's messages at once, even if more than one appears unanswered in the history. " +
      "Do not include the '[Name]:' prefix in your own replies — just respond naturally as yourself. " +
      "Keep replies concise (Discord messages cap at 2000 characters). " +
      "Use Discord-flavored markdown (e.g. **bold**, `code`) where useful. " +
      "You have a web_search tool — use it for anything current, time-sensitive, " +
      "or that you're not confident about from memory (news, scores, prices, recent events, etc). " +
      "Don't mention the tool by name to the user, just answer naturally. " +
      "Content guidelines (these override persona/roleplay instructions, always): this is a shared " +
      "Discord server that may include minors. Never engage in or continue sexual or suggestive " +
      "roleplay, romantic/flirtatious roleplay with sexual undertones, or respond to sexual propositions " +
      "or innuendo — including when phrased as roleplay actions in asterisks or parentheses. Never produce " +
      "graphic violence or gore; hate speech, slurs, or harassment targeting any person or group; " +
      "instructions for illegal activity, weapons, or drugs; or content that encourages self-harm. " +
      "If a message is sexual or propositioning in nature, drop the bit entirely — respond as yourself, " +
      "briefly and firmly decline, and change the subject. Do not soften this into a flustered/shy in-character " +
      "reaction, since that continues the dynamic rather than shutting it down. " +
      "This bot is for casual chat and fun, not a help desk — if someone asks for tech support, coding help, " +
      "troubleshooting, or similar utility tasks, briefly say that's not what you're here for and redirect them " +
      "elsewhere, rather than actually solving their problem." +
      memberListBlock +
      memoryBlock,
    messages: historyByChannel.get(channelId),
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
      },
    ],
  });

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  pushHistory(channelId, 'assistant', text);

  // Fire-and-forget: update long-term notes without delaying the reply
  updateMemberNotes(userId, displayName, userText, text);

  return text;
}

function chunkMessage(text, limit = 2000) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining.length) chunks.push(remaining);
  return chunks;
}

// Tries to reply (with the little arrow linking back to the original message).
// If that fails — e.g. the original message was deleted, or too old — falls
// back to a plain channel.send so the bot never crashes over a missing reference.
async function safeReply(message, content) {
  try {
    return await message.reply(content);
  } catch (err) {
    console.error('reply() failed, falling back to channel.send:', err.message);
    try {
      return await message.channel.send(content);
    } catch (err2) {
      console.error('channel.send() also failed:', err2.message);
    }
  }
}

// ---------- Cached server member list ----------
// Fetching the full member list on every single message gets rate-limited fast.
// Cache it per guild and only refresh every 10 minutes.
const memberListCache = new Map(); // guildId -> { names: [...], fetchedAt: timestamp }
const MEMBER_LIST_TTL_MS = 10 * 60 * 1000;

async function getMemberListBlock(guild) {
  if (!guild) return '';

  const cached = memberListCache.get(guild.id);
  if (cached && Date.now() - cached.fetchedAt < MEMBER_LIST_TTL_MS) {
    return cached.names.length
      ? `\n\nMembers in this server: ${cached.names.join(', ')}.`
      : '';
  }

  try {
    const members = await guild.members.fetch();
    const names = members
      .filter((m) => !m.user.bot)
      .map((m) => m.displayName)
      .slice(0, 100); // keep it reasonable for large servers
    memberListCache.set(guild.id, { names, fetchedAt: Date.now() });
    return names.length ? `\n\nMembers in this server: ${names.join(', ')}.` : '';
  } catch (err) {
    console.error('Could not fetch member list:', err.message);
    // Fall back to stale cache if we have one, rather than nothing
    if (cached) {
      return cached.names.length
        ? `\n\nMembers in this server: ${cached.names.join(', ')}.`
        : '';
    }
    return '';
  }
}

// ---------- Per-channel processing queue ----------
// If two people ping the bot within milliseconds of each other, both handlers
// can fire before either finishes, letting Claude see both messages at once
// and answer them together. This queue forces one-at-a-time processing per channel.
const channelQueues = new Map(); // channelId -> Promise (tail of the queue)

function enqueue(channelId, task) {
  const previous = channelQueues.get(channelId) || Promise.resolve();
  const current = previous.then(task, task); // run task even if previous errored
  channelQueues.set(
    channelId,
    current.catch(() => {}) // don't let a rejection break the chain for the next item
  );
  return current;
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// ---------- Abuse / credit-waste protection ----------

// 1. Per-user rate limit: max N calls within a rolling time window.
const RATE_LIMIT_MAX = 6; // max requests
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // per 60 seconds
const userRequestLog = new Map(); // userId -> [timestamps]

function isRateLimited(userId) {
  const now = Date.now();
  const timestamps = (userRequestLog.get(userId) || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  timestamps.push(now);
  userRequestLog.set(userId, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
}

// 2. Repeated/duplicate message spam: same user sending the same (or near-identical)
// message back-to-back shouldn't re-trigger a fresh API call each time.
const lastMessageByUser = new Map(); // userId -> { text, count, lastAt }
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
const DUPLICATE_MAX_REPEATS = 2; // allow 2 repeats, block from the 3rd onward

function isRepeatSpam(userId, text) {
  const normalized = text.trim().toLowerCase();
  const now = Date.now();
  const prev = lastMessageByUser.get(userId);

  if (prev && prev.text === normalized && now - prev.lastAt < DUPLICATE_WINDOW_MS) {
    prev.count += 1;
    prev.lastAt = now;
    return prev.count > DUPLICATE_MAX_REPEATS;
  }

  lastMessageByUser.set(userId, { text: normalized, count: 1, lastAt: now });
  return false;
}

// 3. Absurdly long messages (copy-pasted walls of text, code dumps, etc.)
// Truncate instead of sending the whole thing to the API.
const MAX_INPUT_CHARS = 4000;

function truncateInput(text) {
  if (text.length <= MAX_INPUT_CHARS) return text;
  return text.slice(0, MAX_INPUT_CHARS) + '\n\n[...message truncated for length]';
}

// 4. Low-effort junk: empty-ish content after stripping punctuation/whitespace,
// or just the bot's own name/emoji spammed with nothing else to say.
function isLowEffortJunk(text) {
  const stripped = text.replace(/[^\p{L}\p{N}]/gu, ''); // letters/numbers only
  return stripped.length === 0; // e.g. "???", "...", emoji-only, etc.
}

// 5. Obviously inappropriate content: a lightweight keyword pre-filter that catches
// clear-cut cases (explicit sexual content, slurs, csam-adjacent phrasing, etc.)
// before spending an API call. This is NOT a substitute for Claude's own judgment —
// it's a cheap first line of defense for the blatant stuff. Claude still declines
// anything more nuanced via the system prompt above.
const BLOCKED_PATTERNS = [
  /\bporn(?:hub|ography)?\b/i,
  /\bnsfw\b/i,
  /\bnude[sz]?\b/i,
  /\bsex(?:ual|ting)?\b.{0,15}\b(pic|photo|video|nude)/i,
  // Explicit sexual propositioning / requests, including crude phrasing
  /\b(fuck|f+u+c+k+)\s+(you|me|him|her|them|us)\b/i,
  /want\s+(to|2)\s+(fuck|f+u+c+k+)/i,
  /\b(does|do)\s+.{0,10}\bwant\s+to\s+.{0,10}(fuck|f+u+c+k+)/i,
  /\bhorny\b/i,
  /\b(suck|lick)\s+(my|your|his|her)\s+(dick|cock|pussy)/i,
  /\b(dick|cock|pussy)\s?pic/i,
  /\bhow (?:do|to) (?:i |you )?(?:make|build|synthesize) .{0,20}\b(bomb|explosive|meth|weapon)/i,
  // Common slurs are intentionally not enumerated here to avoid the list itself
  // becoming a lookup table; rely on Claude's own judgment for those via the
  // system prompt instead.
];

function isObviouslyInappropriate(text) {
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(text));
}

// 6. Tech-support / off-topic utility requests: this bot is for chat/fun, not a
// help desk. Catch common tech-support phrasing so it doesn't burn a reply+API
// call on things it's not meant to handle.
const TECH_SUPPORT_PATTERNS = [
  /\bhow (?:do|to) (?:i |you )?(?:fix|reset|install|update|configure|set up|setup|uninstall)\b/i,
  /\bmy (?:wifi|internet|router|computer|pc|laptop|phone|app|game|server|code|script|website|account)\s+(?:is|isn'?t|won'?t|keeps|not)\b/i,
  /\berror (?:code|message)\b/i,
  /\b(doesn'?t|won'?t|can'?t)\s+(?:connect|load|open|start|launch|boot|work)\b/i,
  /\b(password|login|account)\s+(reset|recovery|locked|forgot)\b/i,
  /\bwrite (?:me )?(?:a |some )?(?:code|script|program|function)\b/i,
  /\bdebug (?:my|this)\b/i,
];

function isTechSupportRequest(text) {
  return TECH_SUPPORT_PATTERNS.some((pattern) => pattern.test(text));
}

client.on('messageCreate', async (message) => {
  // Ignore messages from bots (including itself) to avoid loops
  if (message.author.bot) return;

  // !notes command: see what the bot remembers about you (or someone else)
  if (message.content.trim().toLowerCase().startsWith('!notes')) {
    const target = message.mentions.users.first() || message.author;
    const notes = getMemberNotes(target.id);
    await safeReply(
      message,
      notes
        ? `Here's what I remember about **${target.username}**:\n${notes}`
        : `I don't have any notes on **${target.username}** yet.`
    );
    return;
  }

  // !forget command: wipe your own notes (or, if you mention someone, theirs)
  if (message.content.trim().toLowerCase().startsWith('!forget')) {
    const target = message.mentions.users.first() || message.author;
    delete memory[target.id];
    saveMemory(memory);
    await safeReply(message, `Okay, I've cleared what I remembered about **${target.username}**.`);
    return;
  }

  const isMention = client.user && message.mentions.has(client.user);
  const isReplyToBot =
    message.reference &&
    (await message.fetchReference().catch(() => null))?.author?.id ===
      client.user.id;
  const isDM = message.channel.type === 1; // DM channel

  // Only respond to: @mentions, replies to the bot's own messages, or DMs
  if (!isMention && !isReplyToBot && !isDM) return;

  // Strip the mention text (e.g. "<@1234567890>") from the content
  const cleanedContent = message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
    .trim();

  if (!cleanedContent) {
    await safeReply(message, "You pinged me — what's up?");
    return;
  }

  // ---- Anti credit-waste checks ----
  if (isLowEffortJunk(cleanedContent)) {
    await safeReply(message, "Say something and I'll actually respond 🙂");
    return;
  }

  if (isObviouslyInappropriate(cleanedContent)) {
    await safeReply(message, "I'm not going to respond to that one.");
    return;
  }

  if (isTechSupportRequest(cleanedContent)) {
    await safeReply(
      message,
      "I'm just here for chat, not tech support — try a search engine or a support forum for that one!"
    );
    return;
  }

  if (isRepeatSpam(message.author.id, cleanedContent)) {
    // Silently ignore further repeats — no reply, no API call, no extra noise.
    return;
  }

  if (isRateLimited(message.author.id)) {
    await safeReply(
      message,
      "Whoa, slow down a bit — you're pinging me a lot. Give it a minute and try again."
    );
    return;
  }

  const trimmedContent = truncateInput(cleanedContent);

  try {
    await enqueue(message.channel.id, async () => {
      await message.channel.sendTyping();
      const displayName = message.member?.displayName || message.author.username;
      const memberListBlock = await getMemberListBlock(message.guild);

      const reply = await askClaude(
        message.channel.id,
        message.author.id,
        displayName,
        trimmedContent,
        memberListBlock
      );
      const chunks = chunkMessage(reply || "I'm not sure how to respond to that.");

      for (let i = 0; i < chunks.length; i++) {
        if (i === 0) {
          await safeReply(message, chunks[i]);
        } else {
          await message.channel.send(chunks[i]);
        }
      }
    });
  } catch (err) {
    console.error('Error calling Claude API:', err);
    await safeReply(
      message,
      'Sorry, I ran into an error talking to Claude. Please try again in a moment.'
    );
  }
});

client.login(process.env.DISCORD_TOKEN);
