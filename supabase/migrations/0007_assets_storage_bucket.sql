-- Phase 5 rendered clips are small enough for Supabase Storage and need a URL
-- the browser's native <video> element can stream without credentials. Source
-- uploads remain on local disk and never enter this bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('assets', 'assets', true, 52428800, array['video/mp4'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
