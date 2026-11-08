// Security rules tests (Firestore emulator): npm run test:rules
import test, { before, after, beforeEach } from 'node:test';
import fs from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteField, writeBatch, collection, getDocs, addDoc } from 'firebase/firestore';

let env;
const SID = 'space1';
before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-moonus', firestore: { rules: fs.readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 } });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'spaces', SID), { ownerUid: 'her', herName: 'B', partners: {}, inviteCode: 'code1' });
    await setDoc(doc(db, 'spaces', SID, 'private', 'settings'), { profile: { mode: 'period' } });
    await setDoc(doc(db, 'spaces', SID, 'logs', '2026-11-01'), { period: 'heavy', note: 'private note', tags: { emotion: ['sad'] } });
    await setDoc(doc(db, 'spaces', SID, 'shared', 'calendar'), { bleedDays: ['2026-11-01'] });
    await setDoc(doc(db, 'invites', 'code1'), { spaceId: SID, ownerUid: 'her', herName: 'B', usedBy: null, usedAt: null });
  });
});
const as = uid => env.authenticatedContext(uid).firestore();
async function join(uid, code = 'code1') {
  const db = as(uid); const b = writeBatch(db);
  b.update(doc(db, 'invites', code), { usedBy: uid, usedAt: 1 });
  b.update(doc(db, 'spaces', SID), { [`partners.${uid}`]: { name: 'A', joinedAt: 1, invite: code } });
  return b.commit();
}

test('owner reads and writes her private data', async () => {
  const db = as('her');
  await assertSucceeds(getDoc(doc(db, 'spaces', SID, 'logs', '2026-11-01')));
  await assertSucceeds(setDoc(doc(db, 'spaces', SID, 'logs', '2026-11-02'), { period: 'light' }));
  await assertSucceeds(getDoc(doc(db, 'spaces', SID, 'private', 'settings')));
});

test('stranger cannot read anything', async () => {
  const db = as('stranger');
  await assertFails(getDoc(doc(db, 'spaces', SID)));
  await assertFails(getDoc(doc(db, 'spaces', SID, 'shared', 'calendar')));
  await assertFails(getDoc(doc(db, 'spaces', SID, 'logs', '2026-11-01')));
});

test('accepting an invite gives read-only access to the shared calendar only', async () => {
  await assertSucceeds(join('him'));
  const db = as('him');
  await assertSucceeds(getDoc(doc(db, 'spaces', SID)));
  await assertSucceeds(getDoc(doc(db, 'spaces', SID, 'shared', 'calendar')));
  // notes, symptoms and settings are never returned to a viewer
  await assertFails(getDoc(doc(db, 'spaces', SID, 'logs', '2026-11-01')));
  await assertFails(getDocs(collection(db, 'spaces', SID, 'logs')));
  await assertFails(getDoc(doc(db, 'spaces', SID, 'private', 'settings')));
  // read-only for her health data
  await assertFails(setDoc(doc(db, 'spaces', SID, 'shared', 'calendar'), { bleedDays: [] }));
  await assertFails(setDoc(doc(db, 'spaces', SID, 'logs', '2026-11-05'), { period: 'heavy' }));
  await assertFails(updateDoc(doc(db, 'spaces', SID), { herName: 'X' }));
});

test('invites are single use and cannot be claimed without the batch', async () => {
  await assertSucceeds(join('him'));
  await assertFails(join('other'));            // already used
  const db = as('sneaky');
  await assertFails(updateDoc(doc(db, 'spaces', SID), { 'partners.sneaky': { name: 'S', joinedAt: 1, invite: 'code1' } }));
  await assertFails(updateDoc(doc(db, 'spaces', SID), { 'partners.sneaky': { name: 'S', joinedAt: 1, invite: 'nope' } }));
});

test('owner cannot claim her own invite', async () => {
  await assertFails(join('her'));
});

test('revoking access blocks every later request from the viewer', async () => {
  await assertSucceeds(join('him'));
  await assertSucceeds(updateDoc(doc(as('her'), 'spaces', SID), { 'partners.him': deleteField() }));
  const db = as('him');
  await assertFails(getDoc(doc(db, 'spaces', SID)));
  await assertFails(getDoc(doc(db, 'spaces', SID, 'shared', 'calendar')));
  await assertFails(addDoc(collection(db, 'spaces', SID, 'notes'), { uid: 'him', text: 'hi', at: 1 }));
  await assertFails(join('him'));               // the old invite can't be reused
});

test('viewer can leave, and only removes themself', async () => {
  await assertSucceeds(join('him'));
  await env.withSecurityRulesDisabled(async ctx => { await updateDoc(doc(ctx.firestore(), 'spaces', SID), { 'partners.other': { name: 'O', joinedAt: 1, invite: 'x' } }); });
  await assertFails(updateDoc(doc(as('him'), 'spaces', SID), { 'partners.other': deleteField() }));
  await assertSucceeds(updateDoc(doc(as('him'), 'spaces', SID), { 'partners.him': deleteField() }));
});

test('notes: members write their own, strangers cannot', async () => {
  await assertSucceeds(join('him'));
  await assertSucceeds(addDoc(collection(as('him'), 'spaces', SID, 'notes'), { uid: 'him', from: 'partner', text: 'hi', at: 1 }));
  await assertFails(addDoc(collection(as('him'), 'spaces', SID, 'notes'), { uid: 'her', from: 'her', text: 'spoof', at: 1 }));
  await assertFails(addDoc(collection(as('x'), 'spaces', SID, 'notes'), { uid: 'x', text: 'hi', at: 1 }));
});

test('feedback is create-only', async () => {
  const db = as('her');
  const ref = await assertSucceeds(addDoc(collection(db, 'feedback'), { uid: 'her', text: 'bug', createdAt: 1 }));
  await assertFails(getDoc(ref));
  await assertFails(addDoc(collection(db, 'feedback'), { uid: 'someone-else', text: 'x' }));
});

test('gifts: partner sends, she opens/loves, partner cannot edit after', async () => {
  await assertSucceeds(join('him'));
  const him = as('him'), her = as('her');
  const ref = await assertSucceeds(addDoc(collection(him, 'spaces', SID, 'gifts'), { uid: 'him', type: 'note', text: 'دوستت دارم', at: 1, openedAt: null, redeemedAt: null, reaction: null }));
  await assertFails(addDoc(collection(him, 'spaces', SID, 'gifts'), { uid: 'him', type: 'script', text: 'x', at: 1 }));
  await assertFails(addDoc(collection(him, 'spaces', SID, 'gifts'), { uid: 'her', type: 'note', text: 'spoof', at: 1 }));
  await assertSucceeds(updateDoc(doc(her, 'spaces', SID, 'gifts', ref.id), { openedAt: 2, reaction: 'love' }));
  await assertFails(updateDoc(doc(her, 'spaces', SID, 'gifts', ref.id), { text: 'changed' }));
  await assertFails(updateDoc(doc(him, 'spaces', SID, 'gifts', ref.id), { openedAt: 3 }));
  await assertFails(getDoc(doc(as('stranger'), 'spaces', SID, 'gifts', ref.id)));
});

test('requests: only she creates; partner can only acknowledge', async () => {
  await assertSucceeds(join('him'));
  const him = as('him'), her = as('her');
  await assertFails(addDoc(collection(him, 'spaces', SID, 'requests'), { uid: 'him', kind: 'hug', at: 1, status: 'open' }));
  const ref = await assertSucceeds(addDoc(collection(her, 'spaces', SID, 'requests'), { uid: 'her', kind: 'hug', at: 1, status: 'open', ackAt: null }));
  await assertSucceeds(updateDoc(doc(him, 'spaces', SID, 'requests', ref.id), { status: 'onit', ackAt: 2 }));
  await assertFails(updateDoc(doc(him, 'spaces', SID, 'requests', ref.id), { kind: 'space' }));
  await assertFails(updateDoc(doc(him, 'spaces', SID, 'requests', ref.id), { status: 'open' }));
});
