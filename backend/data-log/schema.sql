-- BreakerOps data-log additions: feedback capture, retrieval index, eval set.
-- Purpose: make the existing raw -> parse -> reply chain usable by ANY model
-- provider, without rebuilding. Apply in the Supabase SQL editor. Idempotent.

-- 1. reply_feedback: did a reply work, and what did the owner correct?
-- Corrections are the most valuable training signal a small company produces.
create table if not exists public.reply_feedback (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  draft_id uuid references public.outbound_drafts(id),          -- the reply this is about, when known
  inbound_message_id uuid references public.inbound_messages(id), -- the message that prompted it, when known
  kind text not null check (kind in ('worked','thumbs_up','thumbs_down','correction')),
  body text not null default '',       -- the corrected reply text when kind = 'correction'
  actor text not null default 'owner', -- who gave the signal: 'owner', 'matt', 'desk'
  created_at timestamptz not null default now()
);
alter table public.reply_feedback enable row level security;
-- No select policy: service role only, same posture as model_providers.
-- (inbound_messages additionally grants app roles select+insert; add grants
-- here only when an app role genuinely needs them.)
create index if not exists reply_feedback_biz_idx
  on public.reply_feedback (business_id, created_at desc);

-- 2. doc_embeddings: the retrieval index. At question time the backend pulls
-- the relevant slice of the log and hands it to whatever provider is active.
-- embedding stays null until the embedding job runs; it must use the SAME
-- provider already handling that shop's texts (no new data destination).
create extension if not exists vector;

create table if not exists public.doc_embeddings (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  source_table text not null,   -- 'inbound_messages', 'business_thoughts', 'attachment_fields', ...
  source_id uuid not null,
  chunk_index integer not null default 0,
  chunk_text text not null,
  embedding vector(1536),       -- null until embedded
  embed_model text,             -- which model produced it; re-embed on provider switch
  created_at timestamptz not null default now(),
  unique (source_table, source_id, chunk_index)
);
alter table public.doc_embeddings enable row level security;
create index if not exists doc_embeddings_biz_idx
  on public.doc_embeddings (business_id, source_table);
create index if not exists doc_embeddings_vec_idx
  on public.doc_embeddings using hnsw (embedding vector_cosine_ops)
  where embedding is not null;
-- Retrieval queries must also filter WHERE embedding IS NOT NULL: rows sit
-- unembedded until the embedding job runs, and null vectors must never rank.

-- 3. eval_questions + eval_runs: a small set of real questions with known-right
-- answers, used to grade providers against each other. This becomes the
-- evidence behind any future "route by question type" filter.
create table if not exists public.eval_questions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references public.businesses(id),  -- null = general question
  kind text not null default 'general',  -- question type: schedule, money, cabinet, followup, ...
  question text not null,
  expected_answer text not null,
  source_refs jsonb not null default '[]'::jsonb,  -- rows that ground the right answer
  active boolean not null default true,
  created_by text not null default 'desk',
  created_at timestamptz not null default now()
);
alter table public.eval_questions enable row level security;

create table if not exists public.eval_runs (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.eval_questions(id),
  provider text not null,      -- matches model_providers.name
  model text not null,
  answer text not null,
  score numeric,               -- 0..1
  judge text not null default 'manual',  -- 'manual', 'owner', or a judge model name
  notes text not null default '',
  run_at timestamptz not null default now()
);
alter table public.eval_runs enable row level security;
create index if not exists eval_runs_question_idx
  on public.eval_runs (question_id, run_at desc);
