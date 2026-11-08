// Moon&Us — Firebase layer (auth + Firestore). Loaded only when js/firebase-config.js has a config.
// Layout and access rules: see firestore.rules.
const V = '10.12.2';
const BASE = `https://www.gstatic.com/firebasejs/${V}/`;
let A, F, auth, db;

export async function init(cfg, opts = {}) {
  const [appM, authM, fsM] = await Promise.all([
    import(BASE + 'firebase-app.js'), import(BASE + 'firebase-auth.js'), import(BASE + 'firebase-firestore.js'),
  ]);
  A = authM; F = fsM;
  const app = appM.initializeApp(cfg);
  auth = A.getAuth(app);
  try { db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) }); }
  catch (e) { db = F.getFirestore(app); }
  if (opts.emulator) { A.connectAuthEmulator(auth, opts.emulator.auth, { disableWarnings: true }); F.connectFirestoreEmulator(db, opts.emulator.host, opts.emulator.port); }
}

// ---------- auth ----------
export const onAuth = cb => A.onAuthStateChanged(auth, cb);
export const signUp = (email, pass) => A.createUserWithEmailAndPassword(auth, email, pass);
export const signIn = (email, pass) => A.signInWithEmailAndPassword(auth, email, pass);
export const signOutUser = () => A.signOut(auth);
export const resetPassword = email => A.sendPasswordResetEmail(auth, email);
export const deleteAuthUser = () => A.deleteUser(auth.currentUser);

// ---------- refs ----------
const userRef = uid => F.doc(db, 'users', uid);
const spaceRef = sid => F.doc(db, 'spaces', sid);
const sub = (sid, ...p) => F.doc(db, 'spaces', sid, ...p);

export async function getUserDoc(uid) { const s = await F.getDoc(userRef(uid)); return s.exists() ? s.data() : null; }
export const setUserDoc = (uid, data) => F.setDoc(userRef(uid), data, { merge: true });
export const deleteUserDoc = uid => F.deleteDoc(userRef(uid));

// ---------- owner ----------
export async function createSpace(uid, herName, settings, logs) {
  const ref = F.doc(F.collection(db, 'spaces'));
  await F.setDoc(ref, { ownerUid: uid, herName, partners: {}, inviteCode: null, createdAt: Date.now() });
  const batch = F.writeBatch(db);
  batch.set(sub(ref.id, 'private', 'settings'), settings);
  for (const [k, l] of Object.entries(logs || {})) batch.set(sub(ref.id, 'logs', k), l);
  await batch.commit();
  return ref.id;
}
export const updateSpace = (sid, patch) => F.updateDoc(spaceRef(sid), patch);
export const saveSettings = (sid, settings) => F.setDoc(sub(sid, 'private', 'settings'), settings, { merge: true });
export const saveShared = (sid, proj) => F.setDoc(sub(sid, 'shared', 'calendar'), proj);
export const saveStatus = (sid, status) => F.setDoc(sub(sid, 'couple', 'status'), status || { cleared: Date.now() });
export const saveKit = (sid, kit) => F.setDoc(sub(sid, 'couple', 'kit'), kit);
export const writeLog = (sid, key, log) => log ? F.setDoc(sub(sid, 'logs', key), log) : F.deleteDoc(sub(sid, 'logs', key));
export async function writeLogs(sid, logs) {
  const entries = Object.entries(logs);
  for (let i = 0; i < entries.length; i += 400) {
    const batch = F.writeBatch(db);
    for (const [k, l] of entries.slice(i, i + 400)) l ? batch.set(sub(sid, 'logs', k), l) : batch.delete(sub(sid, 'logs', k));
    await batch.commit();
  }
}
export function removePartner(sid, puid) { return F.updateDoc(spaceRef(sid), { [`partners.${puid}`]: F.deleteField() }); }

// ---------- watching ----------
const snap = (ref, cb, onError) => F.onSnapshot(ref, s => cb(s.exists() ? s.data() : null), onError);
export function watchOwner(sid, h) {
  const u = [
    snap(spaceRef(sid), h.onSpace, h.onError),
    snap(sub(sid, 'private', 'settings'), h.onSettings, h.onError),
    F.onSnapshot(F.collection(db, 'spaces', sid, 'logs'), qs => { const o = {}; qs.forEach(d => { o[d.id] = d.data(); }); h.onLogs(o); }, h.onError),
    snap(sub(sid, 'couple', 'status'), h.onStatus, h.onError),
    snap(sub(sid, 'couple', 'kit'), h.onKit, h.onError),
    watchNotes(sid, h.onNotes, h.onError),
    watchList(sid, 'gifts', 100, h.onGifts, h.onError),
    watchList(sid, 'requests', 60, h.onRequests, h.onError),
  ];
  return () => u.forEach(f => f());
}
export function watchViewer(sid, h) {
  const u = [
    snap(spaceRef(sid), h.onSpace, h.onError),
    snap(sub(sid, 'shared', 'calendar'), h.onShared, h.onError),
    snap(sub(sid, 'couple', 'status'), h.onStatus, h.onError),
    snap(sub(sid, 'couple', 'kit'), h.onKit, h.onError),
    watchNotes(sid, h.onNotes, h.onError),
    watchList(sid, 'gifts', 100, h.onGifts, h.onError),
    watchList(sid, 'requests', 60, h.onRequests, h.onError),
  ];
  return () => u.forEach(f => f());
}
function watchList(sid, name, n, cb, onError) {
  const q = F.query(F.collection(db, 'spaces', sid, name), F.orderBy('at', 'desc'), F.limit(n));
  return F.onSnapshot(q, qs => { const a = []; qs.forEach(d => a.push({ id: d.id, ...d.data() })); cb(a); }, onError);
}
export const addItem = (sid, name, data) => F.addDoc(F.collection(db, 'spaces', sid, name), data);
export const updateItem = (sid, name, id, patch) => F.updateDoc(sub(sid, name, id), patch);
export const deleteItem = (sid, name, id) => F.deleteDoc(sub(sid, name, id));
function watchNotes(sid, cb, onError) {
  return F.onSnapshot(F.collection(db, 'spaces', sid, 'notes'), qs => { const a = []; qs.forEach(d => a.push({ id: d.id, ...d.data() })); a.sort((x, y) => x.at - y.at); cb(a); }, onError);
}
export const addNote = (sid, note) => F.addDoc(F.collection(db, 'spaces', sid, 'notes'), note);
export const deleteNote = (sid, id) => F.deleteDoc(sub(sid, 'notes', id));

// ---------- invites ----------
function randomCode() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789'; const b = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(b, x => abc[x % abc.length]).join('');
}
export async function createInvite(sid, uid, herName) {
  const code = randomCode();
  await F.setDoc(F.doc(db, 'invites', code), { spaceId: sid, ownerUid: uid, herName, createdAt: Date.now(), usedBy: null, usedAt: null });
  await updateSpace(sid, { inviteCode: code });
  return code;
}
export async function getInvite(code) { const s = await F.getDoc(F.doc(db, 'invites', code)); return s.exists() ? s.data() : null; }
export const deleteInvite = code => F.deleteDoc(F.doc(db, 'invites', code)).catch(() => {});
/** Claims the single-use invite and adds the viewer in one atomic batch. */
export async function joinSpace(code, invite, uid, name) {
  const batch = F.writeBatch(db);
  batch.update(F.doc(db, 'invites', code), { usedBy: uid, usedAt: Date.now() });
  batch.update(spaceRef(invite.spaceId), { [`partners.${uid}`]: { name, joinedAt: Date.now(), invite: code } });
  await batch.commit();
  await setUserDoc(uid, { spaceId: invite.spaceId, role: 'partner', name });
}
export async function leaveSpace(sid, uid) {
  await F.updateDoc(spaceRef(sid), { [`partners.${uid}`]: F.deleteField() }).catch(() => {});
  await setUserDoc(uid, { spaceId: null });
}

// ---------- support ----------
export const sendFeedback = (uid, data) => F.addDoc(F.collection(db, 'feedback'), { ...data, uid, createdAt: Date.now() });

// ---------- delete everything (owner) ----------
export async function deleteSpaceAll(sid, inviteCode) {
  for (const name of ['logs', 'notes', 'gifts', 'requests']) {
    const qs = await F.getDocs(F.collection(db, 'spaces', sid, name));
    let batch = F.writeBatch(db); let n = 0;
    for (const d of qs.docs) { batch.delete(d.ref); if (++n % 400 === 0) { await batch.commit(); batch = F.writeBatch(db); } }
    await batch.commit();
  }
  const batch = F.writeBatch(db);
  for (const p of [['private', 'settings'], ['shared', 'calendar'], ['couple', 'status'], ['couple', 'kit']]) batch.delete(sub(sid, ...p));
  await batch.commit();
  if (inviteCode) await deleteInvite(inviteCode);
  await F.deleteDoc(spaceRef(sid));
}
