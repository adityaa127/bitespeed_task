-- Prevent exact duplicate contacts: unique email when not null
CREATE UNIQUE INDEX IF NOT EXISTS unique_email_not_null
ON "Contact"(email)
WHERE email IS NOT NULL;
