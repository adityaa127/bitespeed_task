# Testing Bitespeed /identify

This guide helps you verify your implementation against the [Bitespeed Identity Reconciliation](https://bitespeed.notion.site/Bitespeed-Backend-Task-Identity-Reconciliation-1fb21bb2a930802eb896d4409460375c) task.

## Run the Server

```bash
# 1. Install deps, set DATABASE_URL in .env, run migrations
npm install
npx prisma migrate dev --name init   # if not already done
npx prisma generate

# 2. Start server (port 3000 by default)
npm run dev
```

## Run Tests

```bash
# Make script executable (once)
chmod +x test-identify.sh

# Run against localhost:3000
./test-identify.sh

# Or against another URL
./test-identify.sh http://localhost:4000

# Integration tests (builds TS, starts app in-process, calls HTTP endpoint)
# Uses TEST_DATABASE_URL if set, else DATABASE_URL.
npm run test:integration
```

## Bitespeed Task Alignment Checklist

| Requirement | Status |
|-------------|--------|
| **Request**: `POST /identify` with `{ "email"?: string, "phoneNumber"?: string }` — at least one required | ✅ |
| **Response**: `contact.primaryContatctId`, `emails`, `phoneNumbers`, `secondaryContactIds` | ✅ |
| **Rule 1**: No match → create primary, empty `secondaryContactIds` | ✅ |
| **Rule 2–3**: Matches exist → expand group transitively; primary = oldest `createdAt`; convert other primaries to secondary | ✅ |
| **Rule 4**: New email/phone not in group → create secondary with `linkedId = primary.id` | ✅ |
| **Rule 5**: Exact match (no new info) → no new row, return group | ✅ |
| **Rule 6**: `emails` / `phoneNumbers` unique; primary’s email/phone first | ✅ |
| **400** on invalid input (missing both, empty) | ✅ |
| DB transaction for all updates/creates | ✅ |

## Expected Behavior (Manual Checks)

1. **First call with new email**  
   → New primary created.  
   → `primaryContatctId` = new id, `secondaryContactIds` = `[]`.

2. **Second call with same email + new phone**  
   → Secondary created.  
   → `secondaryContactIds` contains the new secondary id.

3. **Third call with only phone (already in group)**  
   → No new contact.  
   → Same group returned.

4. **Call with new email + existing phone**  
   → New secondary for the new email.

5. **Two primaries later linked**  
   → Older one stays primary; other becomes secondary with `linkedId = primary.id`.

6. **Empty body or both empty**  
   → 400 error.

## Quick Manual Test (curl)

```bash
# 1. New primary
curl -X POST http://localhost:3000/identify -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com"}'

# 2. Add phone (secondary created)
curl -X POST http://localhost:3000/identify -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","phoneNumber":"+15550001111"}'

# 3. Phone only (no new row)
curl -X POST http://localhost:3000/identify -H "Content-Type: application/json" \
  -d '{"phoneNumber":"+15550001111"}'
```

## Potential Gotchas

- **Concurrent traffic**: In heavy concurrency, serializable transactions may conflict. The service now retries these conflicts, but you may still see occasional retries in logs.
- **Fresh DB**: Use a fresh database or reset (`npx prisma migrate reset`) for predictable tests.
- **Primary ordering**: If multiple primaries merge, the oldest (`createdAt`) must become the primary.
