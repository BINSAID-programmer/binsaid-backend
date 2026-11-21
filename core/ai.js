// AI providers. Keys come from environment variables (set them on Render).
const { postJSON } = require('./util');

const SYSTEM =
  process.env.AI_SYSTEM_PROMPT ||
  'You are BIN_SAID, a helpful assistant created by Binsaid. Reply in the same language the user writes in (Kiswahili or English). Be clear and concise.';

const openAiStyle = {
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

const providers = ['gemini', 'chatgpt', 'meta'];

function available(p) {
  if (p === 'gemini') return !!process.env.GEMINI_API_KEY;
  return !!openAiStyle[p]?.key();
}

function firstAvailable() {
  return providers.find(available) || null;
}

// history: earlier turns as [{ role: 'user' | 'assistant', content }]
async function ask(provider, prompt, history = []) {
  if (!available(provider)) throw new Error('NO_KEY');
  const turns = [...history.slice(-10), { role: 'user', content: prompt }];
  let out = '';

  if (provider === 'gemini') {
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const j = await postJSON(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: turns.map((t) => ({
          role: t.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: t.content }],
        })),
      },
      { 'x-goog-api-key': process.env.GEMINI_API_KEY }
    );
    out = j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  } else {
    const c = openAiStyle[provider];
    const j = await postJSON(
      c.url,
      { model: c.model(), messages: [{ role: 'system', content: SYSTEM }, ...turns] },
      { Authorization: `Bearer ${c.key()}` }
    );
    out = j.choices?.[0]?.message?.content || '';
  }
  return (out || 'Hakuna jibu.').slice(0, 3500);
}

module.exports = { providers, available, firstAvailable, ask };
