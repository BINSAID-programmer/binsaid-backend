// Music search + audio download (YouTube). Used by WhatsApp (buffer) and web (stream).
const yts = require('yt-search');
const ytdl = require('@distube/ytdl-core');
const { bufferFromStream } = require('./util');

async function search(q) {
  const r = await yts(q);
  return r.videos[0] || null;
}

async function prepare(urlOrId) {
  const info = await ytdl.getInfo(urlOrId);
  let format;
  try {
    format = ytdl.chooseFormat(info.formats, {
      filter: (f) => f.hasAudio && !f.hasVideo && (f.mimeType || '').includes('audio/mp4'),
    });
  } catch (e) {
    format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
  }
  return { info, format };
}

function stream(p) {
  return ytdl.downloadFromInfo(p.info, { format: p.format });
}

async function toBuffer(url, max) {
  return bufferFromStream(stream(await prepare(url)), max);
}

module.exports = { search, prepare, stream, toBuffer };
