CREATE TABLE gateway_durable_events (
  event_id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('learning_evidence', 'session_summary')),
  session_id text NOT NULL,
  learner_id text NOT NULL REFERENCES learner_profiles(learner_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX gateway_durable_events_session_idx
  ON gateway_durable_events (session_id, created_at DESC);
