// Notification sender test (Firestore emulator, dry-run sending): npm run test:sender
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, getDocs, collection } from 'firebase/firestore';

let env;
before(async () => { env = await initializeTestEnvironment({ projectId: 'demo-moonus', firestore: { rules: fs.readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 } }); });
after(async () => { await env.cleanup(); });

const run = () => execFileSync(process.execPath, ['send-push.mjs'], { cwd: 'server', env: { ...process.env, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', GCLOUD_PROJECT: 'demo-moonus' }, encoding: 'utf8' });

test('delivers due reminders once, routes events to the other person, honours discreet, drops dead tokens', async () => {
  await env.clearFirestore();
  const now = Date.now();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users', 'her'), { role: 'her', spaceId: 'S1', pushTokens: ['tok-her'] });
    await setDoc(doc(db, 'users', 'him'), { role: 'partner', spaceId: 'S1', pushTokens: ['tok-him', 'dead-old'], pushDiscreet: true });
    await setDoc(doc(db, 'spaces', 'S1'), { ownerUid: 'her', herName: 'B', partners: { him: { name: 'M' } } });
    await setDoc(doc(db, 'users', 'her', 'push', 'schedule'), { items: [
      { id: 'period_soon:2026-11-20', at: now - 60e3, body: 'پریودت حدود ۲ روز دیگه شروع می‌شه.' },
      { id: 'future', at: now + 3600e3, body: 'later' },
      { id: 'tooOld', at: now - 5 * 3600e3, body: 'stale' },
    ] });
    await setDoc(doc(db, 'spaces', 'S1', 'outbox', 'e1'), { from: 'her', to: 'partners', title: 'B', body: 'بغل', tag: 'req-1', url: './index.html#us', at: now });
    await setDoc(doc(db, 'spaces', 'S1', 'outbox', 'e2'), { from: 'him', to: 'owner', title: 'M', body: 'یه چیزی برات گذاشت', tag: 'gift-1', url: './index.html#us', at: now });
  });
  const out1 = run();
  const sends = out1.split('\n').filter(l => l.startsWith('DRY ')).map(l => JSON.parse(l.slice(4)));
  // reminder to her (exactly the due one), request to him (discreet), gift to her
  assert.equal(sends.filter(s => s.data.tag === 'period_soon:2026-11-20').length, 1, out1);
  assert.ok(!sends.some(s => ['future', 'tooOld'].includes(s.data.tag)));
  const toHim = sends.find(s => s.data.tag === 'req-1');
  assert.deepEqual(toHim.tokens, ['tok-him', 'dead-old']);
  assert.equal(toHim.data.body, 'یادآوری Moon&Us');          // he chose discreet notifications
  const toHer = sends.find(s => s.data.tag === 'gift-1');
  assert.deepEqual(toHer.tokens, ['tok-her']);
  assert.equal(toHer.data.body, 'یه چیزی برات گذاشت');
  // second run: nothing repeats; outbox emptied; dead token removed
  const out2 = run();
  assert.equal(out2.split('\n').filter(l => l.startsWith('DRY ')).length, 0);
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    assert.equal((await getDocs(collection(db, 'spaces', 'S1', 'outbox'))).size, 0);
    assert.deepEqual((await getDoc(doc(db, 'users', 'him'))).data().pushTokens, ['tok-him']);
  });
});
