-- A subscription refresh the provider refused (ADR-0037); a new sign-in replaces the row and clears it.
ALTER TABLE provider_credentials
  ADD COLUMN IF NOT EXISTS sign_in_required_at timestamptz;
