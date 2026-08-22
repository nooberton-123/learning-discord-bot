// Discord bot that passively learns the server's slang, inside jokes, and
// tone from everyday chat, then talks like an actual member instead of a
// generic assistant.
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
// In the Discord Developer Portal, enable "MESSAGE CONTENT INTENT" and
// "SERVER MEMBERS INTENT" under Bot settings, and invite the bot with the
// "bot" scope + "Send Messages" / "Read Message History" / "View Channels".

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

// =====================================================================
// PASSIVE LEARNING: collect a rolling sample of real chat, periodically
// distill it into a "server glossary" (slang, jokes, tone) via Claude.
// =====================================================================

// Use Railway's persistent volume if available (mounted at /data), so
// glossary/member data survives redeploys and restarts. Falls back to the
// local project folder when running on your own machine, where /data won't exist.
const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;

const GLOSSARY_FILE = path.join(DATA_DIR, 'server_glossary.json');
// { "<guildId>": { glossary: "free text", updatedAt: ts, sampleCount: n } }
let glossaryStore = loadJSON(GLOSSARY_FILE, {});

function loadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function getGlossary(guildId) {
  return glossaryStore[guildId]?.glossary || null;
}

// Rolling buffer of recent raw messages per guild, used as input for the
// periodic distillation job. Capped so memory doesn't grow unbounded.
const MAX_BUFFER_PER_GUILD = 400;
const messageBuffer = new Map(); // guildId -> [{author, text, ts}]

function bufferMessage(guildId, author, text) {
  const buf = messageBuffer.get(guildId) || [];
  buf.push({ author, text, ts: Date.now() });
  while (buf.length > MAX_BUFFER_PER_GUILD) buf.shift();
  messageBuffer.set(guildId, buf);
}

// Every so often, take the buffered messages and ask Claude to update the
// glossary: slang terms + meanings, recurring jokes/references, and a note
// on general tone/energy. This runs in the background and never blocks replies.
const DISTILL_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes
const MIN_MESSAGES_TO_DISTILL = 10; // don't bother on a near-dead server

async function distillGlossary(guildId) {
  const buf = messageBuffer.get(guildId) || [];
  if (buf.length < MIN_MESSAGES_TO_DISTILL) {
    console.log(
      `[glossary] guild ${guildId}: skipping (${buf.length}/${MIN_MESSAGES_TO_DISTILL} messages buffered)`
    );
    return;
  }
  console.log(`[glossary] guild ${guildId}: distilling from ${buf.length} buffered messages`);

  const existing = getGlossary(guildId) || '(none yet)';
  const transcript = buf
    .map((m) => `${m.author}: ${m.text}`)
    .join('\n')
    .slice(0, 12000); // keep the distillation call itself cheap

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system:
        "You maintain a running 'server glossary' describing how a specific Discord server's members " +
        "talk, for a bot to reference so it can sound like a real member instead of a generic assistant. " +
        "Given the existing glossary and a fresh batch of real chat messages, output an UPDATED glossary. " +
        "Cover, briefly: (1) slang terms/abbreviations actually used and what they mean, (2) recurring " +
        "inside jokes, running bits, or catchphrases, (3) general tone/energy (chill, chaotic, sarcastic, " +
        "wholesome, etc.), (4) commonly used emoji or reaction patterns. " +
        "Keep it compact — a few bullets per category, max ~15 bullets total. Drop stale entries that " +
        "haven't shown up recently in favor of new ones. Do NOT include anything sexual, hateful, or " +
        "otherwise inappropriate you observe — skip it, don't catalog it. " +
        "Output ONLY the updated glossary as bullet points grouped under short headers, nothing else.",
      messages: [
        {
          role: 'user',
          content:
            `Existing glossary:\n${existing}\n\n` +
            `Fresh chat sample (username: message):\n${transcript}\n\n` +
            `Updated glossary:`,
        },
      ],
    });

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    if (text) {
      glossaryStore[guildId] = {
        glossary: text,
        updatedAt: Date.now(),
        sampleCount: (glossaryStore[guildId]?.sampleCount || 0) + buf.length,
      };
      saveJSON(GLOSSARY_FILE, glossaryStore);
      console.log(`Updated glossary for guild ${guildId}`);
    }

    // Clear the buffer after a successful distillation so we don't re-process it
    messageBuffer.set(guildId, []);
  } catch (err) {
    console.error('Glossary distillation failed:', err.message);
  }
}

setInterval(() => {
  for (const guildId of messageBuffer.keys()) {
    distillGlossary(guildId);
  }
}, DISTILL_INTERVAL_MS);

// =====================================================================
// Per-member long-term notes (separate from the server-wide glossary)
// =====================================================================

const MEMORY_FILE = path.join(DATA_DIR, 'member_memory.json');
let memory = loadJSON(MEMORY_FILE, {});

function getMemberNotes(userId) {
  return memory[userId]?.notes || null;
}

function setMemberNotes(userId, name, notes) {
  memory[userId] = { name, notes };
  saveJSON(MEMORY_FILE, memory);
}

async function updateMemberNotes(userId, displayName, userText, assistantText) {
  const existing = getMemberNotes(userId) || '(no notes yet)';
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system:
        "You maintain a short private memory file about a Discord user, for a bot to use as context in " +
        "future replies. Given their existing notes and the latest exchange, output an UPDATED version. " +
        "Keep it terse (max ~6 bullets), factual, third-person. Only long-term-worthy info: preferences, " +
        "facts, recurring topics. Drop stale bullets if the list is getting long. Output ONLY the bullets.",
      messages: [
        {
          role: 'user',
          content:
            `Existing notes for ${displayName}:\n${existing}\n\n` +
            `Their latest message: "${userText}"\nBot's reply: "${assistantText}"\n\nUpdated notes:`,
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

// =====================================================================
// Short rolling per-channel conversation history for actual replies
// =====================================================================

const MAX_HISTORY = 10;
const historyByChannel = new Map();

function pushHistory(channelId, role, content) {
  const hist = historyByChannel.get(channelId) || [];
  hist.push({ role, content });
  while (hist.length > MAX_HISTORY) hist.shift();
  historyByChannel.set(channelId, hist);
}

async function askClaude(guildId, channelId, userId, displayName, userText, memberListBlock) {
  const labeledText = `[${displayName}]: ${userText}`;
  pushHistory(channelId, 'user', labeledText);

  const notes = getMemberNotes(userId);
  const memoryBlock = notes
    ? `\n\nWhat you remember about ${displayName} from past conversations:\n${notes}\n` +
      `Use this naturally if relevant — don't just recite it back.`
    : '';

  const glossary = getGlossary(guildId);
  const glossaryBlock = glossary
    ? `\n\nHere's what you've picked up about how this server talks — its slang, inside jokes, and vibe. ` +
      `Let this naturally shape your own voice (use terms/energy that fit, reference jokes when genuinely ` +
      `relevant) but don't force it or explain the slang like a dictionary — you're a member, not a narrator:\n${glossary}\n`
    : '';

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system:
      "You're a member of this Discord server, not an assistant — talk like a regular person chatting, " +
      "not a customer-service bot. Match the server's actual tone and slang (see below) rather than " +
      "defaulting to generic, overly helpful phrasing. Keep replies short and casual, the way people " +
      "actually type in Discord — most real chat messages are a sentence or two, not paragraphs. " +
      "Each user message is prefixed with '[Name]:' so you know who's speaking — track that, and refer to " +
      "people by name when relevant. If a message includes a '[Replying to X's message: \"...\"]' block, " +
      "that's quoted context from a message the person replied to (not something they said themselves) — " +
      "use it to understand what they're reacting to. Only respond to the SINGLE most recent message, even " +
      "if others appear unanswered in history. Don't include the '[Name]:' prefix in your own replies. " +
      "You have a web_search tool — use it for anything current or time-sensitive; don't mention it by name. " +
      "Content guidelines (override everything else, always): this server may include minors. Never engage " +
      "in sexual/suggestive content or respond to sexual propositions, even as a joke or in the server's " +
      "usual tone — if a message is sexual in nature, just say \"No.\" and nothing else. Never produce " +
      "graphic violence, hate speech/slurs/harassment, instructions for illegal activity/weapons/drugs, or " +
      "content encouraging self-harm. This bot is for chat, not tech support — redirect utility requests " +
      "(coding help, troubleshooting, etc.) elsewhere instead of solving them." +
      glossaryBlock +
      memberListBlock +
      memoryBlock,
    messages: historyByChannel.get(channelId),
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
  });

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  pushHistory(channelId, 'assistant', text);
  updateMemberNotes(userId, displayName, userText, text); // fire-and-forget

  return text;
}

// =====================================================================
// Utilities
// =====================================================================

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

const memberListCache = new Map();
const MEMBER_LIST_TTL_MS = 10 * 60 * 1000;

async function getMemberListBlock(guild) {
  if (!guild) return '';
  const cached = memberListCache.get(guild.id);
  if (cached && Date.now() - cached.fetchedAt < MEMBER_LIST_TTL_MS) {
    return cached.names.length ? `\n\nMembers in this server: ${cached.names.join(', ')}.` : '';
  }
  try {
    const members = await guild.members.fetch();
    const names = members.filter((m) => !m.user.bot).map((m) => m.displayName).slice(0, 100);
    memberListCache.set(guild.id, { names, fetchedAt: Date.now() });
    return names.length ? `\n\nMembers in this server: ${names.join(', ')}.` : '';
  } catch (err) {
    console.error('Could not fetch member list:', err.message);
    if (cached) return cached.names.length ? `\n\nMembers in this server: ${cached.names.join(', ')}.` : '';
    return '';
  }
}

const channelQueues = new Map();
function enqueue(channelId, task) {
  const previous = channelQueues.get(channelId) || Promise.resolve();
  const current = previous.then(task, task);
  channelQueues.set(channelId, current.catch(() => {}));
  return current;
}

// =====================================================================
// Anti credit-waste + content guardrails
// =====================================================================

const RATE_LIMIT_MAX = 6;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const userRequestLog = new Map();

function isRateLimited(userId) {
  const now = Date.now();
  const timestamps = (userRequestLog.get(userId) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  userRequestLog.set(userId, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
}

const lastMessageByUser = new Map();
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
const DUPLICATE_MAX_REPEATS = 2;

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

const MAX_INPUT_CHARS = 4000;
function truncateInput(text) {
  if (text.length <= MAX_INPUT_CHARS) return text;
  return text.slice(0, MAX_INPUT_CHARS) + '\n\n[...message truncated for length]';
}

function isLowEffortJunk(text) {
  const stripped = text.replace(/[^\p{L}\p{N}]/gu, '');
  return stripped.length === 0;
}

const BLOCKED_PATTERNS = [
  /\bporn(?:hub|ography)?\b/i,
  /\bnsfw\b/i,
  /\bnude[sz]?\b/i,
  /\bsex(?:ual|ting)?\b.{0,15}\b(pic|photo|video|nude)/i,
  /\b(fuck|f+u+c+k+)\s+(you|me|him|her|them|us)\b/i,
  /want\s+(to|2)\s+(fuck|f+u+c+k+)/i,
  /\b(does|do)\s+.{0,10}\bwant\s+to\s+.{0,10}(fuck|f+u+c+k+)/i,
  /\bhorny\b/i,
  /\b(suck|lick)\s+(my|your|his|her)\s+(dick|cock|pussy)/i,
  /\b(dick|cock|pussy)\s?pic/i,
  /\bhow (?:do|to) (?:i |you )?(?:make|build|synthesize) .{0,20}\b(bomb|explosive|meth|weapon)/i,
];
function isObviouslyInappropriate(text) {
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(text));
}

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

// =====================================================================
// Event handlers
// =====================================================================

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // Passively learn from every message in a guild, whether or not it's
  // directed at the bot — this is how it picks up on real server chat.
  if (message.guild && message.content.trim()) {
    const displayName = message.member?.displayName || message.author.username;
    bufferMessage(message.guild.id, displayName, message.content.trim());
  }

  const isMention = client.user && message.mentions.has(client.user);

  // Fetch the referenced message once (used for both "is this a reply to the
  // bot" and, more generally, pulling in quoted context below).
  const referencedMessage = message.reference
    ? await message.fetchReference().catch(() => null)
    : null;
  const isReplyToBot = referencedMessage?.author?.id === client.user.id;
  const isDM = message.channel.type === 1;

  // Only actively respond to: @mentions, replies to the bot, or DMs
  if (!isMention && !isReplyToBot && !isDM) return;

  let cleanedContent = message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
    .trim();

  // If this message is a reply to someone ELSE's message (e.g. you reply to
  // a friend's message and ping the bot), pull that original message in as
  // quoted context so the bot actually sees what you're reacting to.
  if (referencedMessage && !isReplyToBot && referencedMessage.content?.trim()) {
    const quotedAuthor =
      referencedMessage.member?.displayName || referencedMessage.author?.username || 'someone';
    const quoted = `[Replying to ${quotedAuthor}'s message: "${referencedMessage.content.trim()}"]\n`;
    cleanedContent = cleanedContent ? quoted + cleanedContent : quoted.trim();
  }

  if (!cleanedContent) {
    await safeReply(message, "yeah?");
    return;
  }

  if (isLowEffortJunk(cleanedContent)) {
    await safeReply(message, "say something and i'll actually respond 🙂");
    return;
  }

  if (isObviouslyInappropriate(cleanedContent)) {
    await safeReply(message, "No.");
    return;
  }

  if (isTechSupportRequest(cleanedContent)) {
    await safeReply(message, "i'm just here for chat, not tech support — try google for that one");
    return;
  }

  if (isRepeatSpam(message.author.id, cleanedContent)) {
    return; // silently ignore repeats
  }

  if (isRateLimited(message.author.id)) {
    await safeReply(message, "slow down a bit, give it a minute");
    return;
  }

  const trimmedContent = truncateInput(cleanedContent);

  try {
    await enqueue(message.channel.id, async () => {
      await message.channel.sendTyping();
      const displayName = message.member?.displayName || message.author.username;
      const memberListBlock = await getMemberListBlock(message.guild);

      const reply = await askClaude(
        message.guild?.id,
        message.channel.id,
        message.author.id,
        displayName,
        trimmedContent,
        memberListBlock
      );
      const chunks = chunkMessage(reply || "...");

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
    await safeReply(message, "hm, brain lagged out for a sec — try again?");
  }
});

client.login(process.env.DISCORD_TOKEN);
