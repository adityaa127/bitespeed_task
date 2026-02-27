import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app';

type IdentifyResponse = {
  contact: {
    primaryContatctId: number;
    emails: string[];
    phoneNumbers: string[];
    secondaryContactIds: number[];
  };
};

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL,
    },
  },
});

const app = createApp(prisma);
let baseUrl = '';
let server: ReturnType<typeof app.listen>;

async function postIdentify(
  payload: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}/identify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = await response.json();
  return { status: response.status, body };
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
    throw new Error('Set DATABASE_URL or TEST_DATABASE_URL before running integration tests');
  }

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  await prisma.contact.deleteMany({});
});

after(async () => {
  await prisma.contact.deleteMany({});
  await prisma.$disconnect();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

test('creates a primary on first identify call', async () => {
  const email = `first-${Date.now()}@example.com`;
  const res = await postIdentify({ email });

  assert.equal(res.status, 200);
  assert.equal(typeof res.body?.contact?.primaryContatctId, 'number');
  assert.deepEqual(res.body.contact.emails, [email]);
  assert.deepEqual(res.body.contact.phoneNumbers, []);
  assert.deepEqual(res.body.contact.secondaryContactIds, []);
});

test('adds a secondary when new phone is introduced for same email', async () => {
  const seedEmail = `seed-${Date.now()}@example.com`;
  const phone = `+1555${String(Date.now()).slice(-7)}`;

  const first = await postIdentify({ email: seedEmail });
  const second = await postIdentify({ email: seedEmail, phoneNumber: phone });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(
    second.body.contact.primaryContatctId,
    first.body.contact.primaryContatctId,
  );
  assert.equal(second.body.contact.secondaryContactIds.length, 1);
  assert.equal(second.body.contact.phoneNumbers.includes(phone), true);
});

test('returns 400 when both email and phoneNumber are absent', async () => {
  const res = await postIdentify({});

  assert.equal(res.status, 400);
  assert.equal(typeof res.body.error, 'string');
});

test('merges two primaries and keeps the oldest as primary', async () => {
  const emailA = `a-${Date.now()}@example.com`;
  const emailB = `b-${Date.now()}@example.com`;
  const phone = `+1444${String(Date.now()).slice(-7)}`;

  const firstPrimary = await postIdentify({ email: emailA });
  const secondPrimary = await postIdentify({ email: emailB });

  const merged = await postIdentify({ email: emailB, phoneNumber: phone });
  const linked = await postIdentify({ email: emailA, phoneNumber: phone });

  assert.equal(firstPrimary.status, 200);
  assert.equal(secondPrimary.status, 200);
  assert.equal(merged.status, 200);
  assert.equal(linked.status, 200);

  const oldestPrimaryId = Math.min(
    firstPrimary.body.contact.primaryContatctId,
    secondPrimary.body.contact.primaryContatctId,
  );
  assert.equal(linked.body.contact.primaryContatctId, oldestPrimaryId);
  assert.equal(linked.body.contact.secondaryContactIds.length >= 1, true);
});
