// Small helpers shared by every platform (WhatsApp, web, ...).

const cooldowns = new Map();

// true when `key` used something less than `ms` ago (and records this use otherwise)
function onCooldown(key, ms) {
  const now = Date.now();
  if (now - (cooldowns.get(key) || 0) < ms) return true;
  cooldowns.set(key, now);
  if (cooldowns.size > 5000) {
    for (const [k, t] of cooldowns) if (now - t > 60000) cooldowns.delete(k);
  }
  return false;
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

module.exports = { onCooldown, fmtUptime, postJSON, bufferFromStream };
