import { conforms, signedIn, startApp, TestApp, Browser } from '../helpers/http';
import { cloneTemplate, dropDatabase } from '../helpers/scratch';

let t: TestApp;
let db: string;
beforeAll(async () => {
  db = await cloneTemplate('customers');
  t = await startApp(db);
});
afterAll(async () => {
  await t?.close();
  await dropDatabase(db);
});

it('GET /customers is staff-only and exposes only id + displayName (no emails, no hashes)', async () => {
  const agent = await signedIn(t, 'arjun.nair@arvo.example');
  const r = await agent.get('/api/customers');
  expect(r.status).toBe(200);
  conforms('CustomerList', r.body);
  expect(r.body.items.length).toBe(3);
  expect(r.text).not.toMatch(/@customer\.example|argon2|passwordHash|role/);
  expect(r.headers['cache-control']).toBe('no-store');
  const customer = await signedIn(t, 'aarav.menon@customer.example');
  expect((await customer.get('/api/customers')).status).toBe(403);
  expect((await new Browser(t.server).get('/api/customers')).status).toBe(401);
});
