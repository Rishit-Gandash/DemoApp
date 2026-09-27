-- Run this in the Supabase SQL editor (or via `supabase db push`).
-- Design: items + item_options are "current state" tables that get
-- upserted every crawl. price_history is append-only so every crawl run
-- (every 2h) adds a new row per option, giving you a time series.

create table if not exists items (
  id              bigint primary key,        -- external item_id from the source site
  name            text,
  url             text not null,
  option_axis     text,                      -- e.g. 'Level'
  first_seen_at   timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists item_options (
  id                  bigserial primary key,
  item_id             bigint not null references items(id) on delete cascade,
  external_option_id  text,                  -- e.g. 'o1' — kept for reference, NOT the join key
  label               text not null,         -- e.g. 'Starter' — the stable identifier
  first_seen_at       timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (item_id, label)
);

create table if not exists price_history (
  id              bigserial primary key,
  item_option_id  bigint not null references item_options(id) on delete cascade,
  price           numeric,
  stock           integer,
  sample_count    integer not null,          -- how many getPrice() calls this vote came from
  crawled_at      timestamptz not null default now()
);

-- Optional but recommended: track each crawl run for observability/debugging.
create table if not exists crawl_runs (
  id              bigserial primary key,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  items_processed integer default 0,
  options_processed integer default 0,
  errors          integer default 0,
  status          text default 'running'     -- running | completed | failed
);

create index if not exists idx_price_history_item_option_id on price_history(item_option_id);
create index if not exists idx_price_history_crawled_at on price_history(crawled_at);
create index if not exists idx_item_options_item_id on item_options(item_id);

-- Keep only the most recent 10 price_history rows per option, instead of
-- growing forever. Runs automatically after every insert.
create or replace function trim_price_history() returns trigger as $$
begin
  delete from price_history
  where item_option_id = new.item_option_id
    and id not in (
      select id from price_history
      where item_option_id = new.item_option_id
      order by crawled_at desc, id desc
      limit 10
    );
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_trim_price_history on price_history;
create trigger trg_trim_price_history
  after insert on price_history
  for each row execute function trim_price_history();
