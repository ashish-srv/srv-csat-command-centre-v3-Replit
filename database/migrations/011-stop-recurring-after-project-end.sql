-- A manually-started project-end cycle is the lifecycle boundary even when
-- the project's planned end date is still in the future. Repair historical
-- rows and remove stale monthly schedules without deleting any feedback data.
update public.projects as project
set
  end_feedback_requested_at = coalesce(
    project.end_feedback_requested_at,
    (
      select min(cycle.started_at)
      from public.feedback_cycles as cycle
      where cycle.project_id = project.id
        and cycle.cycle_type = 'project_end'
    )
  ),
  next_cycle_due_at = null,
  updated_at = now()
where project.end_feedback_requested_at is not null
   or exists (
     select 1
     from public.feedback_cycles as cycle
     where cycle.project_id = project.id
       and cycle.cycle_type = 'project_end'
   );
