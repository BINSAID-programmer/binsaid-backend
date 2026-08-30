const express = require('express');
const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/pair', async (req, res) => {
    const phoneNumber = req.query.phone;
    if (!phoneNumber) {
        return res.json({ error: "Namba ya simu inahitajika!" });
    }

    const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${phoneNumber}`);
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false
    });

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(phoneNumber);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                res.json({ code: code });
            } catch (err) {
                res.json({ error: "Imeshindikana kutengeneza code. Jaribu tena." });
            }
        }, 3000);
    } else {
        res.json({ error: "Namba hii tayari imeshaunganishwa!" });
    }

    sock.ev.on('creds.update', saveCreds);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
