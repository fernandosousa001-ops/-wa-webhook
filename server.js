// Webhook WhatsApp Business → Firebase
const express = require('express');
const admin = require('firebase-admin');
const app = express();
app.use(express.json());
// Firebase — usa a variável de ambiente FIREBASE_KEY
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL
});
const db = admin.database();
// GET — verificação do webhook pela Meta
app.get('/webhook', (req, res) => {
  const token = req.query['hub.verify_token'];
  if (token === process.env.VERIFY_TOKEN)
    res.send(req.query['hub.challenge']);
  else res.sendStatus(403);
});
// POST — recebe mensagens do WhatsApp
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
    if (!entry?.messages) return;
    for (const msg of entry.messages) {
      const phone = msg.from;
      const name = entry.contacts?.[0]?.profile?.name || phone;
      const text = msg.type==='text' ? msg.text.body : `[${msg.type}]`;
      const ts = parseInt(msg.timestamp) * 1000;
      // Busca ou cria conversa
      const snap = await db.ref('conversations')
        .orderByChild('phone').equalTo(phone).limitToFirst(1).get();
      let convId;
      if (snap.exists()) {
        convId = Object.keys(snap.val())[0];
        await db.ref(`conversations/${convId}`).update(
          { lastMsg:text, lastDir:'in', updatedAt:ts, unread: admin.database.ServerValue.increment(1) });
      } else {
        const ref = db.ref('conversations').push();
        convId = ref.key;
        await ref.set({ name, phone, status:'open', unread:1,
          agentUid:null, agentName:null, updatedAt:ts, lastMsg:text, lastDir:'in' });
      }
      await db.ref(`messages/${convId}`).push(
        { dir:'in', text, ts, type:msg.type });
    }
  } catch(e) { console.error(e); }
});
app.listen(process.env.PORT || 3000,
  () => console.log('Webhook rodando!'));