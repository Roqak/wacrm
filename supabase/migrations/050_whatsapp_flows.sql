-- ============================================================
-- 050_whatsapp_flows.sql — Meta WhatsApp Flows ("WhatsApp Forms")
--
-- WhatsApp Flows are Meta-hosted, multi-screen native forms that open
-- inside the chat. The UI calls them "WhatsApp Forms" because "Flows"
-- already names this app's chatbot builder (migration 010); internally
-- the tables keep Meta's word so API payloads map 1:1.
--
-- What this adds
--
--   whatsapp_flows           Local catalog of the WABA's flows, synced
--                            from Meta (GET /{waba_id}/flows) or created
--                            in-app. Settings-class: members read,
--                            admins write — same as message_templates.
--                            Carries the per-form behaviour this app
--                            layers on top: contact field mappings and
--                            the data-exchange forward URL.
--
--   whatsapp_flow_tokens     One row per send. `flow_token` is the
--                            opaque string Meta echoes back on the
--                            completion webhook (nfm_reply) and on
--                            every data-exchange request, so it is how
--                            a submission finds its account, contact,
--                            conversation and (for chatbot sends) the
--                            suspended run. Written and read by the
--                            server only.
--
--   whatsapp_flow_responses  One row per completed form. Unique on
--                            (account_id, wa_message_id) — Meta retries
--                            webhook deliveries, and a replay must not
--                            record the submission twice.
--
--   messages.flow_response   The submitted fields on the inbound
--                            message row, so the inbox renders the
--                            "form submitted" card from the thread
--                            query it already runs (no extra fetch).
--
--   whatsapp_config.flows_*  The RSA keypair for data-exchange
--                            endpoints. Meta encrypts every endpoint
--                            request with the business public key; the
--                            private key decrypts it. Stored encrypted
--                            with the same app key as access_token.
--
--   flow_nodes 'send_form'   Chatbot node that sends a form and
--                            suspends the run until it is submitted.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- 1. whatsapp_flows
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_flows (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id            uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Audit only (who synced / created it). Tenancy is account_id.
  user_id               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  meta_flow_id          text NOT NULL,
  name                  text NOT NULL,
  status                text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'PUBLISHED', 'DEPRECATED', 'BLOCKED', 'THROTTLED')),
  categories            text[] NOT NULL DEFAULT '{}',
  -- The Flow JSON definition (screens, layout, routing). Null until
  -- fetched — Meta serves it as a downloadable asset, not a field.
  flow_json             jsonb,
  json_version          text,
  data_api_version      text,
  endpoint_uri          text,
  validation_errors     jsonb,
  -- Screen a "navigate" send opens on. Defaults to the definition's
  -- first screen when null.
  first_screen          text,
  -- [{ "field": "<response key>", "target": "name" | "email" |
  --    "company" | "custom:<custom_field_id>" }]
  field_mappings        jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Data-exchange requests are decrypted and POSTed here as plain
  -- JSON (signed like outbound webhooks); the JSON answer is
  -- encrypted back to Meta. Null → the endpoint answers INIT with
  -- `first_screen` and rejects other actions.
  endpoint_forward_url  text,
  -- HMAC key for the forwarded request's X-Wacrm-Signature header,
  -- encrypted with the app key (same scheme as access_token).
  endpoint_forward_secret text,
  synced_at             timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_flows_account_meta_key UNIQUE (account_id, meta_flow_id)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_flows_account
  ON whatsapp_flows(account_id, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_flows TO authenticated, service_role;

ALTER TABLE whatsapp_flows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_flows_select ON whatsapp_flows;
CREATE POLICY whatsapp_flows_select ON whatsapp_flows FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS whatsapp_flows_insert ON whatsapp_flows;
CREATE POLICY whatsapp_flows_insert ON whatsapp_flows FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS whatsapp_flows_update ON whatsapp_flows;
CREATE POLICY whatsapp_flows_update ON whatsapp_flows FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS whatsapp_flows_delete ON whatsapp_flows;
CREATE POLICY whatsapp_flows_delete ON whatsapp_flows FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- 2. whatsapp_flow_tokens
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_flow_tokens (
  token            text PRIMARY KEY,
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  flow_id          uuid REFERENCES whatsapp_flows(id) ON DELETE SET NULL,
  meta_flow_id     text,
  contact_id       uuid REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id  uuid REFERENCES conversations(id) ON DELETE SET NULL,
  -- Set when a chatbot `send_form` node issued the token; the
  -- submission resumes this run.
  flow_run_id      uuid REFERENCES flow_runs(id) ON DELETE SET NULL,
  source           text NOT NULL DEFAULT 'inbox'
    CHECK (source IN ('inbox', 'api', 'automation', 'chatbot', 'template', 'broadcast')),
  -- Meta's wamid of the message that carried the form.
  wa_message_id    text,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_flow_tokens_wamid
  ON whatsapp_flow_tokens(wa_message_id) WHERE wa_message_id IS NOT NULL;

-- Server-only: the webhook and the data-exchange endpoint both run on
-- the service-role client. Members read them for diagnostics.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_flow_tokens TO service_role;
GRANT SELECT ON public.whatsapp_flow_tokens TO authenticated;

ALTER TABLE whatsapp_flow_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_flow_tokens_select ON whatsapp_flow_tokens;
CREATE POLICY whatsapp_flow_tokens_select ON whatsapp_flow_tokens FOR SELECT
  USING (is_account_member(account_id));

-- ------------------------------------------------------------
-- 3. whatsapp_flow_responses
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_flow_responses (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  flow_id          uuid REFERENCES whatsapp_flows(id) ON DELETE SET NULL,
  meta_flow_id     text,
  flow_token       text,
  contact_id       uuid REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id  uuid REFERENCES conversations(id) ON DELETE SET NULL,
  message_id       uuid REFERENCES messages(id) ON DELETE SET NULL,
  wa_message_id    text NOT NULL,
  -- Submitted fields, minus Meta's own `flow_token` key.
  response         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_flow_responses_account_wamid_key UNIQUE (account_id, wa_message_id)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_flow_responses_flow
  ON whatsapp_flow_responses(account_id, flow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_flow_responses_contact
  ON whatsapp_flow_responses(contact_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_flow_responses TO service_role;
GRANT SELECT ON public.whatsapp_flow_responses TO authenticated;

ALTER TABLE whatsapp_flow_responses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_flow_responses_select ON whatsapp_flow_responses;
CREATE POLICY whatsapp_flow_responses_select ON whatsapp_flow_responses FOR SELECT
  USING (is_account_member(account_id));

-- ------------------------------------------------------------
-- 4. messages.flow_response
-- ------------------------------------------------------------
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS flow_response jsonb;

-- ------------------------------------------------------------
-- 5. whatsapp_config — data-exchange endpoint keypair
-- ------------------------------------------------------------
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS flows_public_key text,
  ADD COLUMN IF NOT EXISTS flows_private_key text,
  ADD COLUMN IF NOT EXISTS flows_key_uploaded_at timestamptz;

-- ------------------------------------------------------------
-- 6. flow_nodes.node_type — add 'send_form'
-- ------------------------------------------------------------
ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'send_form',
    'collect_input',
    'condition',
    'set_tag',
    'handoff',
    'http_fetch',
    'end'
  ));
