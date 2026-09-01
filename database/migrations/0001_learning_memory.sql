CREATE TABLE learner_profiles (
  learner_id text PRIMARY KEY,
  display_name text CHECK (display_name IS NULL OR char_length(display_name) <= 120),
  age_band text NOT NULL CHECK (age_band IN ('13-15', '16-18')),
  age_band_confirmed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE concept_mastery (
  learner_id text NOT NULL REFERENCES learner_profiles(learner_id) ON DELETE CASCADE,
  concept text NOT NULL CHECK (char_length(concept) BETWEEN 1 AND 160),
  confidence double precision NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  evidence_count integer NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  last_evidence text NOT NULL CHECK (char_length(last_evidence) BETWEEN 1 AND 2000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (learner_id, concept)
);

CREATE TABLE misconceptions (
  learner_id text NOT NULL REFERENCES learner_profiles(learner_id) ON DELETE CASCADE,
  concept text NOT NULL CHECK (char_length(concept) BETWEEN 1 AND 160),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 1000),
  evidence_count integer NOT NULL DEFAULT 1 CHECK (evidence_count > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (learner_id, concept, description)
);

CREATE TABLE learner_preferences (
  learner_id text PRIMARY KEY REFERENCES learner_profiles(learner_id) ON DELETE CASCADE,
  explanation_mode text CHECK (explanation_mode IN ('analogy', 'visual', 'mathematical', 'concise', 'stepwise')),
  pace text CHECK (pace IN ('slower', 'steady', 'faster')),
  challenge text CHECK (challenge IN ('supportive', 'balanced', 'stretch')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE topic_interests (
  learner_id text NOT NULL REFERENCES learner_profiles(learner_id) ON DELETE CASCADE,
  topic text NOT NULL CHECK (char_length(topic) BETWEEN 1 AND 160),
  weight double precision NOT NULL DEFAULT 1 CHECK (weight >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (learner_id, topic)
);

CREATE TABLE session_summaries (
  session_id text PRIMARY KEY,
  learner_id text NOT NULL REFERENCES learner_profiles(learner_id) ON DELETE CASCADE,
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 2000),
  concepts text[] NOT NULL DEFAULT '{}' CHECK (cardinality(concepts) <= 20),
  started_at timestamptz,
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_summaries_learner_completed_idx ON session_summaries (learner_id, completed_at DESC);

CREATE TABLE exploration_edges (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id text NOT NULL REFERENCES session_summaries(session_id) ON DELETE CASCADE,
  from_concept text NOT NULL,
  to_concept text NOT NULL,
  relation text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, from_concept, to_concept)
);

CREATE TABLE card_interactions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id text NOT NULL,
  learner_id text NOT NULL REFERENCES learner_profiles(learner_id) ON DELETE CASCADE,
  card_id text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('branch', 'predict', 'compare', 'sequence', 'check')),
  action text NOT NULL CHECK (action IN ('shown', 'selected', 'dismissed')),
  concept text,
  occurred_at timestamptz NOT NULL
);
CREATE INDEX card_interactions_session_time_idx ON card_interactions (session_id, occurred_at);

CREATE TABLE visual_metadata (
  visual_id text PRIMARY KEY,
  session_id text NOT NULL,
  learner_id text REFERENCES learner_profiles(learner_id) ON DELETE SET NULL,
  concept text NOT NULL,
  duration_seconds smallint NOT NULL CHECK (duration_seconds IN (5, 10, 15)),
  resolution text NOT NULL CHECK (resolution IN ('480p', '768p')),
  outcome text NOT NULL CHECK (outcome IN ('completed', 'interrupted', 'rejected', 'failed')),
  prompt_version integer NOT NULL CHECK (prompt_version >= 0),
  latency_ms integer CHECK (latency_ms >= 0),
  created_at timestamptz NOT NULL
);

CREATE TABLE operational_metrics (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id text,
  learner_id text REFERENCES learner_profiles(learner_id) ON DELETE SET NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  value double precision NOT NULL CHECK (value > '-Infinity'::double precision AND value < 'Infinity'::double precision),
  unit text NOT NULL CHECK (unit IN ('count', 'milliseconds', 'seconds', 'bytes', 'ratio')),
  dimensions jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(dimensions) = 'object' AND pg_column_size(dimensions) <= 8192),
  recorded_at timestamptz NOT NULL
);
CREATE INDEX operational_metrics_name_time_idx ON operational_metrics (name, recorded_at DESC);
