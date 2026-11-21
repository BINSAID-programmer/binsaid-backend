// Web adapter: lets a browser talk to the same commands as WhatsApp.
//   POST /api/chat        { message, sessionId } -> { ok, messages: [...] }
//   GET  /api/audio?id=   streams a song as audio
//   GET  /api/menu-image  the picture shown with .menu
//
// Anyone on the internet can call this, so it is rate limited per IP and
// owner-only / WhatsApp-only commands are not available here.

const fs = require('fs');
const core = require('../core/commands');
const media = require('../core/media');

const { PREFIX } = core;

const WEB_SETTINGS = { mode: 'public' };
const MAX_MESSAGE = 1000;
const PER_MINUTE = 20;
const PER_DAY = 200;
const MAX_STREAMS = 2;

const sessions = new Map(); // sessionId -> { history, last }
const minuteHits = new Map(); // ip -> [timestamps]
const dayHits = new Map(); // ip -> { day, n }
let streams = 0;

function allow(ip) {
  const now = Date.now();
  const recent = (minuteHits.get(ip) || []).filter((t) => now - t < 60000);
  const day = new Date(now).toISOString().slice(0, 10);
  const d = dayHits.get(ip);
  const today = d && d.day === day ? d : { day, n: 0 };

  if (recent.length >= PER_MINUTE) {
    minuteHits.set(ip, recent);
    return 'minute';
  }
  if (today.n >= PER_DAY) return 'day';

  recent.push(now);
  minuteHits.set(ip, recent);
  today.n += 1;
  dayHits.set(ip, today);
  return null;
}

function getSession(id) {
  let s = sessions.get(id);
  if (!s) {
    s = { history: [], last: 0 };
    sessions.set(id, s);
  }
  s.last = Date.now();
  return s;
}

// forget old chats and counters so memory does not grow forever
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.last > 30 * 60 * 1000) sessions.delete(id);
  for (const [ip, arr] of minuteHits) if (!arr.some((t) => now - t < 60000)) minuteHits.delete(ip);
  const today = new Date(now).toISOString().slice(0, 10);
  for (const [ip, d] of dayHits) if (d.day !== today) dayHits.delete(ip);
}, 10 * 60 * 1000).unref();

function mount(app) {
  app.post('/api/chat', async (req, res) => {
    const limited = allow(req.ip);
    if (limited) {
      return res.status(429).json({
        error:
          limited === 'minute'
            ? 'Maombi mengi sana. Subiri dakika moja kisha ujaribu tena.'
            : 'Umefikia kikomo cha leo. Jaribu tena kesho.',
      });
    }

    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    const sid = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
    if (!message) return res.status(400).json({ error: 'Andika ujumbe.' });
    if (message.length > MAX_MESSAGE) {
      return res.status(400).json({ error: `Ujumbe ni mrefu sana (herufi ${MAX_MESSAGE} juu).` });
    }
    if (!/^[\w-]{8,64}$/.test(sid)) return res.status(400).json({ error: 'Session si sahihi.' });

    // plain text (no ".") goes to the AI
    const text = message.startsWith(PREFIX) ? message : `${PREFIX}ai ${message}`;
    const out = [];
    const c = {
      platform: 'web',
      isOwner: false,
      settings: WEB_SETTINGS,
      save() {},
      userKey: `web:${req.ip}`,
      cooldownMs: 5000,
      latencyMs: null,
      history: getSession(sid).history,
      reply: async (t) => {
        out.push({ type: 'text', text: t });
      },
      sendImage: async (src, caption) => {
        const url = src.path ? '/api/menu-image' : src.url;
        if (url) out.push({ type: 'image', url, caption });
        else out.push({ type: 'text', text: caption });
      },
      sendAudio: async (src, o = {}) => {
        if (src.url) out.push({ type: 'audio', url: src.url, title: o.title || '', link: o.link || '' });
      },
    };

    try {
      const handled = await core.run(c, text);
      if (!handled) out.push({ type: 'text', text: `Sijaelewa amri hiyo. Andika ${PREFIX}menu kuona amri zote.` });
    } catch (e) {
      console.error('web chat error:', e.message);
      out.push({ type: 'text', text: 'Kuna hitilafu. Jaribu tena.' });
    }
    res.json({ ok: true, messages: out });
  });

  app.get('/api/menu-image', (req, res) => {
    if (fs.existsSync(core.MENU_PATH)) return res.sendFile(core.MENU_PATH);
    if (process.env.MENU_IMAGE) return res.redirect(process.env.MENU_IMAGE);
    res.status(404).end();
  });

  app.get('/api/audio', async (req, res) => {
    const id = String(req.query.id || '');
    if (!/^[\w-]{11}$/.test(id)) return res.status(400).json({ error: 'Invalid id' });
    if (allow(req.ip)) return res.status(429).json({ error: 'Maombi mengi sana.' });
    if (streams >= MAX_STREAMS) {
      return res.status(503).json({ error: 'Server ina shughuli. Jaribu tena baadaye.' });
    }

    streams += 1;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        streams -= 1;
      }
    };
    res.on('close', release);

    try {
      const p = await media.prepare(`https://www.youtube.com/watch?v=${id}`);
      if (Number(p.info.videoDetails.lengthSeconds) > 900) {
        return res.status(413).json({ error: 'Wimbo ni mrefu sana.' });
      }
      res.setHeader('Content-Type', 'audio/mp4');
      res.setHeader('Cache-Control', 'no-store');
      const stream = media.stream(p);
      stream.on('error', (e) => {
        console.error('audio stream error:', e.message);
        res.destroy();
      });
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch (e) {
      console.error('audio error:', e.message);
      if (!res.headersSent) res.status(502).json({ error: 'Imeshindwa kupakua audio.' });
      else res.destroy();
    }
  });
}

module.exports = { mount };
