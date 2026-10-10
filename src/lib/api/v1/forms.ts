// ============================================================
// Public API (v1) projection of WhatsApp Forms (Meta Flows) and their
// submissions. The wire shape is explicit — adding a column to
// `whatsapp_flows` must not leak it (notably the encrypted forward
// secret). Add a public field here AND to the OpenAPI schema.
// ============================================================

export const FORM_SELECT =
  'id, meta_flow_id, name, status, categories, first_screen, field_mappings, flow_json, created_at, updated_at';

export const FORM_RESPONSE_SELECT =
  'id, flow_id, meta_flow_id, contact_id, conversation_id, wa_message_id, response, created_at';

export function serializeForm(row: Record<string, unknown>) {
  return {
    id: row.id,
    meta_flow_id: row.meta_flow_id,
    name: row.name,
    status: row.status,
    categories: row.categories ?? [],
    first_screen: row.first_screen ?? null,
    field_mappings: row.field_mappings ?? [],
    definition: row.flow_json ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function serializeFormResponse(row: Record<string, unknown>) {
  return {
    id: row.id,
    form_id: row.flow_id ?? null,
    meta_flow_id: row.meta_flow_id ?? null,
    contact_id: row.contact_id ?? null,
    conversation_id: row.conversation_id ?? null,
    whatsapp_message_id: row.wa_message_id,
    response: row.response ?? {},
    created_at: row.created_at,
  };
}
