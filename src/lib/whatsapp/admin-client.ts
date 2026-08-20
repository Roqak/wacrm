import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client for WhatsApp server paths.
// Mirrors src/lib/flows/admin-client.ts and src/lib/ai/admin-client.ts —
// same shape so anyone reading any of them picks up the convention
// immediately.
//
// Used by the call signalling routes, which authorize the caller under
// their own RLS first and then need to write rows (`calls`) that have no
// client-writable policy at all.
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}
