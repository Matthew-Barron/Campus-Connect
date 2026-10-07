-- Campus Connect: let conversations reference listings/events/tutoring with ANY id type (uuid or integer).
-- Only touches the new `conversations` table created by 20261007170000_messaging.sql.
-- uuid -> text is a lossless cast: existing conversation rows keep their values.
-- Safe to re-run.

drop index if exists public.uq_conversations_pair_context;

do $$
begin
  if (select data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'conversations' and column_name = 'context_id') <> 'text' then
    alter table public.conversations alter column context_id type text using context_id::text;
  end if;
end $$;

create unique index if not exists uq_conversations_pair_context
  on public.conversations (user_a, user_b, context_type, coalesce(context_id, ''));
