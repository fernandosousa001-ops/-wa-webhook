const express = require('express');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

// Porta — o Render define a variável PORT automaticamente
const PORT = process.env.PORT || 3000;

// Firebase
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_KEY || '{}');
  if (serviceAccount.project_id) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DB_URL
    });
  }
} catch(e) {
  console.log('Firebase não configurado:', e.message);
}

const db = admin.apps.length ? admin.database() : null;

// Rota raiz
app.get('/', (req, res) => {
  res.send('Webhook rodando!');
});

// GET — verificação da Meta
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  console.log('Verificação recebida. Token:', token);
  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('Webhook verificado com sucesso!');
    res.status(200).send(challenge);
  } else {
    console.log('Token inválido. Esperado:', process.env.VERIFY_TOKEN);
    res.sendStatus(403);
  }
});

// POST — recebe mensagens do WhatsApp
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
    if (!entry?.messages || !db) return;
    for (const msg of entry.messages) {
      const phone = msg.from.replace(/\D/g,'');
      const name  = entry.contacts?.[0]?.profile?.name || phone;
      const text  = msg.type === 'text' ? msg.text.body : `[${msg.type}]`;
      const ts    = parseInt(msg.timestamp) * 1000;
      let snap = await db.ref('conversations')
  .orderByChild('phone').equalTo(phone).limitToFirst(1).get();
if(!snap.exists()){
  snap = await db.ref('conversations')
    .orderByChild('phone').equalTo('+'+phone).limitToFirst(1).get();
}
      let convId;
      if (snap.exists()) {
        convId = Object.keys(snap.val())[0];
        await db.ref(`conversations/${convId}`).update({
          lastMsg: text, lastDir: 'in', updatedAt: ts,
          unread: admin.database.ServerValue.increment(1)
        });
      } else {
        const ref = db.ref('conversations').push();
        convId = ref.key;
        await ref.set({
          name, phone, status: 'open', unread: 1,
          agentUid: null, agentName: null,
          updatedAt: ts, lastMsg: text, lastDir: 'in'
        });
      }
      await db.ref(`messages/${convId}`).push(
        { dir: 'in', text, ts, type: msg.type });
    }
  } catch(e) {
    console.error('Erro ao processar mensagem:', e.message);
  }
});

// INICIA O SERVIDOR — precisa do host 0.0.0.0 para o Render detectar
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor iniciado na porta ${PORT}`);
});