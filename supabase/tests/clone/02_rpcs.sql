begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public,extensions;
select no_plan();
insert into auth.users(id,email) values
  ('20000000-0000-4000-8000-000000000001','rpc-owner@demo.local'),
  ('20000000-0000-4000-8000-000000000002','rpc-outsider@demo.local'),
  ('20000000-0000-4000-8000-000000000003','rpc-agent@demo.local');
insert into public.workspaces(id,name,owner_id) values ('20000000-0000-4000-8000-000000000010','RPC test','20000000-0000-4000-8000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role) values ('20000000-0000-4000-8000-000000000010','20000000-0000-4000-8000-000000000001','owner');
select set_config('request.jwt.claims','{"sub":"20000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
create temporary table fixtures(name text,payload jsonb);
create temporary table rpc_results(name text,payload jsonb);
grant all on fixtures,rpc_results to authenticated;

create function pg_temp.fixture_page(p_page jsonb) returns jsonb language sql as $$
  select jsonb_set(p_page - '_client','{blocks}',(
    select jsonb_agg(case when b ? 'attr' then jsonb_set(b,'{attr}','{"by":"human","id":"person","at":1700000000000}') else b end order by ord)
    from jsonb_array_elements(p_page->'blocks') with ordinality as blocks(b,ord)
  ));
$$;
insert into fixtures values ('deleted-anchor',$fixture${
  "ops": [
    {
      "rev": 1,
      "op": "delete_block",
      "id": "b"
    },
    {
      "op": "insert_block",
      "after": "b",
      "block": {
        "indent": 0,
        "id": "c",
        "html": "C",
        "type": "paragraph"
      }
    }
  ],
  "page": {
    "blocks": [
      {
        "indent": 0,
        "rev": 2,
        "id": "a",
        "html": "A",
        "type": "paragraph"
      },
      {
        "indent": 0,
        "rev": 1,
        "id": "b",
        "html": "B",
        "type": "paragraph"
      }
    ],
    "parentId": null,
    "icon": null,
    "id": "page",
    "isDeleted": false,
    "cover": null,
    "fullWidth": false,
    "title": "Page",
    "createdAt": 1700000000000,
    "isFavorite": false,
    "smallText": false,
    "updatedAt": 1700000000000
  },
  "expected": {
    "results": [
      {
        "rev": 2,
        "i": 0,
        "ok": true
      },
      {
        "rev": 1,
        "i": 1,
        "ok": true
      }
    ],
    "page": {
      "id": "page",
      "updatedAt": 1700000000000,
      "title": "Page",
      "isDeleted": false,
      "cover": null,
      "icon": null,
      "fullWidth": false,
      "createdAt": 1700000000000,
      "blocks": [
        {
          "indent": 0,
          "rev": 2,
          "id": "a",
          "html": "A",
          "type": "paragraph"
        },
        {
          "html": "C",
          "indent": 0,
          "id": "c",
          "type": "paragraph",
          "rev": 1,
          "attr": {
            "by": "human",
            "id": "person",
            "at": 1700000000000
          }
        }
      ],
      "parentId": null,
      "isFavorite": false,
      "smallText": false
    }
  },
  "actor": {
    "by": "human",
    "id": "person",
    "at": 1700000000000
  }
}
$fixture$::jsonb);
insert into fixtures values ('stale-update',$fixture${
  "ops": [
    {
      "rev": 1,
      "patch": {
        "html": "Changed"
      },
      "op": "update_block",
      "id": "a"
    }
  ],
  "page": {
    "blocks": [
      {
        "indent": 0,
        "rev": 2,
        "id": "a",
        "html": "A",
        "type": "paragraph"
      },
      {
        "indent": 0,
        "rev": 1,
        "id": "b",
        "html": "B",
        "type": "paragraph"
      }
    ],
    "parentId": null,
    "icon": null,
    "id": "page",
    "isDeleted": false,
    "cover": null,
    "fullWidth": false,
    "title": "Page",
    "createdAt": 1700000000000,
    "isFavorite": false,
    "smallText": false,
    "updatedAt": 1700000000000
  },
  "expected": {
    "results": [
      {
        "rev": 3,
        "conflict": {
          "theirs": {
            "indent": 0,
            "rev": 2,
            "id": "a",
            "html": "A",
            "type": "paragraph"
          },
          "id": "a"
        },
        "i": 0,
        "ok": true
      }
    ],
    "page": {
      "id": "page",
      "updatedAt": 1700000000000,
      "title": "Page",
      "isDeleted": false,
      "cover": null,
      "icon": null,
      "fullWidth": false,
      "createdAt": 1700000000000,
      "blocks": [
        {
          "html": "Changed",
          "indent": 0,
          "id": "a",
          "type": "paragraph",
          "rev": 3,
          "attr": {
            "by": "human",
            "id": "person",
            "at": 1700000000000
          }
        },
        {
          "indent": 0,
          "rev": 1,
          "id": "b",
          "html": "B",
          "type": "paragraph"
        }
      ],
      "parentId": null,
      "isFavorite": false,
      "smallText": false
    }
  },
  "actor": {
    "by": "human",
    "id": "person",
    "at": 1700000000000
  }
}
$fixture$::jsonb);
insert into public.pages(id,workspace_id,data)
select name,'20000000-0000-4000-8000-000000000010',payload->'page' from fixtures;
set local role authenticated;
insert into rpc_results select name,public.apply_page_ops(name,payload->'ops','fixture') from fixtures;
select is(pg_temp.fixture_page(p.data),f.payload->'expected'->'page',f.name || ' matches TypeScript page') from fixtures f join public.pages p on p.id=f.name;
select is(r.payload->'results',f.payload->'expected'->'results',f.name || ' matches TypeScript results') from fixtures f join rpc_results r using(name);
select is(p.data#>>'{blocks,0,attr,id}','20000000-0000-4000-8000-000000000001','actor is sealed by server') from public.pages p where id='stale-update';
select ok((p.data#>>'{blocks,0,attr,at}')::bigint >= floor(extract(epoch from now())*1000)::bigint,'actor time is server time') from public.pages p where id='stale-update';
select is((select data#>>'{blocks,0,rev}' from public.pages where id='stale-update'),'3','stale human update increments block rev');
select is((select payload#>'{results,0,conflict,theirs}' from rpc_results where name='stale-update'),(select payload#>'{page,blocks,0}' from fixtures where name='stale-update'),'stale update returns previous block');
select is((select data#>>'{blocks,1,id}' from public.pages where id='deleted-anchor'),'c','X-5 deleted anchor falls back to living predecessor');
insert into rpc_results values('title',public.apply_page_ops('stale-update','[{"op":"set_page","patch":{"title":"Changed title"}}]'));
select is((select revision from public.pages where id='stale-update'),3::bigint,'set_page increments page revision');
insert into rpc_results values('delete',public.apply_page_ops('stale-update','[{"op":"delete_block","id":"a","rev":1}]'));
select is((select payload#>>'{results,0,conflict,theirs,html}' from rpc_results where name='delete'),'Changed','X-3 stale delete returns displaced block');
select is((select jsonb_array_length(data->'blocks') from public.pages where id='stale-update'),1,'X-3 stale human delete applies');
update public.pages set data=null,deleted_at=now() where id='stale-update';
select lives_ok($$select public.apply_page_ops('stale-update',jsonb_build_array(jsonb_build_object('op','replace_page','page',(select payload->'page' from fixtures where name='stale-update'),'revision',0)))$$,'replace_page restores tombstone');
select ok((select deleted_at is null and data is not null from public.pages where id='stale-update'),'restored page clears tombstone');
insert into rpc_results values('workspace',public.apply_workspace_ops('20000000-0000-4000-8000-000000000010','[{"op":"set_root_order","rootOrder":["stale-update","deleted-anchor"]}]','fixture'));
select is((select root_order from public.workspaces where id='20000000-0000-4000-8000-000000000010'),'["stale-update","deleted-anchor"]'::jsonb,'workspace root order applies');
reset role;

-- Give only this fixture agent access inside the rolled-back test transaction.
-- The partial-write RPCs resolve the agent row from the JWT, so the fixture agent gets one.
insert into public.agents (id, workspace_id, auth_user_id, name, kind, sponsor_user_id, created_by)
values ('20000000-0000-4000-8000-000000000020','20000000-0000-4000-8000-000000000010','20000000-0000-4000-8000-000000000003','Fixture agent','acp_local','20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001');
create or replace function private.agent_can_write(p_page_id text) returns boolean language sql stable security definer set search_path='' as $$
  select auth.uid()='20000000-0000-4000-8000-000000000003'::uuid and p_page_id='stale-update';
$$;
create or replace function private.agent_can(p_page_id text, p_scope text)
returns boolean language sql stable security definer set search_path='' as $$
  select private.agent_can_write(p_page_id);
$$;
insert into rpc_results select 'before-agent',data from public.pages where id='stale-update';
select set_config('request.jwt.claims','{"sub":"20000000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"principal_type":"agent","agent_id":"20000000-0000-4000-8000-000000000020"}}',true);
set local role authenticated;
select throws_ok($$select public.apply_page_ops('stale-update','[{"op":"set_page","patch":{"title":"Must roll back"}},{"op":"update_block","id":"a","rev":1,"patch":{"html":"Agent edit"}}]')$$,'PT403','use_partial_writes','agents cannot call apply_page_ops');
select throws_ok($$select public.edit_block_text('stale-update','a','A','Agent edit',1)$$,'PT409','block_conflict','stale agent edit through edit_block_text is rejected');
reset role;
select is((select data from public.pages where id='stale-update'),(select payload from rpc_results where name='before-agent'),'agent rejection leaves page intact');
select set_config('request.jwt.claims','{"sub":"20000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
set local role authenticated;
select is(public.add_page_comment('stale-update','Not allowed'),'You do not have permission to comment on this page.','no share and no membership cannot comment');
select is(public.get_page_bundle('stale-update'),null::jsonb,'unreadable page has no bundle');
select throws_ok($$select public.apply_workspace_ops('20000000-0000-4000-8000-000000000010','[{"op":"set_root_order","rootOrder":[]}]')$$,'PT403','forbidden','nonmember cannot reorder workspace');
reset role;
select ok(not (select data ? 'comments' from public.pages where id='stale-update'),'denied comment does not insert');

-- Scalar and property operations used by row RPCs, including their undo payloads.
select set_config('request.jwt.claims','{}',true);
select lives_ok($$insert into public.pages(id,workspace_id,data,last_edited_by_type)
  values('system-page','20000000-0000-4000-8000-000000000010','{"id":"system-page","title":"System page","blocks":[]}','human')$$,
  'a seed without a principal can insert a page');
select is((select last_edited_by_type from public.pages where id='system-page'),'system','seed actor is system');
select ok((select last_edited_by is null from public.pages where id='system-page'),'system has no user id');
update public.pages set last_edited_by_type='human',last_edited_by='20000000-0000-4000-8000-000000000001' where id='system-page';
select ok((select last_edited_by_type='system' and last_edited_by is null from public.pages where id='system-page'),'job updates cannot forge a human actor');
select is(private.principal_type(),'anon','system attribution does not turn anon into an authorized principal');
set local role anon;
select is((select count(*) from public.pages where id='system-page'),0::bigint,'anonymous still cannot read an unpublished system page');
reset role;
select set_config('request.jwt.claims','{"sub":"20000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
insert into public.pages(id,workspace_id,data) values
  ('ops-db','20000000-0000-4000-8000-000000000010','{"id":"ops-db","title":"Options database","blocks":[],"database":{"id":"db","properties":[{"id":"title","name":"Name","type":"text"},{"id":"status","name":"Status","type":"select","options":[]},{"id":"key","name":"Key","type":"id","nextId":1}],"rows":[],"views":[]}}'),
  ('ops-row','20000000-0000-4000-8000-000000000010','{"id":"ops-row","title":"Before","blocks":[]}');
insert into rpc_results values('original-properties',(select data#>'{database,properties}' from public.pages where id='ops-db'));
select set_config('request.jwt.claims','{"sub":"20000000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"principal_type":"agent"}}',true);
insert into rpc_results values('properties',private.apply_page_ops_core('ops-db','[
  {"op":"db_prop_set","property":{"id":"status","name":"Status","type":"select","options":[{"id":"done","name":"Done","color":"green"}]}},
  {"op":"db_prop_set","property":{"id":"key","name":"Key","type":"id","nextId":2}},
  {"op":"db_row_add","after":null,"row":{"id":"r1","pageId":"ops-row","cells":{"title":"Before","status":"done","key":1}}}
]',null));
select is((select data#>>'{database,properties,1,options,0,name}' from public.pages where id='ops-db'),'Done','agent row operations can create a select option');
select is((select data#>>'{database,properties,2,nextId}' from public.pages where id='ops-db'),'2','agent row operations advance the id counter');
select is((select data#>>'{database,rows,0,cells,key}' from public.pages where id='ops-db'),'1','row insertion uses the allocated id');
select is((select payload->'inverse' from rpc_results where name='properties'),'[
  {"op":"db_row_delete","rowId":"r1"},
  {"op":"db_prop_set","property":{"id":"key","name":"Key","type":"id","nextId":1},"after":"status"},
  {"op":"db_prop_set","property":{"id":"status","name":"Status","type":"select","options":[]},"after":"title"}
]'::jsonb,'row and property inverses preserve values and order');
select private.apply_page_ops_core('ops-db',(select payload->'inverse' from rpc_results where name='properties'),null);
select is((select data#>'{database,properties}' from public.pages where id='ops-db'),(select payload from rpc_results where name='original-properties'),'property inverses restore the schema');
select is((select data#>'{database,rows}' from public.pages where id='ops-db'),'[]'::jsonb,'row inverse removes the inserted row');
insert into rpc_results values('new-property',private.apply_page_ops_core('ops-db','[{"op":"db_prop_set","property":{"id":"extra","name":"Extra","type":"text"},"after":"title"}]',null));
select is((select data#>>'{database,properties,1,id}' from public.pages where id='ops-db'),'extra','new property respects after');
select is((select payload->'inverse' from rpc_results where name='new-property'),'[{"op":"db_prop_delete","propertyId":"extra"}]'::jsonb,'new property inverse deletes that property');
select private.apply_page_ops_core('ops-db',(select payload->'inverse' from rpc_results where name='new-property'),null);
select is((select data#>'{database,properties}' from public.pages where id='ops-db'),(select payload from rpc_results where name='original-properties'),'new property undo restores the schema');
insert into rpc_results values('row-title',private.apply_page_ops_core('ops-row','[{"op":"set_page","patch":{"title":"Reflected title","id":"forged","parentId":"forged"}}]',null));
select is((select data->>'title' from public.pages where id='ops-row'),'Reflected title','set_page reflects a title on the row page');
select ok((select data->>'id'='ops-row' and not(data ? 'parentId') from public.pages where id='ops-row'),'set_page only updates allowed scalars');
select is((select payload->'inverse' from rpc_results where name='row-title'),'[{"op":"set_page","patch":{"title":"Before"}}]'::jsonb,'set_page returns its scalar inverse');
select private.apply_page_ops_core('ops-row',(select payload->'inverse' from rpc_results where name='row-title'),null);
select is((select data->>'title' from public.pages where id='ops-row'),'Before','set_page inverse restores the title');
select is((select last_edited_by_type from public.pages where id='ops-row'),'agent','agent attribution remains agent');
select set_config('request.jwt.claims','{"sub":"20000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
select is(public.search_pages('Before')->0->>'url','/p/ops-row','search returns the application page route');
select throws_ok($$select private.apply_page_ops_core('ops-row','[]',null)$$,'42501',null,'clients cannot bypass the public RPC authorization');
select set_config('request.jwt.claims','{"sub":"20000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select throws_ok($$select public.apply_page_ops('ops-db','[{"op":"db_prop_set","property":{"id":"key","name":"Key","type":"id","nextId":999}}]')$$,'PT403','forbidden','nonmembers cannot change property counters');
reset role;


select set_config('request.jwt.claims','{"sub":"20000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
insert into rpc_results values('human-comment-id',to_jsonb(public.add_page_comment('ops-row','A comment with an identifier',null,null,null)));
select ok((select payload#>>'{}' from rpc_results where name='human-comment-id') ~ '^[0-9a-f]{32}$','comment RPC returns the generated 32-character id');
select is((select data#>>'{comments,0,id}' from public.pages where id='ops-row'),(select payload#>>'{}' from rpc_results where name='human-comment-id'),'returned comment id identifies the stored comment');
select is((select data#>>'{comments,0,body}' from public.pages where id='ops-row'),'A comment with an identifier','comment body is stored with that id');
reset role;
select set_config('request.jwt.claims','{"sub":"20000000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"principal_type":"agent"}}',true);
set local role authenticated;
insert into rpc_results values('agent-comment-id',to_jsonb(public.add_page_comment('stale-update','Agent comment','b','b',null)));
reset role;
select is((select data#>>'{comments,0,id}' from public.pages where id='stale-update'),(select payload#>>'{}' from rpc_results where name='agent-comment-id'),'agents receive the id of their created comment');
select is((select data#>>'{comments,0,authorType}' from public.pages where id='stale-update'),'agent','returning an id preserves agent attribution');
select isnt((select payload from rpc_results where name='agent-comment-id'),(select payload from rpc_results where name='human-comment-id'),'separate comments have distinct identifiers');


-- Integrated directory and comment delivery use the original two seeded agents; other agents may also be present.
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
select results_eq(
  $$select user_id from public.workspace_directory_v
    where workspace_id='00000000-0000-4000-8000-000000000010' and is_agent
      and user_id in ('00000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000032')
    order by user_id$$,
  $$values ('00000000-0000-4000-8000-000000000031'::uuid),('00000000-0000-4000-8000-000000000032'::uuid)$$,
  'workspace directory includes agents without membership rows');
insert into rpc_results values('mentioned-agent',to_jsonb(public.add_page_comment('research-task-1','<span class="mention person-mention" data-user="00000000-0000-4000-8000-000000000032">@Codex</span> Check the sources')));
select is((select count(*) from public.agent_activities where body->>'comment_id'=(select payload#>>'{}' from rpc_results where name='mentioned-agent') and type='prompt' and body->>'source'='comment'),1::bigint,'an explicit agent mention creates one comment prompt');
select is((select count(*) from public.agent_events where payload->>'comment_id'=(select payload#>>'{}' from rpc_results where name='mentioned-agent') and type='task.feedback' and status='queued' and lease_until is null),1::bigint,'comment prompt queues an immediately available feedback event');
select public.apply_page_ops('research-task-1',jsonb_build_array(jsonb_build_object('op','comment_add','comment',(select c from public.pages p cross join lateral jsonb_array_elements(p.data->'comments') c where p.id='research-task-1' and c->>'id'=(select payload#>>'{}' from rpc_results where name='mentioned-agent')))));
select is((select count(*) from public.agent_activities where body->>'comment_id'=(select payload#>>'{}' from rpc_results where name='mentioned-agent')),1::bigint,'replaying the same comment does not prompt the agent twice');
select is((select count(*) from public.notifications where comment_id=(select payload#>>'{}' from rpc_results where name='mentioned-agent')),0::bigint,'agent mentions do not create a human inbox notification');
reset role;
select set_config('request.jwt.claims','{"sub":"20000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
insert into rpc_results values('foreign-agent-mention',to_jsonb(public.add_page_comment('ops-row','<span data-user="00000000-0000-4000-8000-000000000032">@Codex</span> Outside workspace')));
reset role;
select is((select count(*) from public.agent_activities where body->>'comment_id'=(select payload#>>'{}' from rpc_results where name='foreign-agent-mention')),0::bigint,'mention cannot enqueue work in another workspace');
select set_config('request.jwt.claims','{"sub":"20000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
set local role authenticated;
select is((select count(*) from public.workspace_directory_v),0::bigint,'outsider cannot read people or agents from the directory');
reset role;

-- Whole-page review: revision check, comment and version deletes, version cap.
select set_config('request.jwt.claims','{"sub":"20000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
insert into public.pages(id,workspace_id,data) values ('ops-review','20000000-0000-4000-8000-000000000010','{"id":"ops-review","title":"Review","blocks":[],"comments":[{"id":"c1","body":"keep","authorId":"20000000-0000-4000-8000-000000000001","authorType":"human","createdAt":1}],"versions":[{"id":"v0","createdAt":1,"title":"Review","blocks":[]}]}');
set local role authenticated;
select throws_ok($$select public.apply_page_ops('ops-review','[{"op":"replace_page","page":{"id":"ops-review","title":"Stale","blocks":[]},"revision":0}]')$$,'PT409','page_conflict','replace_page with a stale revision is rejected');
select throws_ok($$select public.apply_page_ops('ops-review','[{"op":"replace_page","page":{"id":"ops-review","title":"x","blocks":[]}}]')$$,'PT400','invalid_revision','replace_page without a revision is rejected');
select lives_ok($$select public.apply_page_ops('ops-review',jsonb_build_array(jsonb_build_object('op','replace_page','page',(select data from public.pages where id='ops-review') || '{"title":"Current"}'::jsonb,'revision',(select revision from public.pages where id='ops-review'))))$$,'replace_page with the current revision applies');
select is((select data->>'title' from public.pages where id='ops-review'),'Current','replace_page with the current revision changed the page');
select throws_ok($$select public.apply_page_ops('ops-review','[{"op":"teleport"}]')$$,'PT400','unknown_operation','unknown operations are still rejected');
reset role;
insert into rpc_results values('comment-delete',private.apply_page_ops_core('ops-review','[{"op":"comment_delete","id":"c1"}]',null));
select is((select jsonb_array_length(data->'comments') from public.pages where id='ops-review'),0,'comment_delete removes the comment');
select is((select payload->'inverse'->0->>'op' from rpc_results where name='comment-delete'),'comment_add','comment_delete inverse is comment_add');
select is((select payload->'inverse'->0->'comment'->>'body' from rpc_results where name='comment-delete'),'keep','comment_delete inverse carries the full comment');
insert into rpc_results values('version-delete',private.apply_page_ops_core('ops-review','[{"op":"version_delete","id":"v0"}]',null));
select is((select payload->'inverse'->0->>'op' from rpc_results where name='version-delete'),'version_add','version_delete inverse is version_add');
select private.apply_page_ops_core('ops-review',(select jsonb_agg(jsonb_build_object('op','version_add','version',jsonb_build_object('id','v'||i,'createdAt',i,'title','V','blocks','[]'::jsonb))) from generate_series(1,12) i),null);
select is((select jsonb_array_length(data->'versions') from public.pages where id='ops-review'),10,'the core keeps at most 10 versions');
select is((select data#>>'{versions,0,id}' from public.pages where id='ops-review'),'v12','newest version first');
insert into rpc_results values('comment-add-inverse',private.apply_page_ops_core('ops-review','[{"op":"comment_add","comment":{"id":"c2","body":"new"}}]',null));
select is((select payload->'inverse' from rpc_results where name='comment-add-inverse'),'[{"op":"comment_delete","id":"c2"}]'::jsonb,'a new comment inverts to comment_delete');
select set_config('request.jwt.claims','{"sub":"20000000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"principal_type":"agent"}}',true);
select throws_ok($$select private.apply_page_ops_core('ops-review','[{"op":"comment_delete","id":"c2"}]',null)$$,'PT403','comment_author_only','an agent cannot delete a comment of another author');
select throws_ok($$select private.apply_page_ops_core('ops-review','[{"op":"version_delete","id":"v12"}]',null)$$,'PT403','humans_only','agents cannot delete versions');

select * from finish();
rollback;
