// Moon&Us notification sender. Runs every few minutes on GitHub Actions.
// Reads only: users/{uid}/push/schedule (reminder times + already-worded text), spaces/{sid}/outbox
// (short events between the two of you), the space document (who is connected) and push tokens.
// It never reads health logs, notes or settings.
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
const EMULATOR = !!process.env.FIRESTORE_EMULATOR_HOST; // local tests: emulator + dry-run sending
if (!raw && !EMULATOR) { console.log('FIREBASE_SERVICE_ACCOUNT is not set; nothing to send.'); process.exit(0); }
initializeApp(EMULATOR ? { projectId: process.env.GCLOUD_PROJECT || 'demo-moonus' } : { credential: cert(JSON.parse(raw)) });
const db = getFirestore();
const fcm = EMULATOR
  ? { sendEachForMulticast: async ({ tokens, data }) => { console.log('DRY ' + JSON.stringify({ tokens, data })); return { responses: tokens.map(t => (t.startsWith('dead') ? { success: false, error: { code: 'messaging/registration-token-not-registered' } } : { success: true })) }; } }
  : getMessaging();
const now = Date.now();
const LATE_WINDOW = 3 * 3600e3;          // don't deliver reminders more than 3 h late
const DISCREET = { title: 'Moon&Us', body: 'یادآوری Moon&Us' };
const DEAD = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument']);

async function sendTo(uid, messages) {
  const snap = await db.doc(`users/${uid}`).get();
  const u = snap.data() || {};
  const tokens = u.pushTokens || [];
  if (!tokens.length) return 0;
  let ok = 0; const dead = new Set();
  for (const m of messages) {
    const text = u.pushDiscreet ? DISCREET : { title: m.title || 'Moon&Us', body: m.body || '' };
    const res = await fcm.sendEachForMulticast({
      tokens,
      data: { ...text, tag: m.tag || '', url: m.url || './index.html#cycle' },
      webpush: { headers: { Urgency: 'high', TTL: '21600' } },
    });
    res.responses.forEach((r, i) => { if (r.success) ok++; else if (DEAD.has(r.error && r.error.code)) dead.add(tokens[i]); });
  }
  if (dead.size) await db.doc(`users/${uid}`).update({ pushTokens: FieldValue.arrayRemove(...dead) });
  return ok;
}

let sent = 0;

// 1) Scheduled reminders
const schedules = await db.collectionGroup('push').get();
for (const doc of schedules.docs) {
  if (doc.id !== 'schedule') continue;
  const uid = doc.ref.parent.parent.id;
  const d = doc.data();
  const done = new Set(d.sent || []);
  const due = (d.items || []).filter(it => it.at <= now && it.at > now - LATE_WINDOW && !done.has(it.id));
  if (!due.length) continue;
  sent += await sendTo(uid, due.map(it => ({ title: 'Moon&Us', body: it.body, tag: it.id })));
  due.forEach(it => done.add(it.id));
  await doc.ref.update({ sent: [...done].slice(-300) });
}

// 2) Events between the two of you (requests, gifts, acknowledgements, notes)
const events = await db.collectionGroup('outbox').get();
const spaces = new Map();
for (const doc of events.docs) {
  const sid = doc.ref.parent.parent.id;
  const ev = doc.data();
  if (now - (ev.at || 0) < 24 * 3600e3) {
    if (!spaces.has(sid)) spaces.set(sid, (await db.doc(`spaces/${sid}`).get()).data() || null);
    const sp = spaces.get(sid);
    if (sp) {
      const to = ev.to === 'owner' ? [sp.ownerUid] : Object.keys(sp.partners || {});
      for (const uid of to) if (uid && uid !== ev.from) sent += await sendTo(uid, [ev]);
    }
  }
  await doc.ref.delete();
}

console.log(`checked ${schedules.size} schedules and ${events.size} events; delivered ${sent} notifications`);
