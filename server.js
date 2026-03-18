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
  return phone.replace(/\D/g, '');
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

// ── Transcrição de áudio com OpenAI Whisper ──
async function transcribeAudio(mediaId) {
  if (!OPENAI_API_KEY) return null;
  try {
    const fetch = (await import('node-fetch')).default;
    // 1. Busca URL do áudio na Meta
    const mediaRes = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, {
      headers: { 'Authorization': `Bearer ${WA_TOKEN}` }
    });
    if (!mediaRes.ok) return null;
    const mediaData = await mediaRes.json();
    const audioUrl = mediaData.url;

    // 2. Baixa o áudio
    const audioRes = await fetch(audioUrl, {
      headers: { 'Authorization': `Bearer ${WA_TOKEN}` }
    });
    if (!audioRes.ok) return null;
    const audioBuffer = await audioRes.buffer();

    // 3. Transcreve com Whisper
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    form.append('file', audioBuffer, { filename: 'audio.ogg', contentType: 'audio/ogg' });
    form.append('model', 'whisper-1');
    form.append('language', 'pt');

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, ...form.getHeaders() },
      body: form
    });
    if (!whisperRes.ok) return null;
    const whisperData = await whisperRes.json();
    return whisperData.text || null;
  } catch(e) {
    console.error('Transcription error:', e.message);
    return null;
  }
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
Regras: seja cordial, responda em português, mantenha respostas curtas.
Se o cliente pedir humano/atendente, diga que vai transferir.`;

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

// ── Agendamento de mensagens ──
async function processScheduled() {
  if (!db) return;
  try {
    const now = Date.now();
    const snap = await db.ref('scheduled')
      .orderByChild('scheduledFor').endAt(now).once('value');
    if (!snap.exists()) return;

    const jobs = [];
    snap.forEach(c => {
      const job = c.val();
      if (!job.done) jobs.push({ id: c.key, ...job });
    });

    for (const job of jobs) {
      console.log(`Enviando mensagem agendada para ${job.phone}`);
      await sendWhatsApp(job.phone.replace(/\D/g, ''), job.msg);
      // Salva no histórico
      if (job.convId) {
        await db.ref(`messages/${job.convId}`).push({
          dir: 'out', text: job.msg, ts: Date.now(), type: 'text',
          byName: job.createdByName || 'Agendamento', scheduled: true
        });
        await db.ref(`conversations/${job.convId}`).update({
          lastMsg: job.msg, lastDir: 'out', updatedAt: Date.now()
        });
      }
      // Marca como enviado
      await db.ref(`scheduled/${job.id}`).update({ done: true, sentAt: Date.now() });
    }
  } catch(e) {
    console.error('Schedule error:', e.message);
  }
}

// Verifica agendamentos a cada minuto
setInterval(processScheduled, 60000);
processScheduled(); // Roda na inicialização

app.get('/', (req, res) => res.send('Webhook rodando! IA + Agendamento + Transcrição ativos.'));

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

      // Transcrição de áudio
      let text = '';
      let transcription = null;
      if (msg.type === 'audio' && msg.audio?.id && OPENAI_API_KEY) {
        console.log('Transcrevendo áudio...');
        transcription = await transcribeAudio(msg.audio.id);
        text = transcription ? `🎵 [Áudio transcrito]: ${transcription}` : '[Áudio recebido]';
        console.log('Transcrição:', transcription);
      } else {
        text = msg.type === 'text'     ? msg.text?.body
             : msg.type === 'image'    ? '[Imagem recebida]'
             : msg.type === 'video'    ? '[Vídeo recebido]'
             : msg.type === 'document' ? '[Documento recebido]'
             : `[${msg.type}]`;
      }

      const found = await findConversation(phone);
      let convId;

      if (found) {
        convId = found.convId;
        await db.ref(`conversations/${convId}`).update({
          lastMsg: text, lastDir: 'in', updatedAt: ts,
          unread: admin.database.ServerValue.increment(1)
        });
        console.log(`Mensagem na conversa: ${convId}`);
      } else {
        const ref = db.ref('conversations').push();
        convId = ref.key;
        await ref.set({ name, phone, status: 'open', unread: 1, agentUid: null, agentName: null, aiActive: true, updatedAt: ts, lastMsg: text, lastDir: 'in' });
        console.log(`Nova conversa: ${convId}`);
      }

      await db.ref(`messages/${convId}`).push({
        dir: 'in', text, ts, type: msg.type,
        ...(transcription ? { transcription } : {})
      });

      // IA só processa texto ou áudio transcrito
      const aiText = msg.type === 'text' ? msg.text?.body : transcription;
      if (!aiText) continue;

      const convSnap = await db.ref(`conversations/${convId}`).once('value');
      const convData = convSnap.val() || {};
      const aiActive = convData.aiActive !== false;

      if (wantsHuman(aiText)) {
        await db.ref(`conversations/${convId}`).update({ aiActive: false });
        const transferMsg = 'Entendido! Estou te transferindo para um de nossos atendentes. Aguarde um momento. 👋';
        await sendWhatsApp(phone, transferMsg);
        await db.ref(`messages/${convId}`).push({ dir: 'out', text: transferMsg, ts: Date.now(), type: 'text', byAI: true, byName: '🤖 Agente IA' });
        await db.ref(`conversations/${convId}`).update({ lastMsg: transferMsg, lastDir: 'out', updatedAt: Date.now(), aiActive: false });
        continue;
      }

      if (!aiActive) continue;

      const aiEnabledSnap = await db.ref('aiConfig/enabled').once('value');
      if (aiEnabledSnap.val() === false) continue;

      console.log(`Chamando IA para: ${aiText}`);
      const aiReply = await callAI(convId, aiText);

      if (aiReply) {
        await sendWhatsApp(phone, aiReply);
        await db.ref(`messages/${convId}`).push({ dir: 'out', text: aiReply, ts: Date.now(), type: 'text', byAI: true, byName: '🤖 Agente IA' });
        await db.ref(`conversations/${convId}`).update({ lastMsg: aiReply, lastDir: 'out', updatedAt: Date.now() });
        console.log('IA respondeu com sucesso');
      }
    }
  } catch(e) { console.error('Erro:', e.message); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Servidor iniciado na porta ${PORT}`));
