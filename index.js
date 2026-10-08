const express = require('express');
const cors = require('cors');
const pino = require('pino');
const fs = require('fs');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  delay,
} = require('@whiskeysockets/baileys');

const app = express();
app.use(cors());

app.get('/', (req, res) => res.send('BIN-SAID-MD backend is running'));

app.get('/pair', async (req, res) => {
  const phone = (req.query.phone || '').replace(/[^0-9]/g, '');
  if (!phone || phone.length < 10) {
    return res.status(400).json({ error: 'Invalid phone number' });
  }

  const dir = `./sessions/${phone}`;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(dir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', ({ connection }) => {
      if (connection === 'open') console.log('Linked:', phone);
    });

    if (!sock.authState.creds.registered) {
      await delay(3000);
      const code = await sock.requestPairingCode(phone);
      return res.json({ code: code?.match(/.{1,4}/g)?.join('-') || code });
    }
    res.json({ error: 'Already registered' });
  } catch (e) {
    console.error(e);
    fs.rmSync(dir, { recursive: true, force: true });
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate code' });
  }
});

process.on('uncaughtException', (e) => console.error('uncaught:', e));
process.on('unhandledRejection', (e) => console.error('unhandled:', e));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Listening on', PORT));
