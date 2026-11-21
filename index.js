// Server entry. One server, two doors: WhatsApp and the web chat.
// Both use the same commands from ./core.

// The Signal library prints huge session dumps with console.info/console.warn.
// That floods the logs and slows the small free server, so silence only those two.
console.info = () => {};
console.warn = () => {};

const express = require('express');
const cors = require('cors');
const core = require('./core/commands');
const whatsapp = require('./adapters/whatsapp');
const web = require('./adapters/web');

const app = express();
app.set('trust proxy', 1); // Render sits behind one proxy; needed for the real client IP

// Optional: ALLOWED_ORIGINS=https://binsaid-web.vercel.app (comma separated). Empty = allow all.
const origins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(cors(origins.length ? { origin: origins } : undefined));
app.use(express.json({ limit: '10kb' }));

app.get('/', (req, res) => res.send(`${core.BOT_NAME} backend is running`));

whatsapp.mount(app);
web.mount(app);

// bad JSON etc.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(400).json({ error: 'Ombi si sahihi.' });
});

process.on('uncaughtException', (e) => console.error('uncaught:', e));
process.on('unhandledRejection', (e) => console.error('unhandled:', e));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('Listening on', PORT);
  whatsapp.restoreSessions();
});
