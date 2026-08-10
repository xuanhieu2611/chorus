-- The service-role worker already bypasses RLS. Keep this RPC security-invoker
-- like the worker and cost RPCs so calling it never grants the caller the
-- function owner's table privileges.
alter function public.begin_asset_generation(uuid, int) security invoker;
alter function public.begin_asset_generation(uuid, int) set search_path = '';
