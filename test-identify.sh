#!/bin/bash
# Smoke tests for the Bitespeed /identify endpoint.
# Run with: ./test-identify.sh [base_url]

set -euo pipefail

BASE_URL="${1:-http://localhost:3000}"
TMP_BODY="$(mktemp)"
RUN_ID="$(date +%s)"

EMAIL_1="test-alice-${RUN_ID}@example.com"
EMAIL_2="test-alice-work-${RUN_ID}@example.com"
PHONE_1="+1555${RUN_ID: -7}"

STATUS_CODE=""
RESPONSE_BODY=""
PRIMARY_ID=""

cleanup() {
  rm -f "$TMP_BODY"
}
trap cleanup EXIT

request_identify() {
  local payload="$1"
  STATUS_CODE="$(curl -sS -o "$TMP_BODY" -w "%{http_code}" \
    -X POST "$BASE_URL/identify" \
    -H "Content-Type: application/json" \
    -d "$payload")"
  RESPONSE_BODY="$(cat "$TMP_BODY")"
}

assert_status() {
  local expected="$1"
  local label="$2"
  if [[ "$STATUS_CODE" != "$expected" ]]; then
    echo "FAIL [$label] expected status $expected got $STATUS_CODE"
    echo "Body: $RESPONSE_BODY"
    exit 1
  fi
}

assert_contact_shape() {
  local label="$1"
  node -e '
    const body = JSON.parse(process.argv[1]);
    if (!body.contact) throw new Error("missing contact");
    if (typeof body.contact.primaryContatctId !== "number") throw new Error("invalid primaryContatctId");
    if (!Array.isArray(body.contact.emails)) throw new Error("emails is not an array");
    if (!Array.isArray(body.contact.phoneNumbers)) throw new Error("phoneNumbers is not an array");
    if (!Array.isArray(body.contact.secondaryContactIds)) throw new Error("secondaryContactIds is not an array");
  ' "$RESPONSE_BODY" >/dev/null || {
    echo "FAIL [$label] invalid response shape"
    echo "Body: $RESPONSE_BODY"
    exit 1
  }
}

extract_primary_id() {
  PRIMARY_ID="$(node -e 'const body = JSON.parse(process.argv[1]); process.stdout.write(String(body.contact.primaryContatctId));' "$RESPONSE_BODY")"
}

assert_primary_id_unchanged() {
  local expected="$1"
  local label="$2"
  if [[ "$PRIMARY_ID" != "$expected" ]]; then
    echo "FAIL [$label] expected primaryContatctId $expected got $PRIMARY_ID"
    echo "Body: $RESPONSE_BODY"
    exit 1
  fi
}

assert_secondary_non_empty() {
  local label="$1"
  node -e '
    const body = JSON.parse(process.argv[1]);
    if (body.contact.secondaryContactIds.length < 1) throw new Error("secondaryContactIds should be non-empty");
  ' "$RESPONSE_BODY" >/dev/null || {
    echo "FAIL [$label] expected secondaryContactIds to be non-empty"
    echo "Body: $RESPONSE_BODY"
    exit 1
  }
}

echo "=== Testing Bitespeed /identify ==="
echo "Base URL: $BASE_URL"
echo "Run ID: $RUN_ID"
echo

echo "1) Create new primary with email only"
request_identify "{\"email\":\"$EMAIL_1\"}"
assert_status "200" "create-primary"
assert_contact_shape "create-primary"
extract_primary_id
PRIMARY_STEP_1="$PRIMARY_ID"
echo "PASS [create-primary] primaryContatctId=$PRIMARY_STEP_1"

echo "2) Add phone for same person"
request_identify "{\"email\":\"$EMAIL_1\",\"phoneNumber\":\"$PHONE_1\"}"
assert_status "200" "add-phone"
assert_contact_shape "add-phone"
extract_primary_id
assert_primary_id_unchanged "$PRIMARY_STEP_1" "add-phone"
assert_secondary_non_empty "add-phone"
echo "PASS [add-phone] primaryContatctId=$PRIMARY_ID"

echo "3) Lookup with phone only"
request_identify "{\"phoneNumber\":\"$PHONE_1\"}"
assert_status "200" "lookup-phone"
assert_contact_shape "lookup-phone"
extract_primary_id
assert_primary_id_unchanged "$PRIMARY_STEP_1" "lookup-phone"
echo "PASS [lookup-phone] primaryContatctId=$PRIMARY_ID"

echo "4) Add second email into same group"
request_identify "{\"phoneNumber\":\"$PHONE_1\",\"email\":\"$EMAIL_2\"}"
assert_status "200" "add-second-email"
assert_contact_shape "add-second-email"
extract_primary_id
assert_primary_id_unchanged "$PRIMARY_STEP_1" "add-second-email"
assert_secondary_non_empty "add-second-email"
echo "PASS [add-second-email] primaryContatctId=$PRIMARY_ID"

echo "5) Invalid empty body should return 400"
request_identify "{}"
assert_status "400" "invalid-empty-body"
echo "PASS [invalid-empty-body]"

echo "6) Invalid empty strings should return 400"
request_identify "{\"email\":\"\",\"phoneNumber\":\"\"}"
assert_status "400" "invalid-empty-strings"
echo "PASS [invalid-empty-strings]"

echo
echo "=== All smoke checks passed ==="
