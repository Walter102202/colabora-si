-- Pairing is one-use and direct-human initiated; the inbox is platform-runtime only.
begin;
select no_plan();
select tests.fixture() as f \gset
select (:'f'::jsonb->>'ws') as ws,(:'f'::jsonb->>'owner') as owner,(:'f'::jsonb->>'viewer') as viewer,(:'f'::jsonb->>'agent') as agent,(:'f'::jsonb->>'agent_user') as au \gset
insert into private.app_secrets(name,value) values('telegram_bot_username','test_bot') on conflict(name) do update set value=excluded.value;
select tests.set_human(:'owner');
select public.start_channel_link(:'ws')->>'url' as url \gset
select split_part(:'url','start=',2) as code \gset
select ok(length(:'code')=48,'link uses a high entropy code');
select is(tests.sqlstate_of(format($q$select public.redeem_channel_link(%L,'101','101')$q$,:'code')),'42501','person cannot redeem a forged webhook');
select tests.set_human(:'owner','oauth');
select is(tests.sqlstate_of(format('select public.start_channel_link(%L)',:'ws')),'PT403','OAuth cannot create links');
select tests.reset_role();
select tests.set_agent(:'au',:'agent');
select is(tests.sqlstate_of(format('select public.start_channel_link(%L)',:'ws')),'PT403','agent cannot create links');
select is(tests.sqlstate_of('select public.take_channel_updates()'),'PT403','ordinary agent cannot read queue');
select tests.reset_role();
select tests.set_service();
select is(tests.sqlstate_of(format($q$select public.redeem_channel_link(%L,'101','102')$q$,:'code')),'PT403','chat and sender must agree');
select public.redeem_channel_link(:'code','101','101')->>'link_id' as link \gset
select is(tests.sqlstate_of(format($q$select public.redeem_channel_link(%L,'101','101')$q$,:'code')),'PT403','code cannot be reused');
select public.enqueue_channel_update(1001,'101','101','{"message_id":5,"chat":{"id":101,"type":"private"},"from":{"id":101},"text":"hello"}');
select public.enqueue_channel_update(1001,'101','101','{"message_id":5,"chat":{"id":101,"type":"private"},"from":{"id":101},"text":"hello"}');
select is((select count(*) from public.channel_updates where update_id=1001),1::bigint,'duplicate update is one delivery');
select is(tests.sqlstate_of($q$select public.enqueue_channel_update(1002,'101','102','{}')$q$),'PT403','wrong sender cannot enqueue');
select tests.reset_role();
select tests.set_human(:'viewer');
select is((select count(*) from public.agent_channel_links where id=:'link'),0::bigint,'other people cannot read the link');
select tests.reset_role();
update public.agents set is_platform=true where id=:'agent';
select tests.set_agent(:'au',:'agent');
select is(jsonb_array_length(public.take_channel_updates()->'updates'),1,'platform reads linked queue');
select is(jsonb_array_length(public.take_channel_updates()->'updates'),1,'delivery remains until acknowledged');
select is(jsonb_array_length(public.take_channel_updates(1001)->'updates'),0,'acknowledged delivery leaves queue');
select tests.reset_role();
select tests.set_human(:'owner');
select public.disconnect_channel(:'ws');
select tests.reset_role();
select tests.set_service();
select is(tests.sqlstate_of($q$select public.enqueue_channel_update(1003,'101','101','{}')$q$),'PT403','revoked link cannot enqueue');
select tests.reset_role();
select tests.set_human(:'owner');
select split_part(public.start_channel_link(:'ws')->>'url','start=',2) as expired \gset
select tests.reset_role();
update private.channel_link_codes set expires_at=now()-interval '1 second' where used_at is null;
select tests.set_service();
select is(tests.sqlstate_of(format($q$select public.redeem_channel_link(%L,'101','101')$q$,:'expired')),'PT403','expired code is rejected');
select * from finish();
rollback;
