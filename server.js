const express = require('express');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ── Firebase ──
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_KEY || '{}');
  if (serviceAccount.project_id) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DB_URL
    });
    console.log('Firebase conectado!');
  }
} catch(e) {
  console.log('Firebase não configurado:', e.message);
}

const db = admin.apps.length ? admin.database() : null;

const VERIFY_TOKEN   = process.env.VERIFY_TOKEN || '';
const WA_TOKEN       = process.env.WHATSAPP_ACCESS_TOKEN || '';
const WA_PHONE_ID    = process.env.WHATSAPP_PHONE_ID || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

function normalizePhone(phone) {
  const clean = phone.replace(/\D/g, '');
  return clean;
}

async function findConversation(phone) {
  const variants = new Set();
  const clean = normalizePhone(phone);
  variants.add(clean);
  variants.add('+' + clean);
  if (clean.startsWith('55') && clean.length === 12) {
    const with9 = clean.slice(0, 4) + '9' + clean.slice(4);
    variants.add(with9); variants.add('+' + with9);
  }
  if (clean.startsWith('55') && clean.length === 13) {
    const without9 = clean.slice(0, 4) + clean.slice(5);
    variants.add(without9); variants.add('+' + without9);
  }
  for (const v of variants) {
    const snap = await db.ref('conversations')
      .orderByChild('phone').equalTo(v).limitToFirst(1).get();
    if (snap.exists()) {
      const convId = Object.keys(snap.val())[0];
      return { snap, convId, conv: snap.val()[convId] };
    }
  }
  return null;
}

async function sendWhatsApp(to, text) {
  try {
    const fetch = (await import('node-fetch')).default;
    const res = await fetch(`https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', recipient_type: 'individual',
        to, type: 'text', text: { body: text }
      })
    });
    if (!res.ok) { const err = await res.json(); console.error('WA error:', err?.error?.message); }
  } catch(e) { console.error('WA exception:', e.message); }
}

async function getConvHistory(convId, limit = 10) {
  const snap = await db.ref(`messages/${convId}`).orderByChild('ts').limitToLast(limit).once('value');
  const msgs = [];
  snap.forEach(c => { const m = c.val(); if (m.type !== 'note') msgs.push(m); });
  return msgs;
}

async function callAI(convId, userMessage) {
  if (!OPENAI_API_KEY) return null;
  try {
    const cfgSnap = await db.ref('aiConfig').once('value');
    const cfg = cfgSnap.exists() ? cfgSnap.val() : {};

    const systemPrompt = cfg.prompt ||
      `Você é um assistente de atendimento chamado ${cfg.name || 'Assistente'}.
Empresa: ${cfg.company || 'Nossa empresa'}.
${cfg.description || 'Responda de forma educada e objetiva em português brasileiro.'}
Regras:
- Seja sempre cordial e profissional
- Responda em português brasileiro
- Mantenha respostas curtas (máximo 3 parágrafos)
- Se não souber, diga que vai verificar e transferir para atendente
- Se o cliente pedir humano/atendente, diga que vai transferir`;

    const history = await getConvHistory(convId, 8);
    const messages = [{ role: 'system', content: systemPrompt }];
    history.forEach(m => {
      if (m.dir === 'in') messages.push({ role: 'user', content: m.text || '' });
      if (m.dir === 'out' && !m.byUid) messages.push({ role: 'assistant', content: m.text || '' });
    });
    messages.push({ role: 'user', content: userMessage });

    const fetch = (await import('node-fetch')).default;
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.model || 'gpt-4o-mini', messages, max_tokens: 500, temperature: 0.7 })
    });
    if (!res.ok) { const err = await res.json(); console.error('OpenAI error:', err?.error?.message); return null; }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch(e) { console.error('AI error:', e.message); return null; }
}

function wantsHuman(text) {
  const t = (text || '').toLowerCase();
  return t.includes('humano') || t.includes('atendente') || t.includes('pessoa real') ||
         t.includes('falar com') || t.includes('quero falar') || t.includes('me transfer');
}

app.get('/', (req, res) => res.send('Webhook rodando! Agente IA ativo.'));

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'], token = req.query['hub.verify_token'], challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) { console.log('Webhook verificado!'); res.status(200).send(challenge); }
  else res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
    if (!entry?.messages || !db) return;

    for (const msg of entry.messages) {
      const phone = normalizePhone(msg.from);
      const name  = entry.contacts?.[0]?.profile?.name || phone;
      const ts    = parseInt(msg.timestamp) * 1000;
      const text  = msg.type === 'text' ? msg.text?.body
                  : msg.type === 'image' ? '[Imagem recebida]'
                  : msg.type === 'audio' ? '[Áudio recebido]'
                  : msg.type === 'video' ? '[Vídeo recebido]'
                  : msg.type === 'document' ? '[Documento recebido]'
                  : `[${msg.type}]`;

      const found = await findConversation(phone);
      let convId;

      if (found) {
        convId = found.convId;
        await db.ref(`conversations/${convId}`).update({ lastMsg: text, lastDir: 'in', updatedAt: ts, unread: admin.database.ServerValue.increment(1) });
        console.log(`Mensagem na conversa: ${convId}`);
      } else {
        const ref = db.ref('conversations').push();
        convId = ref.key;
        await ref.set({ name, phone, status: 'open', unread: 1, agentUid: null, agentName: null, aiActive: true, updatedAt: ts, lastMsg: text, lastDir: 'in' });
        console.log(`Nova conversa: ${convId} para ${phone}`);
      }

      await db.ref(`messages/${convId}`).push({ dir: 'in', text, ts, type: msg.type });

      if (msg.type !== 'text') continue;

      // Checa estado da conversa
      const convSnap = await db.ref(`conversations/${convId}`).once('value');
      const convData = convSnap.val() || {};
      const aiActive = convData.aiActive !== false;

      // Cliente pediu humano
      if (wantsHuman(text)) {
        await db.ref(`conversations/${convId}`).update({ aiActive: false });
        const transferMsg = 'Entendido! Estou te transferindo para um de nossos atendentes. Aguarde um momento. 👋';
        await sendWhatsApp(phone, transferMsg);
        await db.ref(`messages/${convId}`).push({ dir: 'out', text: transferMsg, ts: Date.now(), type: 'text', byAI: true, byName: '🤖 Agente IA' });
        await db.ref(`conversations/${convId}`).update({ lastMsg: transferMsg, lastDir: 'out', updatedAt: Date.now(), aiActive: false });
        console.log(`IA desativada — cliente pediu humano: ${convId}`);
        continue;
      }

      if (!aiActive) { console.log(`IA desativada para ${convId}`); continue; }

      const aiEnabledSnap = await db.ref('aiConfig/enabled').once('value');
      if (aiEnabledSnap.val() === false) { console.log('IA desabilitada globalmente'); continue; }

      console.log(`Chamando IA para: ${text}`);
      const aiReply = await callAI(convId, text);

      if (aiReply) {
        await sendWhatsApp(phone, aiReply);
        await db.ref(`messages/${convId}`).push({ dir: 'out', text: aiReply, ts: Date.now(), type: 'text', byAI: true, byName: '🤖 Agente IA' });
        await db.ref(`conversations/${convId}`).update({ lastMsg: aiReply, lastDir: 'out', updatedAt: Date.now() });
        console.log(`IA respondeu com sucesso`);
      }
    }
  } catch(e) { console.error('Erro:', e.message); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Servidor iniciado na porta ${PORT}`));
