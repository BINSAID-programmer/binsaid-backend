// The "brain": commands that do not care which platform they run on.
//
// A platform adapter (WhatsApp, web, ...) builds a context object `c` with:
//   c.platform      'whatsapp' | 'web'
//   c.isOwner       true when the sender owns the bot
//   c.userKey       string used for cooldowns
//   c.settings      per-user settings (WhatsApp) or a fixed object (web)
//   c.history       optional array of earlier AI turns (web keeps these)
//   c.reply(text)                      send text
//   c.sendImage(src, caption)          src = Buffer | { url } | { path }
//   c.sendAudio(src, { title, link })  src = Buffer | { url }
// and then calls run(c, text).

const fs = require('fs');
const os = require('os');
const path = require('path');
const ai = require('./ai');
const media = require('./media');
const { onCooldown, fmtUptime } = require('./util');

const BOT_NAME = 'BIN_SAID';
const OWNER_NAME = 'Binsaid';
const PREFIX = '.';
const startedAt = Date.now();
const MENU_PATH = path.join(__dirname, '..', 'menu.jpg');

const commands = {};

// opts: {
//   owner: owner-only,
//   cool:  cooldown for non-owners. `true` = its own cooldown, a string = shared group (e.g. 'ai'),
//   only:  ['whatsapp'] = platforms that support it
// }
function add(name, cat, desc, fn, opts = {}) {
  commands[name] = {
    cat,
    desc,
    fn,
    owner: !!opts.owner,
    cool: !!opts.cool,
    coolGroup: typeof opts.cool === 'string' ? opts.cool : name,
    only: opts.only || null,
  };
}

function forPlatform(platform) {
  return Object.entries(commands).filter(([, x]) => !x.only || x.only.includes(platform));
}

function menuImage() {
  if (fs.existsSync(MENU_PATH)) return { path: MENU_PATH };
  if (process.env.MENU_IMAGE) return { url: process.env.MENU_IMAGE };
  return null;
}

function buildMenu(c) {
  const list = forPlatform(c.platform);
  const cats = {};
  for (const [n, x] of list) (cats[x.cat] = cats[x.cat] || []).push(n);

  let t =
    `*${BOT_NAME}*\n\n` +
    `┌────────────◆\n` +
    `│ Owner: ${OWNER_NAME}\n` +
    `│ Uptime: ${fmtUptime(Date.now() - startedAt)}\n` +
    `│ Commands: ${list.length}\n` +
    `│ Platform: ${c.platform === 'web' ? 'Web' : 'WhatsApp'}\n`;
  if (c.platform === 'whatsapp') {
    t +=
      `│ Mode: ${c.settings.mode}\n` +
      `│ RAM: ${(process.memoryUsage().rss / 1048576).toFixed(2)} MB / ${(os.totalmem() / 1073741824).toFixed(2)} GB\n`;
  }
  t += `└────────────📌\n`;

  for (const cat of ['AI', 'Media', 'Settings', 'General']) {
    if (!cats[cat]) continue;
    t += `\n┌──〔 ${cat.toUpperCase()} MENU 〕──\n`;
    for (const n of cats[cat]) t += `│ ⚡ ${PREFIX}${n}\n`;
    t += `└──────────────\n`;
  }
  if (c.platform === 'web') t += `\nAndika ujumbe wowote bila "." na AI itakujibu.`;
  return t;
}

// Turn ".name arg arg" into { name, args }, or null when it is not a command.
function parse(text) {
  if (!text || !text.startsWith(PREFIX)) return null;
  let [name, ...args] = text.slice(PREFIX.length).trim().split(/\s+/);
  name = (name || '').toLowerCase();
  if (!name) return null;
  if (name === 'autoview' && (args[0] || '').toLowerCase() === 'status') {
    name = 'autoviewstatus';
    args = args.slice(1);
  }
  return { name, args };
}

// Runs a command. Returns false when `text` is not a known command.
async function run(c, text) {
  const parsed = parse(text);
  if (!parsed) return false;
  const cmd = commands[parsed.name];
  if (!cmd) return false;

  if (cmd.only && !cmd.only.includes(c.platform)) {
    await c.reply(`Amri hii inapatikana kwenye ${cmd.only.join(', ')} tu.`);
    return true;
  }
  if (cmd.owner && !c.isOwner) {
    await c.reply('Amri hii ni ya owner tu.');
    return true;
  }
  if (cmd.cool && !c.isOwner && onCooldown(`${c.userKey}:${cmd.coolGroup}`, c.cooldownMs || 8000)) {
    if (c.platform === 'web') await c.reply('⏳ Subiri sekunde chache kisha ujaribu tena.');
    return true;
  }

  c.args = parsed.args;
  const out = await cmd.fn(c);
  if (out) await c.reply(out);
  return true;
}

// ---------------------------------------------------------------- general
add('menu', 'General', 'orodha ya amri', async (c) => {
  const caption = buildMenu(c);
  const img = menuImage();
  if (img) {
    await c.sendImage(img, caption);
    return null;
  }
  return caption;
});

add('ping', 'General', 'kasi ya bot', async (c) =>
  c.latencyMs != null ? `Pong! ${c.latencyMs} ms` : 'Pong!'
);
add('alive', 'General', 'bot iko hai?', async () => `${BOT_NAME} iko hai na inafanya kazi.`);
add('uptime', 'General', 'muda bot imewashwa', async () => `Uptime: ${fmtUptime(Date.now() - startedAt)}`);
add('owner', 'General', 'mmiliki', async () => `Owner: ${OWNER_NAME}`);
add(
  'about',
  'General',
  'kuhusu bot',
  async () => `*${BOT_NAME}* ni bot inayofanya kazi WhatsApp na kwenye tovuti, iliyotengenezwa na ${OWNER_NAME}.\nAndika ${PREFIX}menu kuona amri zote.`
);
add('time', 'General', 'saa na tarehe', async () =>
  new Date().toLocaleString('en-GB', { timeZone: 'Africa/Dar_es_Salaam', dateStyle: 'full', timeStyle: 'medium' })
);

// ---------------------------------------------------------------- AI
async function answer(c, provider, label, name) {
  const q = c.args.join(' ');
  if (!q) return `Tumia: ${PREFIX}${name} <swali lako>`;
  if (!ai.available(provider)) return `${label} haijawekwa bado (API key haipo).`;
  try {
    const text = await ai.ask(provider, q, c.history || []);
    if (c.history) {
      c.history.push({ role: 'user', content: q }, { role: 'assistant', content: text });
      while (c.history.length > 12) c.history.shift();
    }
    return text;
  } catch (e) {
    console.error(name, e.message);
    return `${label} imeshindwa kujibu. Jaribu tena baadaye.`;
  }
}

function aiCmd(name, provider, label) {
  add(name, 'AI', label, (c) => answer(c, provider, label, name), { cool: 'ai' });
}
aiCmd('gemini', 'gemini', 'Gemini');
aiCmd('chatgpt', 'chatgpt', 'ChatGPT');
aiCmd('meta', 'meta', 'Meta AI (Llama)');
add(
  'ai',
  'AI',
  'AI ya kwanza inayopatikana',
  async (c) => {
    const p = ai.firstAvailable();
    if (!p) return 'Hakuna AI iliyowekwa bado (API key haipo).';
    return answer(c, p, 'AI', 'ai');
  },
  { cool: 'ai' }
);

// ---------------------------------------------------------------- media
add(
  'play',
  'Media',
  'tafuta na pakua wimbo',
  async (c) => {
    const q = c.args.join(' ');
    if (!q) return `Tumia: ${PREFIX}play <jina la wimbo>`;
    const v = await media.search(q);
    if (!v) return 'No results found.';
    if (v.seconds > 900) return 'Wimbo ni mrefu sana (zaidi ya dakika 15).';

    const caption = `*MUSIC FOUND*\n🎧 Title: ${v.title}\n⏱ Duration: ${v.timestamp}\n\n⏳ Downloading audio...`;
    await c.sendImage({ url: v.thumbnail }, caption);
    try {
      if (c.platform === 'web') {
        // the browser streams it from /api/audio
        await c.sendAudio({ url: `/api/audio?id=${v.videoId}` }, { title: v.title, link: v.url });
      } else {
        const buf = await media.toBuffer(v.url, 40 * 1024 * 1024);
        await c.sendAudio(buf, { title: v.title, link: v.url });
      }
    } catch (e) {
      console.error('play error:', e.message);
      return `Imeshindwa kupakua audio (YouTube mara nyingi huzuia server za mtandaoni).\nLink: ${v.url}`;
    }
    return null;
  },
  { cool: true }
);

module.exports = { BOT_NAME, OWNER_NAME, PREFIX, MENU_PATH, add, run, parse };
