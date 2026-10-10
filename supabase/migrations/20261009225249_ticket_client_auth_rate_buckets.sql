CREATE TABLE alpha_private.ticket_client_auth_rate_buckets (
  bucket_kind text NOT NULL CHECK (bucket_kind IN ('client_sign_in','client_activation')),
  subject_hash char(64) NOT NULL CHECK (subject_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts >= 1 AND attempts <= 1000),
  PRIMARY KEY (bucket_kind,subject_hash)
);

ALTER TABLE alpha_private.ticket_client_auth_rate_buckets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE alpha_private.ticket_client_auth_rate_buckets
  FROM PUBLIC, anon, authenticated, service_role;
