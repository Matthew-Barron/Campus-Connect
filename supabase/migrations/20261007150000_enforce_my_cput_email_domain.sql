-- Campus Connect: restrict authentication to CPUT student emails.
-- Apply this migration to existing Supabase projects.

-- Existing profiles must comply with the new policy before the constraint is added.
do $$
begin
  if exists (select 1 from public.profiles where lower(email) !~ '^[^\s@]+@mycput\.ac\.za$') then
    raise exception 'Existing profiles contain non-@mycput.ac.za email addresses; update/remove them before applying this migration';
  end if;
end;
$$;

alter table public.profiles
drop constraint if exists profiles_email_my_cput_check;

alter table public.profiles
add constraint profiles_email_my_cput_check
check (email = lower(email) and email ~ '^[^\s@]+@mycput\.ac\.za$');

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.email is null or lower(new.email) !~ '^[^\s@]+@mycput\.ac\.za$' then
    raise exception 'Only @mycput.ac.za email addresses are allowed';
  end if;

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

