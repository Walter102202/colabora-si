-- Private page boundaries cover files, synced content, and decisions, not just page rows.
begin;
-- Match the Storage API delete context; this guard is separate from the RLS policies tested below.
select set_config('storage.allow_delete_query','true',true);
select no_plan();
select tests.fixture() as f \gset
select (:'f'::jsonb->>'ws') as ws, (:'f'::jsonb->>'owner') as owner \gset
select tests.make_user('privacy-editor@test.local') as editor \gset
select tests.make_user('privacy-sharee@test.local') as sharee \gset
insert into public.workspace_members(workspace_id,user_id,role) values(:'ws',:'editor','editor');
select tests.make_page(:'ws','private-source',null,
  '{"id":"private-source","blocks":[{"id":"private-sync","type":"synced","html":""},{"id":"f","type":"file","fileId":"private-file"}]}');
insert into public.private_pages(page_id,workspace_id,owner_user_id,root_page_id)
values('private-source',:'ws',:'owner','private-source');
select tests.make_page(:'ws','public-copy',null,
  '{"id":"public-copy","blocks":[{"id":"copy","type":"synced","syncedFrom":"private-sync","html":""},{"id":"open-sync","type":"synced","html":""},{"id":"f","type":"file","fileId":"open-file"}]}');
insert into public.page_shares(page_id,user_id,level) values('public-copy',:'sharee','view');
select tests.make_page(:'ws','tombstone-source',null,'{"id":"tombstone-source","blocks":[{"id":"tombstone-sync","type":"synced","html":""}]}');
select tests.set_human(:'owner');
insert into public.files(id,workspace_id) values('private-file',:'ws'),('open-file',:'ws'),('staged-file',:'ws'),('synced-file',:'ws'),('row-origin-file',:'ws');
insert into storage.objects(bucket_id,name) values('files',:'ws'||'/private-file'),('files',:'ws'||'/open-file'),('files',:'ws'||'/staged-file'),('files',:'ws'||'/synced-file'),('files',:'ws'||'/row-origin-file');
insert into public.pages(id,workspace_id,data) values('private-row-origin',:'ws','{"id":"private-row-origin","blocks":[],"rowOrigin":{"databasePageId":"page_A","row":{"id":"former-row","cells":{"attachments":[{"fileId":"row-origin-file"}]}},"index":0}}');
update public.files set uploaded_by=:'editor' where id='staged-file';
select lives_ok(format($q$insert into public.files(id,workspace_id) values('first-upsert-file',%L) on conflict(id) do update set workspace_id=excluded.workspace_id returning id$q$,:'ws'),'first-time upsert can return its newly stamped staging row');
select is((select uploaded_by from public.files where id='staged-file'),:'owner'::uuid,'staged ownership is stamped by the server');
select is((select count(*) from storage.objects where name=:'ws'||'/staged-file'),1::bigint,'uploader reads before the page reference exists');
select lives_ok(format($q$insert into public.files(id,workspace_id) values('staged-file',%L) on conflict(id) do update set workspace_id=excluded.workspace_id$q$,:'ws'),'normal metadata upsert remains supported');
select public.apply_workspace_ops(:'ws','[{"op":"synced_set","key":"private-sync","blocks":[{"id":"secret","type":"paragraph","html":"Private acquisition budget: 500000"},{"id":"sf","type":"file","fileId":"synced-file"}]},{"op":"synced_set","key":"open-sync","blocks":[{"id":"open","type":"paragraph","html":"Public content"}]}]');
select public.apply_workspace_ops(:'ws','[{"op":"synced_set","key":"tombstone-sync","blocks":[]}]');
-- Match sync.tombstonePage: preserve the source row while removing its content and parent.
update public.pages set data=null,parent_id=null,deleted_at=now() where id='tombstone-source';
select lives_ok(format($q$select public.apply_workspace_ops(%L,'[{"op":"synced_set","key":"tombstone-sync","blocks":null}]')$q$,:'ws'),'canonical cleanup succeeds after the source page is tombstoned');
select is((select synced_blocks from public.workspaces where id=:'ws'),'{}'::jsonb,'workspace broadcasts never contain canonical blocks');
select is(public.read_workspace_synced_blocks(:'ws')->'private-sync'->0->>'html','Private acquisition budget: 500000','owner reads the private canonical content');
select ok((public.get_page_bundle('public-copy')->'syncedBlocks')?'private-sync','owner gets private source content in the legacy bundle');
select is((select count(*) from storage.objects where name=:'ws'||'/synced-file'),1::bigint,'owner reads an attachment held only in synced content');
select throws_ok(format($q$select public.apply_workspace_ops(%L,'[{"op":"synced_set","key":"missing","blocks":[]}]')$q$,:'ws'),'PT403','forbidden_synced_source','a new canonical key needs an existing original block');
select throws_ok(format($q$update public.workspaces set synced_blocks='{"leak":[]}' where id=%L$q$,:'ws'),'PT403','use_apply_workspace_ops','raw workspace content writes fail closed');
select throws_ok($q$select * from private.workspace_synced_blocks$q$,'42501',null,'canonical storage is not directly readable');
select throws_ok($q$select private.page_bundle_base('public-copy',200)$q$,'42501',null,'legacy bundle helper cannot be called directly');
select throws_ok(format($q$insert into storage.objects(bucket_id,name) values('files',%L)$q$,'not-a-workspace/unknown'),'42501',null,'malformed object paths fail authorization without a UUID cast error');
select tests.reset_role();

insert into public.private_pages(page_id,workspace_id,owner_user_id,root_page_id) values('private-row-origin',:'ws',:'owner','private-row-origin');

insert into public.agent_tasks(id,workspace_id,context_id,row_page_id,title,delegate_agent_id,owner_user_id,created_by,created_by_type,request_kind)
values('00000000-0000-4000-8000-00000000c001',:'ws','00000000-0000-4000-8000-00000000c001','private-source','Private task',(:'f'::jsonb->>'agent')::uuid,:'owner',:'owner','human','fill'),
('00000000-0000-4000-8000-00000000c002',:'ws','00000000-0000-4000-8000-00000000c002','public-copy','Ordinary task',(:'f'::jsonb->>'agent')::uuid,:'owner',:'owner','human','fill');
insert into public.agent_approvals(workspace_id,task_id,kind,question,params,requested_by_type,requested_by_id)
select :'ws',id,'elicitation','Confidential question','{"budget":500000}','agent',(:'f'::jsonb->>'agent')::uuid from public.agent_tasks where id::text like '%00c00%';
insert into public.external_ops(workspace_id,task_id,provider,action,params_hash,params,idempotency_key)
values(:'ws','00000000-0000-4000-8000-00000000c001','test','send','hash','{"secret":true}','private-op');

select tests.set_human((:'f'::jsonb->>'viewer')::uuid);
select is((select count(*) from public.pages where id='private-source'),0::bigint,'viewer cannot read private source page');
select is((select count(*) from storage.objects where name=:'ws'||'/private-file'),0::bigint,'viewer cannot read the private attachment');
select is((select count(*) from storage.objects where name=:'ws'||'/row-origin-file'),0::bigint,'rowOrigin cell files inherit private page visibility');
select is((select count(*) from storage.objects where name=:'ws'||'/synced-file'),0::bigint,'viewer cannot read private synced attachment');
select is((select count(*) from public.files where id in ('private-file','staged-file','synced-file')),0::bigint,'metadata does not disclose hidden or staged files');
select is((select count(*) from storage.objects where name=:'ws'||'/open-file'),1::bigint,'viewer still reads ordinary page attachments');
select ok(not public.read_workspace_synced_blocks(:'ws')?'private-sync','viewer receives a filtered canonical map');
select ok(public.read_workspace_synced_blocks(:'ws')?'open-sync','ordinary synced blocks remain readable');
select ok(not (public.get_page_bundle('public-copy')->'syncedBlocks')?'private-sync','legacy bundle does not follow a private synced source');
select ok(not (public.workspace_page_bundle('public-copy')->'syncedBlocks')?'private-sync','workspace bundle also excludes private source');
select is((select count(*) from public.agent_approvals where task_id='00000000-0000-4000-8000-00000000c001'),0::bigint,'private task questions are invisible');
select is((select count(*) from public.external_ops),0::bigint,'private task external params are invisible');
select is((select count(*) from public.agent_approvals where task_id='00000000-0000-4000-8000-00000000c002'),1::bigint,'ordinary task questions remain visible');
select tests.reset_role();

select tests.set_human(:'editor');
select throws_ok(format($q$select public.apply_workspace_ops(%L,'[{"op":"synced_set","key":"private-sync","blocks":[]}]')$q$,:'ws'),'PT403','forbidden_synced_source','another editor cannot overwrite private canonical content');
select throws_ok(format($q$select public.apply_workspace_ops(%L,'[{"op":"synced_set","key":"private-sync","blocks":null}]')$q$,:'ws'),'PT403','forbidden_synced_source','another editor cannot delete private canonical content');
select throws_ok($q$select public.apply_page_ops('page_B','[{"op":"insert_block","block":{"id":"steal","type":"file","fileId":"private-file"}}]')$q$,'PT403','forbidden_file_reference','guessing an id cannot launder a private file through a readable page');
select throws_ok(format($q$insert into public.pages(id,workspace_id,data) values('forged-file-page',%L,'{"id":"forged-file-page","blocks":[{"id":"steal","type":"file","fileId":"private-file"}]}')$q$,:'ws'),'PT403','forbidden_file_reference','direct page insertion cannot launder a hidden attachment');
select throws_ok(format($q$select public.apply_workspace_ops(%L,'[{"op":"synced_set","key":"open-sync","blocks":[{"id":"steal","type":"file","fileId":"private-file"}]}]')$q$,:'ws'),'PT403','forbidden_file_reference','a writable synced source cannot launder a hidden attachment');
select throws_ok(format($q$insert into storage.objects(bucket_id,name) values('files',%L)$q$,:'ws'||'/private-file/overwrite'),'42501',null,'editor cannot upload into private file namespace');
with touched as(update storage.objects set metadata='{"changed":true}' where name=:'ws'||'/private-file' returning 1)
select is((select count(*) from touched),0::bigint,'editor cannot overwrite private storage');
with gone as(delete from storage.objects where name=:'ws'||'/private-file' returning 1)
select is((select count(*) from gone),0::bigint,'editor cannot delete private storage');
with gone as(delete from public.files where id='private-file' returning 1)
select is((select count(*) from gone),0::bigint,'editor cannot delete private file metadata');
select throws_ok(format($q$insert into public.files(id,workspace_id) values('staged-file',%L) on conflict(id) do update set workspace_id=excluded.workspace_id$q$,:'ws'),'42501',null,'another editor cannot claim a staged upload');
-- An editor who did not upload the file can preserve and restore a deleted database row.
insert into public.pages(id,workspace_id,data) values('editor-row-origin',:'ws','{"id":"editor-row-origin","blocks":[],"rowOrigin":{"databasePageId":"public-copy","row":{"id":"moved-row","cells":{"files":[{"fileId":"open-file"}]}},"index":0}}');
select public.apply_page_ops('public-copy','[{"op":"delete_block","id":"f"}]');
select public.archive_page('{"page_id":"editor-row-origin"}','editor-archive-row');
select is((select count(*) from storage.objects where name=:'ws'||'/open-file'),0::bigint,'archived-only bytes stay unreadable to a non-uploader editor');
select lives_ok($q$select public.apply_page_ops('public-copy','[{"op":"insert_block","block":{"id":"f","type":"file","fileId":"open-file"}}]')$q$,'an authorized non-uploader restores the row reference before its archived backup');
select public.restore_page('{"page_id":"editor-row-origin"}','editor-restore-row');
select is((select count(*) from storage.objects where name=:'ws'||'/open-file'),1::bigint,'the restored reference makes the file readable again');
-- A forged source block cannot replace the established source-page binding.
select public.apply_page_ops('page_B','[{"op":"insert_block","block":{"id":"private-sync","type":"synced","html":""}}]');
select ok(not public.read_workspace_synced_blocks(:'ws')?'private-sync','forged original block does not open the canonical source');
select tests.reset_role();

select tests.set_human(:'sharee');
select is((select count(*) from storage.objects where name=:'ws'||'/open-file'),1::bigint,'nonmember share recipient reads page attachments');
select is((select count(*) from public.files where id='open-file'),1::bigint,'share recipient resolves the storage location');
select ok((public.get_page_bundle('public-copy')->'syncedBlocks')?'open-sync','shared bundle retains ordinary synced content');
select ok(not (public.get_page_bundle('public-copy')->'syncedBlocks')?'private-sync','shared bundle protects the private source');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select is((select count(*) from public.agent_approvals where task_id='00000000-0000-4000-8000-00000000c001'),1::bigint,'private task delegate still reads its question');
select is((select count(*) from public.external_ops),1::bigint,'private task delegate reads its external operation');
select ok(not public.read_workspace_synced_blocks(:'ws')?'private-sync','delegation does not expose the private page content');
select tests.reset_role();

select tests.set_human(:'owner');
select is((select count(*) from public.agent_approvals where task_id='00000000-0000-4000-8000-00000000c001'),1::bigint,'private task owner retains approval access');
with gone as(delete from storage.objects where name=:'ws'||'/open-file' returning 1)
select is((select count(*) from gone),0::bigint,'GC cannot delete a referenced file even for its uploader');
with gone as(delete from public.files where id='synced-file' returning 1)
select is((select count(*) from gone),0::bigint,'GC protects synced-only references');
with gone as(delete from storage.objects where name=:'ws'||'/staged-file' returning 1)
select is((select count(*) from gone),1::bigint,'uploader can remove an abandoned staged object');
with gone as(delete from public.files where id='staged-file' returning 1)
select is((select count(*) from gone),1::bigint,'uploader can remove abandoned staged metadata');
select lives_ok($q$select public.apply_page_ops('page_A','[{"op":"insert_block","block":{"id":"owner-file-copy","type":"file","fileId":"private-file"}}]')$q$,'an authorized owner can copy a readable file to another page');
select public.apply_page_ops('page_A','[{"op":"delete_block","id":"owner-file-copy"}]');
select public.archive_page('{"page_id":"private-row-origin"}','archive-row-origin');
select is((select count(*) from public.page_files where page_id='private-row-origin' and file_id='row-origin-file'),1::bigint,'rowOrigin alone retains the attachment association in trash');
with gone as(delete from storage.objects where name=:'ws'||'/row-origin-file' returning 1)
select is((select count(*) from gone),0::bigint,'GC cannot delete an archived rowOrigin-only attachment');
select public.restore_page('{"page_id":"private-row-origin"}','restore-row-origin');
select is((select count(*) from storage.objects where name=:'ws'||'/row-origin-file'),1::bigint,'restoring a rowOrigin page restores its file access');
select public.archive_page('{"page_id":"private-source"}','archive-private-file');
with gone as(delete from storage.objects where name=:'ws'||'/private-file' returning 1)
select is((select count(*) from gone),0::bigint,'archived references remain protected from GC');
select public.restore_page('{"page_id":"private-source"}','restore-private-file');
select is((select count(*) from storage.objects where name=:'ws'||'/private-file'),1::bigint,'restoring a page restores attachment readability');
update public.pages set published=true where id='public-copy';
select tests.reset_role();
select tests.set_anon();
select is((select count(*) from storage.objects where name=:'ws'||'/open-file'),1::bigint,'published attachment remains readable anonymously');
select is((select count(*) from public.files where id='open-file'),1::bigint,'published attachment metadata remains resolvable');
select ok((public.get_page_bundle('public-copy')->'syncedBlocks')?'open-sync','public bundle retains ordinary synced content');
select ok(not (public.get_page_bundle('public-copy')->'syncedBlocks')?'private-sync','public bundle cannot expose a private source');
select tests.reset_role();
select tests.set_human(:'owner');
select revision as before_publish from public.workspaces where id=:'ws' \gset
update public.pages set published=true where id='private-source';
select ok((select revision from public.workspaces where id=:'ws')>:before_publish,'publication invalidates the workspace filtered cache');
select tests.reset_role();
select tests.set_anon();
select ok((public.get_page_bundle('public-copy')->'syncedBlocks')?'private-sync','explicit publication permits the private source in public bundles');
select is((select count(*) from storage.objects where name=:'ws'||'/private-file'),1::bigint,'explicit publication permits its attachment');
select tests.reset_role();
-- A privacy transition invalidates a member cache even when the page event is hidden.
select tests.set_human(:'owner');
select revision as before_private from public.workspaces where id=:'ws' \gset
select tests.reset_role();
insert into public.private_pages(page_id,workspace_id,owner_user_id,root_page_id) values('page_B',:'ws',:'owner','page_B');
select ok((select revision from public.workspaces where id=:'ws')>:before_private,'privacy changes invalidate the filtered map');
select * from finish();
rollback;
