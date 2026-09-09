-- Give every client POC a direct project-level CSAT percentage.
-- Normal / Important remains a descriptive tag and no longer drives scoring.
-- Existing active POCs are backfilled equally per project; inactive POCs get 0%.

begin;

alter table public.client_pocs
  add column if not exists weight_percentage numeric(5, 2);

with active_pocs as (
  select
    id,
    count(*) over (partition by project_id) as poc_count,
    row_number() over (partition by project_id order by created_at, id) as poc_number
  from public.client_pocs
  where active = true
), allocations as (
  select
    id,
    case
      when poc_number = 1
        then 100.00 - (round(100.00 / poc_count, 2) * (poc_count - 1))
      else round(100.00 / poc_count, 2)
    end as weight_percentage
  from active_pocs
)
update public.client_pocs as poc
set weight_percentage = allocations.weight_percentage
from allocations
where poc.id = allocations.id
  and poc.weight_percentage is null;

update public.client_pocs
set weight_percentage = 0
where weight_percentage is null;

alter table public.client_pocs
  alter column weight_percentage set default 0,
  alter column weight_percentage set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.client_pocs'::regclass
      and conname = 'client_pocs_weight_percentage_check'
  ) then
    alter table public.client_pocs
      add constraint client_pocs_weight_percentage_check
      check (weight_percentage between 0 and 100);
  end if;
end $$;

comment on column public.client_pocs.weight_percentage is
  'Direct percentage influence on this project CSAT. Active POCs should total 100%; Normal/Important is tag-only.';

commit;
