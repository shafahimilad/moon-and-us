// Moon&Us — Firebase layer (auth + Firestore). Loaded only when js/firebase-config.js has a config.
const V = '10.12.2';
const BASE = `https://www.gstatic.com/firebasejs/${V}/`;
let A, F, auth, db;

export async function init(cfg) {
  const [appM, authM, fsM] = await Promise.all([
    import(BASE + 'firebase-app.js'), import(BASE + 'firebase-auth.js'), import(BASE + 'firebase-firestore.js'),
  ]);
  A = authM; F = fsM;
  const app = appM.initializeApp(cfg);
  auth = A.getAuth(app);
  try {
    db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
  } catch (e) {
    db = F.getFirestore(app);
  }
}

// ---------- auth ----------
export const onAuth = cb => A.onAuthStateChanged(auth, cb);
export const signUp = (email, pass) => A.createUserWithEmailAndPassword(auth, email, pass);
export const signIn = (email, pass) => A.signInWithEmailAndPassword(auth, email, pass);
export const signOutUser = () => A.signOut(auth);
export const resetPassword = email => A.sendPasswordResetEmail(auth, email);
export const user = () => auth.currentUser;
export const deleteAuthUser = () => A.deleteUser(auth.currentUser);

// ---------- users ----------
const userRef = uid => F.doc(db, 'users', uid);
export async function getUserDoc(uid) { const s = await F.getDoc(userRef(uid)); return s.exists() ? s.data() : null; }
export const setUserDoc = (uid, data) => F.setDoc(userRef(uid), data, { merge: true });
export const deleteUserDoc = uid => F.deleteDoc(userRef(uid));

// ---------- spaces (one per couple; owned by her) ----------
const spaceRef = sid => F.doc(db, 'spaces', sid);
export async function createSpace(uid, data, logs) {
  const ref = F.doc(F.collection(db, 'spaces'));
  await F.setDoc(ref, { ...data, ownerUid: uid, partnerUid: null, partnerName: '', inviteCode: null, createdAt: Date.now() });
  const batch = F.writeBatch(db);
  for (const [k, l] of Object.entries(logs || {})) batch.set(F.doc(db, 'spaces', ref.id, 'logs', k), l);
  await batch.commit();
  return ref.id;
}
export const updateSpace = (sid, patch) => F.updateDoc(spaceRef(sid), patch);

export function watchSpace(sid, { onSpace, onLogs, onNotes, onError }) {
  const u = [
    F.onSnapshot(spaceRef(sid), s => onSpace(s.exists() ? s.data() : null), onError),
    F.onSnapshot(F.collection(db, 'spaces', sid, 'logs'), qs => { const o = {}; qs.forEach(d => { o[d.id] = d.data(); }); onLogs(o); }, onError),
    F.onSnapshot(F.collection(db, 'spaces', sid, 'notes'), qs => { const a = []; qs.forEach(d => a.push({ id: d.id, ...d.data() })); a.sort((x, y) => x.at - y.at); onNotes(a); }, onError),
  ];
  return () => u.forEach(f => f());
}

export const writeLog = (sid, key, log) => log
  ? F.setDoc(F.doc(db, 'spaces', sid, 'logs', key), log)
  : F.deleteDoc(F.doc(db, 'spaces', sid, 'logs', key));
export async function writeLogs(sid, logs) {
  const batch = F.writeBatch(db);
  for (const [k, l] of Object.entries(logs)) {
    const ref = F.doc(db, 'spaces', sid, 'logs', k);
    l ? batch.set(ref, l) : batch.delete(ref);
  }
  await batch.commit();
}
export const addNote = (sid, note) => F.addDoc(F.collection(db, 'spaces', sid, 'notes'), note);
export const deleteNote = (sid, id) => F.deleteDoc(F.doc(db, 'spaces', sid, 'notes', id));

// ---------- invites ----------
function randomCode() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789'; const b = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(b, x => abc[x % abc.length]).join('');
}
export async function createInvite(sid, uid, herName) {
  const code = randomCode();
  await F.setDoc(F.doc(db, 'invites', code), { spaceId: sid, ownerUid: uid, herName, createdAt: Date.now() });
  await updateSpace(sid, { inviteCode: code });
  return code;
}
export async function getInvite(code) { const s = await F.getDoc(F.doc(db, 'invites', code)); return s.exists() ? s.data() : null; }
export const deleteInvite = code => F.deleteDoc(F.doc(db, 'invites', code)).catch(() => {});
export async function joinSpace(code, invite, uid, name) {
  await F.updateDoc(spaceRef(invite.spaceId), { partnerUid: uid, partnerName: name, joinedWith: code, joinedAt: Date.now() });
  await setUserDoc(uid, { spaceId: invite.spaceId, role: 'partner', name });
}
export async function leaveSpace(sid, uid) {
  await F.updateDoc(spaceRef(sid), { partnerUid: null, partnerName: '', joinedWith: null, joinedAt: null });
  await setUserDoc(uid, { spaceId: null });
}

// ---------- delete everything (owner) ----------
export async function deleteSpaceAll(sid, inviteCode) {
  for (const sub of ['logs', 'notes']) {
    const qs = await F.getDocs(F.collection(db, 'spaces', sid, sub));
    let batch = F.writeBatch(db); let n = 0;
    for (const d of qs.docs) { batch.delete(d.ref); if (++n % 400 === 0) { await batch.commit(); batch = F.writeBatch(db); } }
    await batch.commit();
  }
  if (inviteCode) await deleteInvite(inviteCode);
  await F.deleteDoc(spaceRef(sid));
}
