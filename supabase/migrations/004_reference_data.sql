-- =====================================================================
-- Pickup Sports Tampa — 004: reference data (real app data, not demo)
-- =====================================================================

-- Approximate neighborhood center points. Used only for travel-radius matching.
insert into public.neighborhoods (slug, name, lat, lng) values
  ('downtown',         'Downtown',         27.9506, -82.4572),
  ('seminole-heights', 'Seminole Heights', 27.9930, -82.4600),
  ('south-tampa',      'South Tampa',      27.9220, -82.5070),
  ('usf',              'USF',              28.0587, -82.4139),
  ('west-tampa',       'West Tampa',       27.9650, -82.4880),
  ('other-tampa',      'Other Tampa',      27.9800, -82.4600);   -- city-wide fallback

insert into public.sports (slug, name, stat_fields) values
  ('soccer',     'Soccer',     '{goals,assists}'),
  ('basketball', 'Basketball', '{points,assists}'),
  ('volleyball', 'Volleyball', '{points}'),
  ('pickleball', 'Pickleball', '{}');
