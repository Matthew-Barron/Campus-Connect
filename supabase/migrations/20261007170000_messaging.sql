-- Campus Connect: messaging between users (additive migration, no data is modified or deleted).
-- Adds: conversations, messages, 'Message' notification type, notifications.related_conversation_id.
-- Safe to re-run.

-- 1. Notification type (the new value is not used inside this transaction).
alter type public.notification_type add value if not exists 'Message';

-- 2. Conversations: one thread per user pair per context (listing / tutoring / event / direct).
create table if not exists public.conversations (
  conversation_id uuid primary key default gen_random_uuid(),
  user_a uuid not null references public.profiles(id) on delete cascade,
  user_b uuid not null references public.profiles(id) on delete cascade,
  context_type varchar(20) not null default 'direct'
    check (context_type in ('direct', 'listing', 'tutoring', 'event')),
  context_id uuid,                       -- listing_id / tutoring_id / event_id (no FK so threads survive deletion)
  context_title varchar(200),            -- snapshot of the title for display
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint conversations_distinct_users check (user_a <> user_b),
  constraint conversations_ordered_users check (user_a < user_b)
);

create unique index if not exists uq_conversations_pair_context
  on public.conversations (user_a, user_b, context_type, coalesce(context_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists idx_conversations_user_a on public.conversations (user_a, last_message_at desc);
create index if not exists idx_conversations_user_b on public.conversations (user_b, last_message_at desc);

-- 3. Messages
create table if not exists public.messages (
  message_id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(conversation_id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  body varchar(1000) not null check (char_length(btrim(body)) between 1 and 1000),
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_messages_conversation on public.messages (conversation_id, created_at);
create index if not exists idx_messages_unread on public.messages (conversation_id) where read_at is null;

-- 4. Link notifications to a conversation (nullable, existing rows unaffected).
alter table public.notifications
  add column if not exists related_conversation_id uuid references public.conversations(conversation_id) on delete set null;

-- 5. Row Level Security: only participants can read. All writes go through the server (service role),
--    which verifies participation first.
alter table public.conversations enable row level security;
alter table public.messages enable row level security;

drop policy if exists conversations_select on public.conversations;
create policy conversations_select on public.conversations for select to authenticated
using (user_a = auth.uid() or user_b = auth.uid());

drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated
using (exists (
  select 1 from public.conversations c
  where c.conversation_id = messages.conversation_id
    and (c.user_a = auth.uid() or c.user_b = auth.uid())
));

revoke all on public.conversations, public.messages from anon;
revoke insert, update, delete on public.conversations, public.messages from authenticated;
grant select on public.conversations, public.messages to authenticated;
