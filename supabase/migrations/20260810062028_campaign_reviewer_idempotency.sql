-- Campaign Reviewer output is keyed by the strategy version it judged. The
-- unique index makes recording the same paid review safe after a worker crash.
create unique index campaign_reviews_campaign_version_key
  on public.campaign_reviews (campaign_id, version);

-- A Critic judges one asset revision exactly once. This closes the small race
-- between the read-before-insert guard and a retry that reaches the database at
-- the same time, while preserving every revision's history.
create unique index reviews_asset_revision_key
  on public.reviews (asset_id, revision_index);
