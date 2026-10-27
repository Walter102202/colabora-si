-- Agent layer seed: model prices used by record_cost estimates and the global agents kill switch.
-- Idempotent: safe to run on every reset and once by hand on a hosted project.

insert into public.model_prices (model, input_usd_per_mtok, output_usd_per_mtok, cached_input_usd_per_mtok, effective_from, source) values
  ('muse-spark-1.3',       1.25,  4.25, null, date '2026-10-26', 'provider list price'),
  ('muse-wonder-1.0',      4.00, 20.00, null, date '2026-10-26', 'provider list price'),
  ('muse-spark-open-1026', 0.60,  2.40, null, date '2026-10-26', 'estimate for hosted open weights'),
  ('muse-glimmer',         0.00,  0.00, null, date '2026-10-26', 'local inference')
on conflict (model) do nothing;

insert into private.app_flags (name, value) values ('agents_enabled', 'true'::jsonb)
on conflict (name) do nothing;
