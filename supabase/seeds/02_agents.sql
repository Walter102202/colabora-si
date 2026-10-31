-- Agent layer seed: model prices, the global agents kill switch, and demo agents and tasks on top of
-- 01_workspace.sql (demo owner, "Demo" workspace, "Market research" with its Agent Tasks rows).
-- Idempotent: deterministic ids and on conflict do nothing; safe on every reset and once by hand on a hosted project.

insert into public.model_prices (model, input_usd_per_mtok, output_usd_per_mtok, cached_input_usd_per_mtok, effective_from, source) values
  ('muse-spark-1.3',       1.25,  4.25, null, date '2026-10-26', 'provider list price'),
  ('muse-wonder-1.0',      4.00, 20.00, null, date '2026-10-26', 'provider list price'),
  ('muse-spark-open-1026', 0.60,  2.40, null, date '2026-10-26', 'estimate for hosted open weights'),
  ('muse-glimmer',         0.00,  0.00, null, date '2026-10-26', 'local inference')
on conflict (model) do nothing;

insert into private.app_flags (name, value) values ('agents_enabled', 'true'::jsonb)
on conflict (name) do nothing;

-- ============ local development secrets ============
-- Only when no token pepper exists yet (a hosted project sets its own before seeding, and issues tokens from
-- Settings > Agents). The agents below sign in with the password derived from AGENT_LOGIN_PEPPER=local-dev-login-pepper
-- (supabase/functions/.env.example); with another pepper, rotate their login from Settings > Agents.
insert into private.app_secrets (name, value) values ('agent_token_pepper', 'local-dev-token-pepper')
on conflict (name) do nothing;

-- ============ demo agents ============
-- Workspace 00000000-0000-4000-8000-000000000010, owner 00000000-0000-4000-8000-000000000001 (from 01_workspace.sql).
-- Claude Code (Lead): agent ...0021, auth user ...0031. Codex (worker): agent ...0022, auth user ...0032.
-- Colabora (platform Lead): agent ...0023, auth user ...0033.
-- Colabora Reviewer (worker): agent ...0024, auth user ...0034.

insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,confirmation_token,email_change,email_change_token_new,recovery_token)
values
  ('00000000-0000-0000-0000-000000000000','00000000-0000-4000-8000-000000000031','authenticated','authenticated',
   'agent+00000000-0000-4000-8000-000000000021@agents.invalid',extensions.crypt(encode(extensions.hmac('00000000-0000-4000-8000-000000000031','local-dev-login-pepper','sha256'),'hex'),extensions.gen_salt('bf')),now(),
   '{"provider":"email","providers":["email"],"principal_type":"agent","agent_id":"00000000-0000-4000-8000-000000000021","workspace_id":"00000000-0000-4000-8000-000000000010"}',
   '{}',now(),now(),'','','',''),
  ('00000000-0000-0000-0000-000000000000','00000000-0000-4000-8000-000000000032','authenticated','authenticated',
   'agent+00000000-0000-4000-8000-000000000022@agents.invalid',extensions.crypt(encode(extensions.hmac('00000000-0000-4000-8000-000000000032','local-dev-login-pepper','sha256'),'hex'),extensions.gen_salt('bf')),now(),
   '{"provider":"email","providers":["email"],"principal_type":"agent","agent_id":"00000000-0000-4000-8000-000000000022","workspace_id":"00000000-0000-4000-8000-000000000010"}',
   '{}',now(),now(),'','','',''),
  ('00000000-0000-0000-0000-000000000000','00000000-0000-4000-8000-000000000033','authenticated','authenticated',
   'agent+00000000-0000-4000-8000-000000000023@agents.invalid',extensions.crypt(encode(extensions.hmac('00000000-0000-4000-8000-000000000033','local-dev-login-pepper','sha256'),'hex'),extensions.gen_salt('bf')),now(),
   '{"provider":"email","providers":["email"],"principal_type":"agent","agent_id":"00000000-0000-4000-8000-000000000023","workspace_id":"00000000-0000-4000-8000-000000000010"}',
   '{}',now(),now(),'','','',''),
  ('00000000-0000-0000-0000-000000000000','00000000-0000-4000-8000-000000000034','authenticated','authenticated',
   'agent+00000000-0000-4000-8000-000000000024@agents.invalid',extensions.crypt(encode(extensions.hmac('00000000-0000-4000-8000-000000000034','local-dev-login-pepper','sha256'),'hex'),extensions.gen_salt('bf')),now(),
   '{"provider":"email","providers":["email"],"principal_type":"agent","agent_id":"00000000-0000-4000-8000-000000000024","workspace_id":"00000000-0000-4000-8000-000000000010"}',
   '{}',now(),now(),'','','','')
on conflict(id) do nothing;
insert into auth.identities(id,user_id,provider_id,identity_data,provider,last_sign_in_at,created_at,updated_at)
select id,id,id::text,jsonb_build_object('sub',id::text,'email',email,'email_verified',true,'phone_verified',false),'email',now(),now(),now()
from auth.users where id in ('00000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000032','00000000-0000-4000-8000-000000000033','00000000-0000-4000-8000-000000000034')
on conflict(provider_id,provider) do nothing;

insert into public.agents (id, workspace_id, auth_user_id, name, kind, delivery, role, sponsor_user_id, capabilities, connection, created_by, is_platform, monthly_budget_usd)
values
  ('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000031',
   'Claude Code','acp_local','pull','lead','00000000-0000-4000-8000-000000000001',
   '{"start":true,"continue":true,"cancel":true,"approval":true,"resume":true}','{"harness":"claude_code"}','00000000-0000-4000-8000-000000000001', false, null),
  ('00000000-0000-4000-8000-000000000022','00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000032',
   'Codex','acp_local','pull','worker','00000000-0000-4000-8000-000000000001',
   '{"start":true,"continue":true,"cancel":true,"approval":true,"resume":true}','{"harness":"codex"}','00000000-0000-4000-8000-000000000001', false, null),
  ('00000000-0000-4000-8000-000000000023','00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000033',
   'Trama','managed','pull','lead','00000000-0000-4000-8000-000000000001',
   '{"start":true,"continue":true,"cancel":true,"approval":true,"cost":true,"resume":true}','{"harness":"agent","model":"muse-spark-1.3","platform":true}','00000000-0000-4000-8000-000000000001', true, 20),
  ('00000000-0000-4000-8000-000000000024','00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000034',
   'Colabora Reviewer','managed','pull','worker','00000000-0000-4000-8000-000000000001',
   '{"start":true,"continue":true,"cancel":true,"approval":true,"cost":true}','{"harness":"agent","model":"meta-models/muse-spark-open-1026"}','00000000-0000-4000-8000-000000000001', false, 10)
on conflict(id) do nothing;

insert into public.agent_grants (id, workspace_id, agent_id, page_id, scopes, inherit, granted_by)
values
  ('00000000-0000-4000-8000-000000000041','00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000021',
   'market-research','{read,write,comment}',true,'00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000042','00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000022',
   'market-research','{read,write,comment}',true,'00000000-0000-4000-8000-000000000001')
on conflict do nothing;

-- Development agent tokens (hash = sha256(pepper || token)); the plain tokens are documented in
-- supabase/functions/.env.example and only work with the local pepper above.
insert into public.agent_tokens (id, workspace_id, agent_id, name, token_hash, token_prefix, scopes, created_by)
select t.id, '00000000-0000-4000-8000-000000000010', t.agent_id, 'local development',
       encode(extensions.digest(convert_to(s.value || t.token, 'utf8'), 'sha256'), 'hex'), left(t.token, 8), '{mcp}',
       '00000000-0000-4000-8000-000000000001'
from (values
  ('00000000-0000-4000-8000-000000000061'::uuid, '00000000-0000-4000-8000-000000000021'::uuid, 'agt_LOCALDEVLEAD0000000000000000000000000001'),
  ('00000000-0000-4000-8000-000000000062'::uuid, '00000000-0000-4000-8000-000000000022'::uuid, 'agt_LOCALDEVCODEX000000000000000000000000002'),
  ('00000000-0000-4000-8000-000000000063'::uuid, '00000000-0000-4000-8000-000000000023'::uuid, 'agt_LOCALDEVCOLABORA000000000000000000000003'),
  ('00000000-0000-4000-8000-000000000064'::uuid, '00000000-0000-4000-8000-000000000024'::uuid, 'agt_LOCALDEVREVIEWER000000000000000000000004')
) as t(id, agent_id, token)
join private.app_secrets s on s.name = 'agent_token_pepper' and s.value = 'local-dev-token-pepper'
on conflict (id) do nothing;

-- ============ task 1: queued on the first row ============

insert into public.agent_tasks (id, workspace_id, context_id, db_page_id, row_page_id, title, delegate_agent_id, owner_user_id,
                                state, brief_version, created_by, created_by_type, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000051','00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000051',
        'market-research','research-task-1','Map customer needs','00000000-0000-4000-8000-000000000022',
        '00000000-0000-4000-8000-000000000001','queued',1,'00000000-0000-4000-8000-000000000001','human',
        now() - interval '2 hours', now() - interval '2 hours')
on conflict(id) do nothing;

insert into public.task_briefs (task_id, version, workspace_id, objective, constraints, done_when, sources, next_step, author_id, author_type, created_at)
values ('00000000-0000-4000-8000-000000000051',1,'00000000-0000-4000-8000-000000000010',
        'Map the top customer needs for the product from public reviews and forum threads.',
        'Cite every claim. Keep it to one page.',
        '[{"id":"c1","text":"At least five needs, each with two sources","check":"lead"},
          {"id":"c2","text":"Needs are ranked by how often they appear","check":"human"}]',
        '[{"kind":"page","ref":"market-research","trust":"internal"}]',
        'Collect sources, then group them into needs.',
        '00000000-0000-4000-8000-000000000001','human', now() - interval '2 hours')
on conflict do nothing;

insert into public.agent_activities (workspace_id, task_id, seq, type, body, author_type, author_id, created_at)
values ('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000051',1,'prompt',
        '{"text":"Map the top customer needs for the product from public reviews and forum threads.","signal":"start","source":"button"}',
        'human','00000000-0000-4000-8000-000000000001', now() - interval '2 hours')
on conflict do nothing;

-- ============ task 2: ready for review on the second row, with an outdated review ============
-- Codex delivered v1, the Lead asked for changes, Codex delivered v2: the review of v1 is outdated by the artifact.

insert into public.agent_tasks (id, workspace_id, context_id, db_page_id, row_page_id, title, delegate_agent_id, owner_user_id,
                                state, review_state, brief_version, review_rounds, created_by, created_by_type, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000052','00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000052',
        'market-research','research-task-2','Compare alternatives','00000000-0000-4000-8000-000000000022',
        '00000000-0000-4000-8000-000000000001','ready_for_review','pending',1,1,'00000000-0000-4000-8000-000000000001','human',
        now() - interval '5 hours', now() - interval '30 minutes')
on conflict(id) do nothing;

insert into public.task_briefs (task_id, version, workspace_id, objective, constraints, done_when, sources, next_step, author_id, author_type, created_at)
values ('00000000-0000-4000-8000-000000000052',1,'00000000-0000-4000-8000-000000000010',
        'Compare the three closest alternatives on price, setup time and integrations.',
        'Use public pricing pages only.',
        '[{"id":"c1","text":"A comparison table with the three alternatives","check":"lead"},
          {"id":"c2","text":"Every price links to its source","check":"lead"}]',
        '[{"kind":"page","ref":"market-research","trust":"internal"}]',
        'Fill the comparison table.',
        '00000000-0000-4000-8000-000000000001','human', now() - interval '5 hours')
on conflict do nothing;

insert into public.agent_runs (id, workspace_id, task_id, agent_id, harness, brief_version, status, last_signal_at,
                               input_tokens, output_tokens, cost_usd, cost_kind, started_at, ended_at, created_at)
values
  ('00000000-0000-4000-8000-000000000061','00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000052',
   '00000000-0000-4000-8000-000000000022','codex',1,'completed', now() - interval '3 hours',
   42000, 6100, 0.180000, 'measured', now() - interval '4 hours', now() - interval '3 hours', now() - interval '4 hours'),
  ('00000000-0000-4000-8000-000000000062','00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000052',
   '00000000-0000-4000-8000-000000000022','codex',1,'completed', now() - interval '30 minutes',
   18500, 3200, 0.090000, 'measured', now() - interval '1 hour', now() - interval '30 minutes', now() - interval '1 hour')
on conflict(id) do nothing;

insert into public.agent_artifacts (id, workspace_id, task_id, run_id, kind, ref, version, page_revision, title, satisfies,
                                    author_type, author_id, created_at)
values ('00000000-0000-4000-8000-000000000071','00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000052',
        '00000000-0000-4000-8000-000000000061','page','research-task-2',1,1,'Comparison table','{c1,c2}',
        'agent','00000000-0000-4000-8000-000000000022', now() - interval '3 hours')
on conflict(id) do nothing;

insert into public.agent_reviews (id, workspace_id, task_id, reviewer_type, reviewer_id, artifact_id, artifact_version, brief_version,
                                  verdict, findings, evidence, created_at)
values ('00000000-0000-4000-8000-000000000081','00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000052',
        'agent','00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000071',1,1,'changes_requested',
        '[{"criterion_id":"c1","status":"verified","note":"The table covers the three alternatives."},
          {"criterion_id":"c2","status":"not_found","note":"Two prices have no source link."}]',
        '[{"kind":"artifact","ref":"00000000-0000-4000-8000-000000000071"}]',
        now() - interval '2 hours')
on conflict(id) do nothing;

insert into public.agent_artifacts (id, workspace_id, task_id, run_id, kind, ref, version, page_revision, title, satisfies,
                                    author_type, author_id, created_at)
values ('00000000-0000-4000-8000-000000000072','00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000052',
        '00000000-0000-4000-8000-000000000062','page','research-task-2',2,1,'Comparison table','{c1,c2}',
        'agent','00000000-0000-4000-8000-000000000022', now() - interval '30 minutes')
on conflict(id) do nothing;
-- Superseding v1 fires the 0007 trigger: the review of v1 becomes outdated_by = 'artifact' and the task review_state 'outdated'.
update public.agent_artifacts set superseded_by = '00000000-0000-4000-8000-000000000072'
 where id = '00000000-0000-4000-8000-000000000071' and superseded_by is null;

insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id, created_at)
values
  ('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000052',null,1,'prompt',
   '{"text":"Compare the three closest alternatives on price, setup time and integrations.","signal":"start","source":"button"}',
   'human','00000000-0000-4000-8000-000000000001', now() - interval '5 hours'),
  ('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000052','00000000-0000-4000-8000-000000000061',2,'action',
   '{"op":"claim","harness":"codex","brief_version":1}',
   'agent','00000000-0000-4000-8000-000000000022', now() - interval '4 hours'),
  ('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000052','00000000-0000-4000-8000-000000000061',3,'response',
   '{"text":"Comparison table ready for review.","artifact_ids":["00000000-0000-4000-8000-000000000071"],"submit":true}',
   'agent','00000000-0000-4000-8000-000000000022', now() - interval '3 hours'),
  ('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000052',null,4,'prompt',
   '{"text":"c2 not_found: Two prices have no source link.","signal":"feedback","source":"lead","review_id":"00000000-0000-4000-8000-000000000081"}',
   'agent','00000000-0000-4000-8000-000000000021', now() - interval '2 hours'),
  ('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000052','00000000-0000-4000-8000-000000000062',5,'action',
   '{"op":"claim","harness":"codex","brief_version":1}',
   'agent','00000000-0000-4000-8000-000000000022', now() - interval '1 hour'),
  ('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000052','00000000-0000-4000-8000-000000000062',6,'response',
   '{"text":"Added source links for every price.","artifact_ids":["00000000-0000-4000-8000-000000000072"],"submit":true}',
   'agent','00000000-0000-4000-8000-000000000022', now() - interval '30 minutes')
on conflict do nothing;
