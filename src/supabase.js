import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

if (!globalThis.WebSocket) globalThis.WebSocket = WebSocket;

export const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
