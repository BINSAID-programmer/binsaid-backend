const express = require('express');
const cors = require('cors');
const pino = require('pino');
const fs = require('fs');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  DisconnectReason,
  delay,
} = require('@whiskeysockets/baileys');

const app = express();
app.use(cors());

const active = new Map();

app.get('/', (req, res) => res.send('BIN-SAID-MD backend is running'));

async function startSock(phone, res) {
  const dir = `./sessions/${phone}`;
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    syncFullHistory: false,
  });
  active.set(phone, sock);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      console.log('Linked:', phone);
      try {
        await sock.sendMessage(sock.user.id, { text: 'BIN-SAID-MD imeunganishwa kikamilifu.' });
      } catch (e) {}
    }
    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode;
      console.log('Closed:', status);
      if (status === DisconnectReason.loggedOut) {
        active.delete(phone);
        fs.rmSync(dir, { recursive: true, force: true });
      } else {
        // 515 restartRequired and other drops: reconnect with saved creds
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
    if (old) { try { old.end(); } catch (e) {} active.delete(phone); }
    fs.rmSync(`./sessions/${phone}`, { recursive: true, force: true });
    await startSock(phone, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate code' });
  }
});

process.on('uncaughtException', (e) => console.error('uncaught:', e));
process.on('unhandledRejection', (e) => console.error('unhandled:', e));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Listening on', PORT));
