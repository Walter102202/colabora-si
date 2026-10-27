begin;
select plan(11);

select has_table('public', 'agent_tasks', 'agent_tasks table exists');
select has_table('public', 'task_briefs', 'task_briefs table exists');
select has_table('public', 'agent_runs', 'agent_runs table exists');
select has_table('public', 'agent_activities', 'agent_activities table exists');
select has_table('public', 'agent_artifacts', 'agent_artifacts table exists');
select has_table('public', 'agent_approvals', 'agent_approvals table exists');
select has_table('public', 'agent_reviews', 'agent_reviews table exists');
select has_table('public', 'external_ops', 'external_ops table exists');
select has_table('public', 'agent_events', 'agent_events table exists');
select has_table('public', 'audit_events', 'audit_events table exists');
select has_table('public', 'model_prices', 'model_prices table exists');

select * from finish();
rollback;
