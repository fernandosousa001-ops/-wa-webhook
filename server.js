const express = require('express');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Firebase init
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

// Normaliza número: remove +, espaços, traços
// Tenta com e sem o nono dígito (Brasil)
function normalizePhone(phone) {
  return phone.replace(/\D/g, '');
}

// Busca conversa pelo número — tenta várias variações
async function findConversation(phone) {
  const variants = new Set();
  const clean = normalizePhone(phone);
  variants.add(clean);
  variants.add('+' + clean);

  // Brasil: tenta com e sem nono dígito
  // Ex: 558699702590 (8 dig) <-> 5586999702590 (9 dig)
  if (clean.startsWith('55') && clean.length === 12) {
    // tem 8 dígitos no número — adiciona versão com 9
    const with9 = clean.slice(0, 4) + '9' + clean.slice(4);
    variants.add(with9);
    variants.add('+' + with9);
  }
  if (clean.startsWith('55') && clean.length === 13) {
    // tem 9 dígitos — adiciona versão sem 9
    const without9 = clean.slice(0, 4) + clean.slice(5);
    variants.add(without9);
    variants.add('+' + without9);
  }

  for (const v of variants) {
    const snap = await db.ref('conversations')
      .orderByChild('phone').equalTo(v).limitToFirst(1).get();
    if (snap.exists()) return { snap, convId: Object.keys(snap.val())[0] };
  }
  return null;
}

// Rota raiz
app.get('/', (req, res) => res.send('Webhook rodando!'));

// GET — verificação Meta
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('Webhook verificado!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// POST — recebe mensagens
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
    if (!entry?.messages || !db) return;

    for (const msg of entry.messages) {
      const phone   = normalizePhone(msg.from);
      const name    = entry.contacts?.[0]?.profile?.name || phone;
      const ts      = parseInt(msg.timestamp) * 1000;
      const text    = msg.type === 'text' ? msg.text?.body
                    : msg.type === 'image' ? '[Imagem recebida]'
                    : msg.type === 'audio' ? '[Áudio recebido]'
                    : msg.type === 'video' ? '[Vídeo recebido]'
                    : msg.type === 'document' ? '[Documento recebido]'
                    : `[${msg.type}]`;

      // Busca conversa existente (com variações de número)
      const found = await findConversation(phone);
      let convId;

      if (found) {
        convId = found.convId;
        await db.ref(`conversations/${convId}`).update({
          lastMsg: text,
          lastDir: 'in',
          updatedAt: ts,
          unread: admin.database.ServerValue.increment(1)
        });
        console.log(`Mensagem adicionada à conversa existente: ${convId}`);
      } else {
        // Cria nova conversa
        const ref = db.ref('conversations').push();
        convId = ref.key;
        await ref.set({
          name, phone,
          status: 'open', unread: 1,
          agentUid: null, agentName: null,
          updatedAt: ts, lastMsg: text, lastDir: 'in'
        });
        console.log(`Nova conversa criada: ${convId} para ${phone}`);
      }

      // Salva mensagem
      await db.ref(`messages/${convId}`).push({
        dir: 'in', text, ts, type: msg.type
      });
    }
  } catch(e) {
    console.error('Erro ao processar mensagem:', e.message);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor iniciado na porta ${PORT}`);
});
