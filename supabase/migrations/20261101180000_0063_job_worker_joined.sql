-- A named Worker that takes a subtask has joined its job. join_job is how a session says so first,
-- not the only way: an agent can receive its subtasks directly and work without ever calling it.
create or replace function private.join_job_on_run()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.agent_tasks job
     set joined_worker_ids = array_append(job.joined_worker_ids, new.agent_id), updated_at = now()
    from public.agent_tasks sub
   where sub.id = new.task_id and job.id = sub.parent_task_id
     and new.agent_id = any(job.named_worker_ids)
     and not new.agent_id = any(job.joined_worker_ids);
  return null;
end $$;
revoke all on function private.join_job_on_run() from public, anon, authenticated;

create trigger agent_runs_join_job after insert on public.agent_runs
  for each row execute function private.join_job_on_run();

-- Workers that already took subtasks before this rule existed.
update public.agent_tasks job
   set joined_worker_ids = job.joined_worker_ids || array(
         select distinct r.agent_id from public.agent_runs r
           join public.agent_tasks sub on sub.id = r.task_id
          where sub.parent_task_id = job.id
            and r.agent_id = any(job.named_worker_ids)
            and not r.agent_id = any(job.joined_worker_ids))
 where exists (
         select 1 from public.agent_runs r
           join public.agent_tasks sub on sub.id = r.task_id
          where sub.parent_task_id = job.id
            and r.agent_id = any(job.named_worker_ids)
            and not r.agent_id = any(job.joined_worker_ids));
