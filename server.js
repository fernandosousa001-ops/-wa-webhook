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
  console.log('Firebase erro:', e.message);
}

const db = admin.apps.length ? admin.database() : null;

const VERIFY_TOKEN   = process.env.VERIFY_TOKEN || '';
const WA_TOKEN       = process.env.WHATSAPP_ACCESS_TOKEN || '';
const WA_PHONE_ID    = process.env.WHATSAPP_PHONE_ID || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

// ── Utilitários ──
function normalizePhone(phone) {
  return phone.replace(/\D/g, '');
}

async function findConversation(phone) {
  const clean = normalizePhone(phone);
  const variants = new Set([clean, '+' + clean]);
  if (clean.startsWith('55') && clean.length === 12) {
    const w9 = clean.slice(0, 4) + '9' + clean.slice(4);
    variants.add(w9); variants.add('+' + w9);
  }
  if (clean.startsWith('55') && clean.length === 13) {
    const wo9 = clean.slice(0, 4) + clean.slice(5);
    variants.add(wo9); variants.add('+' + wo9);
  }
  for (const v of variants) {
    const snap = await db.ref('conversations').orderByChild('phone').equalTo(v).limitToFirst(1).get();
    if (snap.exists()) {
      const convId = Object.keys(snap.val())[0];
      return { convId, conv: snap.val()[convId] };
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
    if (!res.ok) { const e = await res.json(); console.error('WA error:', e?.error?.message); }
    else console.log('WA enviado para:', to);
  } catch(e) { console.error('WA exception:', e.message); }
}

async function saveMessage(convId, msg) {
  await db.ref(`messages/${convId}`).push(msg);
}

async function updateConv(convId, data) {
  await db.ref(`conversations/${convId}`).update(data);
}

// ── CHATBOT COM MENU ──
const MENU_PRINCIPAL = `Olá! Seja bem-vindo à *Fernando Sousa Fotografia* 📸

Digite o número da opção desejada:

1️⃣ Orçamentos e pacotes
2️⃣ Agendar sessão
3️⃣ Ver portfólio
4️⃣ Falar com atendente

_Responda com o número da opção._`;

const MENU_ORCAMENTO = `💰 *Nossos pacotes:*

📸 *Ensaio Individual* — a partir de R$ 350
- 1h de sessão
- 30 fotos editadas

💑 *Ensaio de Casal* — a partir de R$ 450
- 1h30 de sessão
- 40 fotos editadas

🎉 *Aniversário / 15 anos* — a partir de R$ 600
- 2h de sessão
- 50 fotos + álbum digital

💍 *Casamento* — a partir de R$ 1.500
- Cobertura completa
- 100+ fotos editadas

Para orçamento personalizado, responda *0* para falar com um atendente.`;

const MENU_AGENDAMENTO = `📅 *Agendamento de sessão*

Para marcar sua sessão, preciso de algumas informações:

1. Qual tipo de sessão? (ensaio, aniversário, casamento...)
2. Data preferida
3. Horário de preferência (manhã, tarde ou noite)
4. Local (Teresina ou outra cidade?)

Responda com essas informações e confirmaremos em breve! 😊`;

const MENU_PORTFOLIO = `📷 *Portfólio Fernando Sousa*

Confira nosso trabalho:

📱 *Instagram:* @fernando_sousa_fotografo
🌐 *Site:* https://fernandosousa001-ops.github.io/portfolio-fernando-sousa.html

Lá você encontra ensaios, casamentos, formaturas e muito mais! ✨

Digite *0* para voltar ao menu ou falar com atendente.`;

function wantsHuman(text) {
  const t = (text || '').toLowerCase().trim();
  return t === '4' || t === '0' ||
    t.includes('atendente') || t.includes('humano') ||
    t.includes('pessoa') || t.includes('falar com');
}

function isMenuCommand(text) {
  const t = (text || '').toLowerCase().trim();
  return ['menu', 'oi', 'olá', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'início', 'inicio', 'começar', 'comecar', 'start', 'hi', 'hello'].includes(t);
}

async function handleChatbot(convId, conv, phone, text) {
  const t = (text || '').trim();
  const state = conv.chatbotState || 'idle';

  // Verifica se chatbot está ativo
  const cfgSnap = await db.ref('chatbotConfig/enabled').once('value');
  const chatbotEnabled = cfgSnap.val() !== false;
  if (!chatbotEnabled) return false;

  // Se agente humano assumiu, não interfere
  if (conv.aiActive === false) return false;

  // Pede atendente humano
  if (wantsHuman(t)) {
    await sendWhatsApp(phone, 'Entendido! Estou te transferindo para um de nossos atendentes. Aguarde um momento. 👋');
    await saveMessage(convId, { dir: 'out', text: 'Entendido! Estou te transferindo para um de nossos atendentes. Aguarde um momento. 👋', ts: Date.now(), type: 'text', byName: '🤖 Chatbot' });
    await updateConv(convId, { aiActive: false, chatbotState: 'idle', lastMsg: 'Transferindo para atendente...', lastDir: 'out', updatedAt: Date.now() });
    return true;
  }

  // Comando para voltar ao menu
  if (isMenuCommand(t) || state === 'idle') {
    await sendWhatsApp(phone, MENU_PRINCIPAL);
    await saveMessage(convId, { dir: 'out', text: MENU_PRINCIPAL, ts: Date.now(), type: 'text', byName: '🤖 Chatbot' });
    await updateConv(convId, { chatbotState: 'menu', lastMsg: '[Menu principal]', lastDir: 'out', updatedAt: Date.now() });
    return true;
  }

  // Navegação no menu
  if (state === 'menu') {
    if (t === '1') {
      await sendWhatsApp(phone, MENU_ORCAMENTO);
      await saveMessage(convId, { dir: 'out', text: MENU_ORCAMENTO, ts: Date.now(), type: 'text', byName: '🤖 Chatbot' });
      await updateConv(convId, { chatbotState: 'orcamento', lastMsg: '[Orçamentos]', lastDir: 'out', updatedAt: Date.now() });
      return true;
    }
    if (t === '2') {
      await sendWhatsApp(phone, MENU_AGENDAMENTO);
      await saveMessage(convId, { dir: 'out', text: MENU_AGENDAMENTO, ts: Date.now(), type: 'text', byName: '🤖 Chatbot' });
      await updateConv(convId, { chatbotState: 'agendamento', lastMsg: '[Agendamento]', lastDir: 'out', updatedAt: Date.now() });
      return true;
    }
    if (t === '3') {
      await sendWhatsApp(phone, MENU_PORTFOLIO);
      await saveMessage(convId, { dir: 'out', text: MENU_PORTFOLIO, ts: Date.now(), type: 'text', byName: '🤖 Chatbot' });
      await updateConv(convId, { chatbotState: 'portfolio', lastMsg: '[Portfólio]', lastDir: 'out', updatedAt: Date.now() });
      return true;
    }
    // Opção inválida
    const invalid = 'Opção inválida. Por favor, digite 1, 2, 3 ou 4.';
    await sendWhatsApp(phone, invalid);
    await saveMessage(convId, { dir: 'out', text: invalid, ts: Date.now(), type: 'text', byName: '🤖 Chatbot' });
    return true;
  }

  // Estado de agendamento — coleta informações
  if (state === 'agendamento') {
    const confirm = `✅ Ótimo! Recebi suas informações:\n\n"${t}"\n\nVou verificar a disponibilidade e entrar em contato em breve para confirmar! 📅\n\nDigite *menu* para voltar ao início.`;
    await sendWhatsApp(phone, confirm);
    await saveMessage(convId, { dir: 'out', text: confirm, ts: Date.now(), type: 'text', byName: '🤖 Chatbot' });
    await updateConv(convId, { chatbotState: 'aguardando', lastMsg: '[Agendamento recebido]', lastDir: 'out', updatedAt: Date.now(), unread: admin.database.ServerValue.increment(1) });
    return true;
  }

  // Outros estados — volta ao menu se não entender
  if (state === 'orcamento' || state === 'portfolio' || state === 'aguardando') {
    // Passa para IA ou atendente
    return false;
  }

  return false;
}

// ── IA ──
async function getConvHistory(convId, limit = 8) {
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

    const history = await getConvHistory(convId);
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
    if (!res.ok) { const e = await res.json(); console.error('OpenAI error:', e?.error?.message); return null; }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch(e) { console.error('AI error:', e.message); return null; }
}

// ── Agendamento ──
async function processScheduled() {
  if (!db) return;
  try {
    const now = Date.now();
    const snap = await db.ref('scheduled').orderByChild('scheduledFor').endAt(now).once('value');
    if (!snap.exists()) return;
    const jobs = [];
    snap.forEach(c => { const j = c.val(); if (!j.done) jobs.push({ id: c.key, ...j }); });
    for (const job of jobs) {
      console.log('Enviando agendado para:', job.phone);
      await sendWhatsApp(job.phone.replace(/\D/g, ''), job.msg);
      if (job.convId) {
        await saveMessage(job.convId, { dir: 'out', text: job.msg, ts: Date.now(), type: 'text', byName: job.createdByName || 'Agendamento', scheduled: true });
        await updateConv(job.convId, { lastMsg: job.msg, lastDir: 'out', updatedAt: Date.now() });
      }
      await db.ref(`scheduled/${job.id}`).update({ done: true, sentAt: Date.now() });
    }
  } catch(e) { console.error('Schedule error:', e.message); }
}

setInterval(processScheduled, 60000);

// ── Rotas ──
app.get('/', (req, res) => res.send('WA Business Team — Webhook ativo!'));

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    console.log('Webhook verificado!');
    res.status(200).send(req.query['hub.challenge']);
  } else res.sendStatus(403);
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
      // Resolve media URL from Meta if needed
      let text = msg.type === 'text' ? msg.text?.body : null;
      let mediaUrl = null;
      let fileName = null;

      if (msg.type === 'image' || msg.type === 'document' || msg.type === 'video' || msg.type === 'audio') {
        const mediaId = msg[msg.type]?.id;
        fileName = msg.document?.filename || null;

        if (mediaId && (msg.type === 'image' || msg.type === 'document')) {
          try {
            const fetch2 = (await import('node-fetch')).default;
            // Step 1: Get media URL from Meta
            const metaRes = await fetch2(`https://graph.facebook.com/v19.0/${mediaId}`, {
              headers: { 'Authorization': `Bearer ${WA_TOKEN}` }
            });
            if (metaRes.ok) {
              const metaData = await metaRes.json();
              const tempUrl = metaData.url;
              const mimeType = metaData.mime_type || (msg.type === 'image' ? 'image/jpeg' : 'application/octet-stream');

              // Step 2: Download the actual file
              const fileRes = await fetch2(tempUrl, {
                headers: { 'Authorization': `Bearer ${WA_TOKEN}` }
              });
              if (fileRes.ok) {
                const buffer = await fileRes.buffer();
                const base64 = buffer.toString('base64');
                mediaUrl = `data:${mimeType};base64,${base64}`;
                console.log(`Media downloaded: ${msg.type} ${buffer.length} bytes`);
              }
            }
          } catch(e) { console.error('Media download error:', e.message); }
        }

        if (msg.type === 'image') text = '[Imagem recebida]';
        else if (msg.type === 'document') text = '[Documento: ' + (fileName || 'arquivo') + ']';
        else if (msg.type === 'video') text = '[Vídeo recebido]';
        else if (msg.type === 'audio') text = '[Áudio recebido]';
      }

      if (!text) text = `[${msg.type}]`;

      // Busca ou cria conversa
      const found = await findConversation(phone);
      let convId, conv;
      if (found) {
        convId = found.convId; conv = found.conv;
        await updateConv(convId, { lastMsg: text, lastDir: 'in', updatedAt: ts, unread: admin.database.ServerValue.increment(1) });
        console.log('Mensagem na conversa:', convId);
      } else {
        const ref = db.ref('conversations').push();
        convId = ref.key;
        conv = { name, phone, status: 'open', unread: 1, agentUid: null, agentName: null, aiActive: true, chatbotState: 'idle', updatedAt: ts, lastMsg: text, lastDir: 'in' };
        await ref.set(conv);
        console.log('Nova conversa:', convId);
      }

      // Salva mensagem com mídia se houver
      const msgData = { dir: 'in', text, ts, type: msg.type };
      if (mediaUrl) {
        msgData.mediaUrl = mediaUrl;
        msgData.mediaType = msg.type;
        if (fileName) msgData.fileName = fileName;
      }
      await saveMessage(convId, msgData);

      if (msg.type !== 'text') continue;

      // Recarrega conv atualizada
      const convSnap = await db.ref(`conversations/${convId}`).once('value');
      const convData = convSnap.val() || {};

      // 1. Tenta chatbot primeiro
      const chatbotHandled = await handleChatbot(convId, convData, phone, msg.text?.body || '');
      if (chatbotHandled) continue;

      // 2. Se chatbot não tratou e IA está ativa, chama IA
      if (convData.aiActive === false) { console.log('Agente humano no controle:', convId); continue; }

      const aiEnabledSnap = await db.ref('aiConfig/enabled').once('value');
      if (aiEnabledSnap.val() === false) continue;

      console.log('Chamando IA para:', msg.text?.body);
      const aiReply = await callAI(convId, msg.text?.body || '');
      if (aiReply) {
        await sendWhatsApp(phone, aiReply);
        await saveMessage(convId, { dir: 'out', text: aiReply, ts: Date.now(), type: 'text', byAI: true, byName: '🤖 Agente IA' });
        await updateConv(convId, { lastMsg: aiReply, lastDir: 'out', updatedAt: Date.now() });
        console.log('IA respondeu com sucesso');
      }
    }
  } catch(e) { console.error('Erro webhook:', e.message); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Servidor na porta ${PORT}`));
