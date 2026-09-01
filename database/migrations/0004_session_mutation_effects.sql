CREATE TABLE session_mutation_effects (
  effect_id text PRIMARY KEY CHECK (char_length(effect_id) BETWEEN 1 AND 500),
  completed_at timestamptz NOT NULL DEFAULT now()
);
