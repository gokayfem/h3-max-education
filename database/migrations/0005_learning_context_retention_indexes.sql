CREATE INDEX concept_mastery_learner_updated_idx
  ON concept_mastery (learner_id, updated_at DESC, concept);

CREATE INDEX misconceptions_learner_updated_idx
  ON misconceptions (learner_id, updated_at DESC, concept, description);

CREATE INDEX topic_interests_learner_rank_idx
  ON topic_interests (learner_id, weight DESC, updated_at DESC, topic);

CREATE INDEX card_interactions_learner_time_idx
  ON card_interactions (learner_id, occurred_at DESC, id DESC);

CREATE INDEX visual_metadata_learner_time_idx
  ON visual_metadata (learner_id, created_at DESC, visual_id DESC)
  WHERE learner_id IS NOT NULL;
