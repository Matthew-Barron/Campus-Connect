-- Campus Connect - Supabase / PostgreSQL schema
-- Run this in the Supabase SQL editor (or as a migration).
-- Authentication is owned by Supabase Auth (auth.users).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.user_role as enum ('Student', 'Society_Admin', 'Staff');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.listing_status as enum ('Available', 'Pending', 'Sold');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.rsvp_status as enum ('Attending', 'Not_Attending', 'Interested');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.notification_type as enum ('Event', 'Poll', 'Listing', 'Society', 'System');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Generic updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Profiles: application data linked 1:1 to Supabase Auth
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name varchar(100) not null,
  email varchar(120) not null unique,
  student_number varchar(20) not null unique,
  role public.user_role not null default 'Student',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Keep profile email/name in sync when a user is created through Supabase Auth.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, name, email, student_number)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    lower(new.email),
    coalesce(new.raw_user_meta_data->>'student_number', 'PENDING-' || substr(new.id::text, 1, 12))
  )
  on conflict (id) do update set
    name = excluded.name,
    email = excluded.email,
    student_number = excluded.student_number,
    updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute procedure public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Marketplace
-- ---------------------------------------------------------------------------
create table if not exists public.listings (
  listing_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title varchar(150) not null,
  description text,
  price numeric(10,2) not null check (price > 0),
  status public.listing_status not null default 'Available',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.listing_responses (
  response_id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings(listing_id) on delete cascade,
  responder_id uuid not null references public.profiles(id) on delete cascade,
  message varchar(500) not null check (char_length(message) between 1 and 500),
  created_at timestamptz not null default now()
);

create trigger listings_set_updated_at before update on public.listings
for each row execute procedure public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------------
create table if not exists public.events (
  event_id uuid primary key default gen_random_uuid(),
  organiser_id uuid not null references public.profiles(id) on delete cascade,
  title varchar(150) not null,
  description text,
  date_time timestamptz not null,
  location varchar(200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.event_rsvps (
  event_id uuid not null references public.events(event_id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  rsvp_status public.rsvp_status not null default 'Interested',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

create trigger events_set_updated_at before update on public.events
for each row execute procedure public.set_updated_at();
create trigger event_rsvps_set_updated_at before update on public.event_rsvps
for each row execute procedure public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Polls
-- ---------------------------------------------------------------------------
create table if not exists public.polls (
  poll_id uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.profiles(id) on delete cascade,
  question varchar(255) not null,
  options jsonb not null,
  closes_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint polls_options_is_array check (jsonb_typeof(options) = 'array')
);

create table if not exists public.poll_votes (
  poll_id uuid not null references public.polls(poll_id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  selected_option varchar(255) not null,
  created_at timestamptz not null default now(),
  primary key (poll_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Societies
-- ---------------------------------------------------------------------------
create table if not exists public.societies (
  society_id uuid primary key default gen_random_uuid(),
  name varchar(100) not null,
  description text,
  admin_user_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.society_members (
  society_id uuid not null references public.societies(society_id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (society_id, user_id)
);

create trigger societies_set_updated_at before update on public.societies
for each row execute procedure public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Tutoring
-- ---------------------------------------------------------------------------
create table if not exists public.tutoring_listings (
  tutoring_id uuid primary key default gen_random_uuid(),
  tutor_id uuid not null references public.profiles(id) on delete cascade,
  subject varchar(100) not null,
  rate numeric(10,2) not null check (rate > 0),
  availability varchar(200),
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger tutoring_listings_set_updated_at before update on public.tutoring_listings
for each row execute procedure public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  notification_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type public.notification_type not null default 'System',
  message varchar(500) not null,
  related_event_id uuid references public.events(event_id) on delete set null,
  related_poll_id uuid references public.polls(poll_id) on delete set null,
  related_listing_id uuid references public.listings(listing_id) on delete set null,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index if not exists idx_profiles_email on public.profiles(email);
create index if not exists idx_profiles_student_number on public.profiles(student_number);
create index if not exists idx_listings_user_status on public.listings(user_id, status);
create index if not exists idx_listings_status_created on public.listings(status, created_at desc);
create index if not exists idx_listing_responses_listing on public.listing_responses(listing_id, created_at desc);
create index if not exists idx_events_organiser_date on public.events(organiser_id, date_time);
create index if not exists idx_events_date_time on public.events(date_time);
create index if not exists idx_event_rsvps_user on public.event_rsvps(user_id);
create index if not exists idx_poll_votes_poll on public.poll_votes(poll_id);
create index if not exists idx_societies_admin on public.societies(admin_user_id);
create index if not exists idx_society_members_user on public.society_members(user_id);
create index if not exists idx_tutoring_tutor on public.tutoring_listings(tutor_id);
create index if not exists idx_notifications_user_read on public.notifications(user_id, is_read, created_at desc);

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------
create or replace view public.vw_unread_notifications as
select user_id, count(*)::bigint as unread_count
from public.notifications
where is_read = false
group by user_id;

create or replace view public.vw_active_polls as
select p.poll_id, p.question, p.created_by, p.options, p.closes_at,
       count(pv.user_id)::bigint as vote_count,
       (p.closes_at > now()) as is_active
from public.polls p
left join public.poll_votes pv on pv.poll_id = p.poll_id
where p.closes_at > now() - interval '7 days'
group by p.poll_id;

create or replace view public.vw_society_member_counts as
select society_id, count(*)::bigint as member_count
from public.society_members
group by society_id;

create or replace view public.vw_event_attendance as
select event_id,
       count(*) filter (where rsvp_status = 'Attending')::bigint as attending_count,
       count(*) filter (where rsvp_status = 'Interested')::bigint as interested_count,
       count(*) filter (where rsvp_status = 'Not_Attending')::bigint as not_attending_count,
       count(*)::bigint as total_responses
from public.event_rsvps
group by event_id;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.listings enable row level security;
alter table public.listing_responses enable row level security;
alter table public.events enable row level security;
alter table public.event_rsvps enable row level security;
alter table public.polls enable row level security;
alter table public.poll_votes enable row level security;
alter table public.societies enable row level security;
alter table public.society_members enable row level security;
alter table public.tutoring_listings enable row level security;
alter table public.notifications enable row level security;

-- Re-running the migration is safe: remove policies first.
do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public' loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- Profiles: authenticated users can read profiles; users can edit only themselves.
create policy profiles_select on public.profiles for select to authenticated using (true);
-- Profiles are provisioned by the auth trigger/server. No direct client insert/update policy is granted.

-- Listings: public read, owner write, authenticated users can respond.
create policy listings_select on public.listings for select to anon, authenticated using (true);
create policy listings_insert on public.listings for insert to authenticated with check (user_id = auth.uid());
create policy listings_update on public.listings for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy listings_delete on public.listings for delete to authenticated using (user_id = auth.uid());

create policy listing_responses_select on public.listing_responses for select to authenticated
using (
  responder_id = auth.uid()
  or exists (select 1 from public.listings l where l.listing_id = listing_responses.listing_id and l.user_id = auth.uid())
);
create policy listing_responses_insert on public.listing_responses for insert to authenticated
with check (responder_id = auth.uid());

-- Events: public read; authenticated users can create and manage their own; anyone authenticated can RSVP.
create policy events_select on public.events for select to anon, authenticated using (true);
create policy events_insert on public.events for insert to authenticated with check (organiser_id = auth.uid());
create policy events_update on public.events for update to authenticated using (organiser_id = auth.uid()) with check (organiser_id = auth.uid());
create policy events_delete on public.events for delete to authenticated using (organiser_id = auth.uid());

create policy event_rsvps_select on public.event_rsvps for select to authenticated using (user_id = auth.uid());
create policy event_rsvps_insert on public.event_rsvps for insert to authenticated with check (user_id = auth.uid());
create policy event_rsvps_update on public.event_rsvps for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy event_rsvps_delete on public.event_rsvps for delete to authenticated using (user_id = auth.uid());

-- Polls: public read; authenticated users create polls and their own votes.
create policy polls_select on public.polls for select to anon, authenticated using (true);
create policy polls_insert on public.polls for insert to authenticated with check (created_by = auth.uid());
create policy polls_update on public.polls for update to authenticated using (created_by = auth.uid()) with check (created_by = auth.uid());
create policy polls_delete on public.polls for delete to authenticated using (created_by = auth.uid());

create policy poll_votes_select on public.poll_votes for select to authenticated using (user_id = auth.uid());
create policy poll_votes_insert on public.poll_votes for insert to authenticated
with check (
  user_id = auth.uid()
  and exists (
    select 1 from public.polls p
    where p.poll_id = poll_votes.poll_id
      and p.closes_at > now()
      and p.options ? poll_votes.selected_option
  )
);

-- Societies: public read; creator manages society; users manage only their membership row.
create policy societies_select on public.societies for select to anon, authenticated using (true);
create policy societies_insert on public.societies for insert to authenticated with check (admin_user_id = auth.uid());
create policy societies_update on public.societies for update to authenticated using (admin_user_id = auth.uid()) with check (admin_user_id = auth.uid());
create policy societies_delete on public.societies for delete to authenticated using (admin_user_id = auth.uid());

create policy society_members_select on public.society_members for select to authenticated
using (
  user_id = auth.uid()
  or exists (select 1 from public.societies s where s.society_id = society_members.society_id and s.admin_user_id = auth.uid())
);
create policy society_members_insert on public.society_members for insert to authenticated with check (user_id = auth.uid());
create policy society_members_delete on public.society_members for delete to authenticated using (user_id = auth.uid());

-- Tutoring: public read; tutors own their listings.
create policy tutoring_select on public.tutoring_listings for select to anon, authenticated using (true);
create policy tutoring_insert on public.tutoring_listings for insert to authenticated with check (tutor_id = auth.uid());
create policy tutoring_update on public.tutoring_listings for update to authenticated using (tutor_id = auth.uid()) with check (tutor_id = auth.uid());
create policy tutoring_delete on public.tutoring_listings for delete to authenticated using (tutor_id = auth.uid());

-- Notifications are private to their owner. Server-side system notifications use service_role.
create policy notifications_select on public.notifications for select to authenticated using (user_id = auth.uid());
create policy notifications_update on public.notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notifications_delete on public.notifications for delete to authenticated using (user_id = auth.uid());

-- Grant API roles access to the objects; RLS remains the authorization boundary.
grant usage on schema public to anon, authenticated;
grant select on all tables in schema public to anon, authenticated;
grant insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;

grant select on public.vw_unread_notifications, public.vw_active_polls,
  public.vw_society_member_counts, public.vw_event_attendance to anon, authenticated;

-- Note: never expose SUPABASE_SERVICE_ROLE_KEY to the browser.
