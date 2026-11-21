// WhatsApp adapter: links numbers with a pairing code, listens for messages,
// and hands commands to the shared core. Also holds the WhatsApp-only features
// (view once, antidelete, auto view status, auto typing).

const pino = require('pino');
const fs = require('fs');
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
const core = require('../core/commands');
const { onCooldown } = require('../core/util');

const { BOT_NAME, PREFIX } = core;

const active = new Map(); // phone -> socket
const caches = new Map(); // phone -> Map(messageId -> message)

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

// ---------------------------------------------------------------- WhatsApp-only commands
const WA = { only: ['whatsapp'] };

// Open view once: reply to the view-once message with .binsaid (works for everyone)
core.add(
  'binsaid',
  'Media',
  'reply kwenye view once ili kuifungua',
  async (c) => {
    const { sock, m, jid } = c;
    try {
      const inner = unwrap(m.message);
      const ctx = inner.extendedTextMessage?.contextInfo;
      const q = ctx?.quotedMessage;
      if (!q) {
        await sock.sendMessage(jid, { text: `Reply kwenye picha/video/sauti ya view once, kisha andika ${PREFIX}binsaid` });
        return null;
      }
      const vo = unwrap(q);
      const type = ['imageMessage', 'videoMessage', 'audioMessage'].find((t) => vo[t]);
      if (!type) {
        await sock.sendMessage(jid, { text: 'Ujumbe huo si picha, video wala sauti.' });
        return null;
      }
      // cooldown only when a real download starts, so a wrong usage does not block the next try
      if (!c.isOwner && onCooldown(`${c.userKey}:binsaid`, 3000)) return null;
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
      if (type === 'imageMessage') await sock.sendMessage(jid, { image: buffer, caption });
      else if (type === 'videoMessage') await sock.sendMessage(jid, { video: buffer, caption });
      else await sock.sendMessage(jid, { audio: buffer, mimetype: 'audio/mp4', ptt: !!vo[type].ptt });
    } catch (e) {
      console.error('binsaid error:', e.message);
      await sock.sendMessage(jid, { text: 'Imeshindwa kufungua. Hakikisha una-reply kwenye ujumbe wa view once.' });
    }
    return null;
  },
  { only: ['whatsapp'] }
);

// Settings (owner only), each with on/off
function toggle(name, label) {
  core.add(
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
    { owner: true, ...WA }
  );
}
toggle('autoviewstatus', 'Auto view status');
toggle('autotyping', 'Auto typing');
toggle('antidelete', 'Antidelete');

core.add(
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
  { owner: true, ...WA }
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

// Builds the platform-neutral context the core expects.
function makeContext(ctx, m, isOwner) {
  const { sock, settings, phone } = ctx;
  const jid = m.key.remoteJid;
  const quoted = { quoted: m };
  return {
    platform: 'whatsapp',
    isOwner,
    settings,
    save: ctx.save,
    userKey: `${phone}:${m.key.participant || jid}`,
    latencyMs: Math.max(0, Date.now() - Number(m.messageTimestamp) * 1000),
    // WhatsApp-only commands use these directly
    sock,
    m,
    jid,
    reply: (text) => sock.sendMessage(jid, { text }, quoted),
    sendImage: async (src, caption) => {
      const image = Buffer.isBuffer(src) ? src : src.path ? fs.readFileSync(src.path) : { url: src.url };
      try {
        await sock.sendMessage(jid, { image, caption }, quoted);
      } catch (e) {
        await sock.sendMessage(jid, { text: caption }, quoted);
      }
    },
    sendAudio: (src, o = {}) =>
      sock.sendMessage(
        jid,
        {
          audio: Buffer.isBuffer(src) ? src : { url: src.url },
          mimetype: 'audio/mp4',
          fileName: `${o.title || 'audio'}.m4a`,
        },
        quoted
      ),
  };
}

async function handleUpsert(ctx, { messages }) {
  const { sock, settings, cache } = ctx;
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

      await core.run(makeContext(ctx, m, isOwner), text);
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
  const ctx = { sock, phone, settings, cache: msgCache, save: () => saveSettings(dir, settings) };

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

function mount(app) {
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
}

// Reconnect saved sessions when the server starts
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

module.exports = { mount, restoreSessions };
