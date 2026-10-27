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
create or replace function private.agent_can_write(p_page_id text) returns boolean language sql stable security definer set search_path='' as $$
  select auth.uid()='20000000-0000-4000-8000-000000000003'::uuid and p_page_id='stale-update';
$$;
insert into rpc_results select 'before-agent',data from public.pages where id='stale-update';
select set_config('request.jwt.claims','{"sub":"20000000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"principal_type":"agent"}}',true);
set local role authenticated;
select throws_ok($$select public.apply_page_ops('stale-update','[{"op":"set_page","patch":{"title":"Must roll back"}},{"op":"update_block","id":"a","rev":1,"patch":{"html":"Agent edit"}}]')$$,'PT409','block_conflict','stale agent update rejects the whole batch');
reset role;
select is((select data from public.pages where id='stale-update'),(select payload from rpc_results where name='before-agent'),'agent rejection leaves page intact');
select set_config('request.jwt.claims','{"sub":"20000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
set local role authenticated;
select is(public.add_page_comment('stale-update','Not allowed'),'You do not have permission to comment on this page.','no share and no membership cannot comment');
select is(public.get_page_bundle('stale-update'),null::jsonb,'unreadable page has no bundle');
select throws_ok($$select public.apply_workspace_ops('20000000-0000-4000-8000-000000000010','[{"op":"set_root_order","rootOrder":[]}]')$$,'PT403','forbidden','nonmember cannot reorder workspace');
reset role;
select ok(not (select data ? 'comments' from public.pages where id='stale-update'),'denied comment does not insert');
select * from finish();
rollback;
