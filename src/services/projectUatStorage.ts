import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from '../config/env.js';
import { SupabaseTicketDocumentObjectStore } from './supabaseTicketDocumentObjectStore.js';
export function projectUatStorage() {
  return SUPABASE_URL&&SUPABASE_SERVICE_ROLE_KEY?new SupabaseTicketDocumentObjectStore(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY):null;
}
