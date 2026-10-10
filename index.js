const express = require('express');
const cors = require('cors');
const pino = require('pino');
const fs = require('fs');
const os = require('os');
const yts = require('yt-search');
const ytdl = require('@distube/ytdl-core');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  jidNormalizedUser,
  delay,
} = require('@whiskeysockets/baileys');

// The Signal library prints huge session dumps with console.info/console.warn.
// That floods the logs and slows the small free server, so silence only those two.
console.info = () => {};
console.warn = () => {};

const BOT_NAME = 'BIN_SAID';
const OWNER_NAME = 'Binsaid';
const PREFIX = '.';
const startedAt = Date.now();

const app = express();
app.use(cors());

const active = new Map(); // phone -> socket
const caches = new Map(); // phone -> Map(messageId -> message)
const cooldowns = new Map();

app.get('/', (req, res) => res.send(`${BOT_NAME} backend is running`));

// ---------------------------------------------------------------- helpers
const defaultSettings = {
  mode: 'public',
  autoviewstatus: false,
  autotyping: false,
  antidelete: false,
  welcomed: false,
};

function loadSettings(dir) {
  try {
    return { ...defaultSettings, ...JSON.parse(fs.readFileSync(`${dir}/settings.json`, 'utf8')) };
  } catch (e) {
    return { ...defaultSettings };
  }
}
function saveSettings(dir, s) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/settings.json`, JSON.stringify(s));
  } catch (e) {}
}

function unwrap(msg) {
  let x = msg;
  for (let i = 0; i < 4; i++) {
    x =
      x.ephemeralMessage?.message ||
      x.viewOnceMessage?.message ||
      x.viewOnceMessageV2?.message ||
      x.viewOnceMessageV2Extension?.message ||
      x.documentWithCaptionMessage?.message ||
      x;
  }
  return x;
}

function getText(msg) {
  if (!msg) return '';
  const x = unwrap(msg);
  return (
    x.conversation ||
    x.extendedTextMessage?.text ||
    x.imageMessage?.caption ||
    x.videoMessage?.caption ||
    ''
  );
}

function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
}

async function postJSON(url, body, headers = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(40000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
  return j;
}

// AI providers. Keys are read from environment variables (set them on Render).
const aiConfig = {
  chatgpt: {
    url: 'https://api.openai.com/v1/chat/completions',
    key: () => process.env.OPENAI_API_KEY,
    model: () => process.env.OPENAI_MODEL || 'gpt-4o-mini',
  },
  meta: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    key: () => process.env.GROQ_API_KEY,
    model: () => process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  },
};

function aiAvailable(p) {
  if (p === 'gemini') return !!process.env.GEMINI_API_KEY;
  return !!aiConfig[p]?.key();
}

async function askAI(provider, prompt) {
  if (!aiAvailable(provider)) throw new Error('NO_KEY');
  let out = '';
  if (provider === 'gemini') {
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const j = await postJSON(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] }
    );
    out = j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  } else {
    const c = aiConfig[provider];
    const j = await postJSON(
      c.url,
      { model: c.model(), messages: [{ role: 'user', content: prompt }] },
      { Authorization: `Bearer ${c.key()}` }
    );
    out = j.choices?.[0]?.message?.content || '';
  }
  return (out || 'Hakuna jibu.').slice(0, 3500);
}

async function bufferFromStream(stream, max) {
  const chunks = [];
  let size = 0;
  for await (const ch of stream) {
    size += ch.length;
    if (size > max) {
      stream.destroy();
      throw new Error('TOO_BIG');
    }
    chunks.push(ch);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- commands
const commands = {};
function add(name, cat, desc, fn, opts = {}) {
  commands[name] = { cat, desc, fn, owner: !!opts.owner, cool: !!opts.cool };
}

function buildMenu(c) {
  const cats = {};
  for (const [n, x] of Object.entries(commands)) (cats[x.cat] = cats[x.cat] || []).push(n);
  let t =
    `*${BOT_NAME}*\n\n` +
    `┌────────────◆\n` +
    `│ Owner: ${OWNER_NAME}\n` +
    `│ Uptime: ${fmtUptime(Date.now() - startedAt)}\n` +
    `│ Commands: ${Object.keys(commands).length}\n` +
    `│ Mode: ${c.settings.mode}\n` +
    `│ RAM: ${(process.memoryUsage().rss / 1048576).toFixed(2)} MB / ${(os.totalmem() / 1073741824).toFixed(2)} GB\n` +
    `└────────────📌\n`;
  for (const cat of ['AI', 'Media', 'Settings', 'General']) {
    if (!cats[cat]) continue;
    t += `\n┌──〔 ${cat.toUpperCase()} MENU 〕──\n`;
    for (const n of cats[cat]) t += `│ ⚡ ${PREFIX}${n}\n`;
    t += `└──────────────\n`;
  }
  return t;
}

add('menu', 'General', 'orodha ya amri', async (c) => {
  const caption = buildMenu(c);
  const opts = { quoted: c.m };
  // Put your photo next to index.js and name it menu.jpg (or set MENU_IMAGE to a direct image URL)
  if (fs.existsSync('./menu.jpg')) {
    await c.sock.sendMessage(c.jid, { image: fs.readFileSync('./menu.jpg'), caption }, opts);
  } else if (process.env.MENU_IMAGE) {
    await c.sock.sendMessage(c.jid, { image: { url: process.env.MENU_IMAGE }, caption }, opts);
  } else {
    await c.sock.sendMessage(c.jid, { text: caption }, opts);
  }
  return null;
});

add('ping', 'General', 'kasi ya bot', async (c) => {
  const ms = Math.max(0, Date.now() - Number(c.m.messageTimestamp) * 1000);
  return `Pong! ${ms} ms`;
});
add('alive', 'General', 'bot iko hai?', async () => `${BOT_NAME} iko hai na inafanya kazi.`);
add('uptime', 'General', 'muda bot imewashwa', async () => `Uptime: ${fmtUptime(Date.now() - startedAt)}`);
add('owner', 'General', 'mmiliki', async () => `Owner: ${OWNER_NAME}`);
add('time', 'General', 'saa na tarehe', async () =>
  new Date().toLocaleString('en-GB', { timeZone: 'Africa/Dar_es_Salaam', dateStyle: 'full', timeStyle: 'medium' })
);

// AI
function aiCmd(name, provider, label) {
  add(
    name,
    'AI',
    label,
    async (c) => {
      const q = c.args.join(' ');
      if (!q) return `Tumia: ${PREFIX}${name} <swali lako>`;
      try {
        return await askAI(provider, q);
      } catch (e) {
        if (e.message === 'NO_KEY') return `${label} haijawekwa bado (API key haipo).`;
        console.error(name, e.message);
        return `${label} imeshindwa kujibu. Jaribu tena baadaye.`;
      }
    },
    { cool: true }
  );
}
aiCmd('gemini', 'gemini', 'Gemini');
aiCmd('chatgpt', 'chatgpt', 'ChatGPT');
aiCmd('meta', 'meta', 'Meta AI (Llama)');
add(
  'ai',
  'AI',
  'AI ya kwanza inayopatikana',
  async (c) => {
    const q = c.args.join(' ');
    if (!q) return `Tumia: ${PREFIX}ai <swali lako>`;
    const p = ['gemini', 'chatgpt', 'meta'].find(aiAvailable);
    if (!p) return 'Hakuna AI iliyowekwa bado (API key haipo).';
    try {
      return await askAI(p, q);
    } catch (e) {
      console.error('ai', e.message);
      return 'AI imeshindwa kujibu. Jaribu tena baadaye.';
    }
  },
  { cool: true }
);

// Media: open view once (owner only, reply to the view-once message with .binsaid)
add(
  'binsaid',
  'Media',
  'reply kwenye view once ili kuifungua',
  async (c) => {
    const { sock, m, jid } = c;
    // Media opens right here in the same chat where .binsaid was used
    const me = jid;
    try {
      const inner = unwrap(m.message);
      const ctx = inner.extendedTextMessage?.contextInfo;
      const q = ctx?.quotedMessage;
      if (!q) {
        await sock.sendMessage(me, { text: `Reply kwenye picha/video/sauti ya view once, kisha andika ${PREFIX}binsaid` });
        return null;
      }
      const vo = unwrap(q);
      const type = ['imageMessage', 'videoMessage', 'audioMessage'].find((t) => vo[t]);
      if (!type) {
        await sock.sendMessage(me, { text: 'Ujumbe huo si picha, video wala sauti.' });
        return null;
      }
      const fake = {
        key: { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant },
        message: vo,
      };
      const buffer = await downloadMediaMessage(
        fake,
        'buffer',
        {},
        { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
      );
      const caption = vo[type].caption || '';
      if (type === 'imageMessage') await sock.sendMessage(me, { image: buffer, caption });
      else if (type === 'videoMessage') await sock.sendMessage(me, { video: buffer, caption });
      else await sock.sendMessage(me, { audio: buffer, mimetype: 'audio/mp4', ptt: !!vo[type].ptt });
    } catch (e) {
      console.error('binsaid error:', e.message);
      await sock.sendMessage(me, { text: 'Imeshindwa kufungua. Hakikisha una-reply kwenye ujumbe wa view once.' });
    }
    return null;
  },
  { cool: true }
);

// Media: music search + download
add(
  'play',
  'Media',
  'tafuta na pakua wimbo',
  async (c) => {
    const q = c.args.join(' ');
    if (!q) return `Tumia: ${PREFIX}play <jina la wimbo>`;
    const r = await yts(q);
    const v = r.videos[0];
    if (!v) return 'No results found.';
    if (v.seconds > 900) return 'Wimbo ni mrefu sana (zaidi ya dakika 15).';
    const caption = `*MUSIC FOUND*\n🎧 Title: ${v.title}\n⏱ Duration: ${v.timestamp}\n\n⏳ Downloading audio...`;
    try {
      await c.sock.sendMessage(c.jid, { image: { url: v.thumbnail }, caption }, { quoted: c.m });
    } catch (e) {
      await c.sock.sendMessage(c.jid, { text: caption }, { quoted: c.m });
    }
    try {
      const info = await ytdl.getInfo(v.url);
      let fmt;
      try {
        fmt = ytdl.chooseFormat(info.formats, {
          filter: (f) => f.hasAudio && !f.hasVideo && (f.mimeType || '').includes('audio/mp4'),
        });
      } catch (e) {
        fmt = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
      }
      const buf = await bufferFromStream(ytdl.downloadFromInfo(info, { format: fmt }), 40 * 1024 * 1024);
      await c.sock.sendMessage(
        c.jid,
        { audio: buf, mimetype: 'audio/mp4', fileName: `${v.title}.m4a` },
        { quoted: c.m }
      );
    } catch (e) {
      console.error('play error:', e.message);
      return `Imeshindwa kupakua audio (YouTube mara nyingi huzuia server za mtandaoni).\nLink: ${v.url}`;
    }
    return null;
  },
  { cool: true }
);

// Settings (owner only), each with on/off
function toggle(name, label) {
  add(
    name,
    'Settings',
    `${label} on/off`,
    async (c) => {
      const v = (c.args[0] || '').toLowerCase();
      if (v !== 'on' && v !== 'off') {
        return `${label}: ${c.settings[name] ? 'ON' : 'OFF'}\nTumia: ${PREFIX}${name} on au ${PREFIX}${name} off`;
      }
      c.settings[name] = v === 'on';
      c.save();
      return `${label} sasa ni ${v.toUpperCase()}`;
    },
    { owner: true }
  );
}
toggle('autoviewstatus', 'Auto view status');
toggle('autotyping', 'Auto typing');
toggle('antidelete', 'Antidelete');

add(
  'mode',
  'Settings',
  'public au self',
  async (c) => {
    const v = (c.args[0] || '').toLowerCase();
    if (v !== 'public' && v !== 'self') return `Mode: ${c.settings.mode}\nTumia: ${PREFIX}mode public au ${PREFIX}mode self`;
    c.settings.mode = v;
    c.save();
    return `Mode sasa ni ${v}`;
  },
  { owner: true }
);

// ---------------------------------------------------------------- message handling
async function onRevoke(ctx, pm) {
  const { sock, settings, cache } = ctx;
  if (!settings.antidelete) return;
  const orig = cache.get(pm.key.id);
  if (!orig || orig.key.fromMe) return;

  const owner = jidNormalizedUser(sock.user.id);
  const chat = orig.key.remoteJid;
  const sender = (orig.key.participant || chat).split('@')[0];
  let where = 'DM';
  if (chat.endsWith('@g.us')) {
    try {
      where = 'Group: ' + (await sock.groupMetadata(chat)).subject;
    } catch (e) {
      where = 'Group';
    }
  }
  await sock.sendMessage(owner, {
    text: `*ANTIDELETE*\nImefutwa na: +${sender}\nMahali: ${where}`,
  });
  try {
    await sock.sendMessage(owner, { forward: orig });
  } catch (e) {
    const t = getText(orig.message);
    await sock.sendMessage(owner, { text: t ? `Ujumbe: ${t}` : '(Ujumbe haukuweza kurudishwa)' });
  }
}

async function handleUpsert(ctx, { messages }) {
  const { sock, settings, cache, phone } = ctx;
  for (const m of messages) {
    try {
      if (!m.message || !m.key.remoteJid) continue;
      const jid = m.key.remoteJid;

      if (jid === 'status@broadcast') {
        if (settings.autoviewstatus && !m.key.fromMe) await sock.readMessages([m.key]);
        continue;
      }

      const pm = m.message.protocolMessage;
      if (pm) {
        if ((pm.type === 0 || pm.type === 'REVOKE') && pm.key) await onRevoke(ctx, pm);
        continue;
      }

      cache.set(m.key.id, m);
      if (cache.size > 3000) cache.delete(cache.keys().next().value);

      const age = Date.now() / 1000 - Number(m.messageTimestamp || 0);
      if (age > 60) continue;

      const isOwner = !!m.key.fromMe;
      if (settings.autotyping && !isOwner) {
        sock.sendPresenceUpdate('composing', jid).catch(() => {});
        setTimeout(() => sock.sendPresenceUpdate('paused', jid).catch(() => {}), 4000);
      }

      const text = getText(m.message).trim();
      if (!text.startsWith(PREFIX)) continue;
      if (!isOwner && settings.mode === 'self') continue;

      let [name, ...args] = text.slice(PREFIX.length).split(/\s+/);
      name = name.toLowerCase();
      if (name === 'autoview' && (args[0] || '').toLowerCase() === 'status') {
        name = 'autoviewstatus';
        args = args.slice(1);
      }
      const command = commands[name];
      if (!command) continue;

      if (command.owner && !isOwner) {
        await sock.sendMessage(jid, { text: 'Amri hii ni ya owner tu.' }, { quoted: m });
        continue;
      }
      if (command.cool && !isOwner) {
        const k = `${phone}:${m.key.participant || jid}`;
        if (Date.now() - (cooldowns.get(k) || 0) < 8000) continue;
        cooldowns.set(k, Date.now());
      }

      const c = { sock, m, jid, args, isOwner, settings, save: ctx.save };
      const reply = await command.fn(c);
      if (reply) await sock.sendMessage(jid, { text: reply }, { quoted: m });
    } catch (e) {
      console.error('message error:', e.message);
    }
  }
}

// ---------------------------------------------------------------- socket
async function startSock(phone, res) {
  const dir = `./sessions/${phone}`;
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  if (!caches.has(phone)) caches.set(phone, new Map());
  const msgCache = caches.get(phone);

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    // lets WhatsApp re-request messages it could not decrypt ("Waiting for this message")
    getMessage: async (key) => msgCache.get(key.id)?.message || undefined,
  });
  active.set(phone, sock);

  // remember messages the bot sends, so they can be re-sent if the phone asks again
  const origSend = sock.sendMessage.bind(sock);
  sock.sendMessage = async (...a) => {
    const r = await origSend(...a);
    if (r?.key?.id) {
      msgCache.set(r.key.id, r);
      if (msgCache.size > 3000) msgCache.delete(msgCache.keys().next().value);
    }
    return r;
  };

  const settings = loadSettings(dir);
  const ctx = { sock, phone, settings, cache: caches.get(phone), save: () => saveSettings(dir, settings) };

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('messages.upsert', (u) => handleUpsert(ctx, u));

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      console.log('Linked:', phone);
      if (!settings.welcomed) {
        settings.welcomed = true;
        ctx.save();
        try {
          await sock.sendMessage(jidNormalizedUser(sock.user.id), {
            text: `*${BOT_NAME}* imeunganishwa kikamilifu.\nAndika ${PREFIX}menu kuona amri zote.`,
          });
        } catch (e) {}
      }
    }
    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode;
      console.log('Closed:', phone, status);
      // a newer socket already replaced this one: do not reconnect it (avoids duplicate bots)
      if (active.get(phone) !== sock) return;
      if (status === DisconnectReason.loggedOut) {
        active.delete(phone);
        caches.delete(phone);
        fs.rmSync(dir, { recursive: true, force: true });
      } else {
        await delay(2000);
        startSock(phone, null).catch((e) => console.error(e));
      }
    }
  });

  if (res && !sock.authState.creds.registered) {
    await delay(3000);
    const code = await sock.requestPairingCode(phone);
    res.json({ code: code?.match(/.{1,4}/g)?.join('-') || code });
  }
}

app.get('/pair', async (req, res) => {
  const phone = (req.query.phone || '').replace(/[^0-9]/g, '');
  if (!phone || phone.length < 10) {
    return res.status(400).json({ error: 'Invalid phone number' });
  }
  try {
    const old = active.get(phone);
    if (old) {
      try { old.end(); } catch (e) {}
      active.delete(phone);
    }
    caches.delete(phone);
    fs.rmSync(`./sessions/${phone}`, { recursive: true, force: true });
    await startSock(phone, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate code' });
  }
});

async function restoreSessions() {
  if (!fs.existsSync('./sessions')) return;
  for (const phone of fs.readdirSync('./sessions')) {
    if (fs.existsSync(`./sessions/${phone}/creds.json`) && !active.has(phone)) {
      console.log('Restoring:', phone);
      startSock(phone, null).catch((e) => console.error(e));
      await delay(2000);
    }
  }
}

process.on('uncaughtException', (e) => console.error('uncaught:', e));
process.on('unhandledRejection', (e) => console.error('unhandled:', e));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('Listening on', PORT);
  restoreSessions();
});
