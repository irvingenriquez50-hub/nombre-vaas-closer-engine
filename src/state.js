import { supabase } from "./supabase.js";

export async function getUserEmail(userId) {
  const { data } = await supabase.from("users").select("email").eq("id", userId).maybeSingle();
  return data?.email || null;
}

export async function findLeadByAnyDigits(userId, candidateIdentifiers) {
  const digitsList = candidateIdentifiers
    .filter(Boolean)
    .map((j) => j.replace(/[^0-9]/g, ""))
    .filter((d) => d.length >= 7);
  if (!digitsList.length) return null;

  const { data } = await supabase.from("leads").select("*").eq("user_id", userId).neq("status", "cerrado");
  if (!data) return null;

  for (const lead of data) {
    const leadDigits = (lead.phone || "").replace(/[^0-9]/g, "");
    if (!leadDigits) continue;
    for (const d of digitsList) {
      if (leadDigits.slice(-8) === d.slice(-8)) return lead;
    }
  }
  return null;
}

export async function getLead(userId, jid) {
  const { data } = await supabase.from("leads").select("*").eq("user_id", userId).eq("jid", jid).maybeSingle();
  return data;
}

export async function addLead(userId, phoneRaw) {
  const digits = phoneRaw.replace(/[^0-9]/g, "");
  const jid = digits;
  const existing = await getLead(userId, jid);
  if (existing) return { lead: existing, duplicate: true };

  const { data, error } = await supabase
    .from("leads")
    .insert({ user_id: userId, phone: phoneRaw.trim(), jid, status: "nuevo" })
    .select()
    .single();
  if (error) throw error;
  return { lead: data, duplicate: false };
}

export async function upsertLeadPatch(userId, jid, patch) {
  const { data, error } = await supabase
    .from("leads")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("jid", jid)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function appendMessage(userId, jid, role, content) {
  const lead = await getLead(userId, jid);
  const conversation = [...(lead?.conversation || []), { role, content, ts: Date.now() }];
  return upsertLeadPatch(userId, jid, { conversation });
}

export async function listActiveLeads(userId) {
  const { data } = await supabase
    .from("leads")
    .select("*")
    .eq("user_id", userId)
    .neq("status", "cerrado")
    .neq("status", "dormant")
    .neq("status", "fallido")
    .eq("paused", false);
  return data || [];
}

/** Marca un lead como "fallido" cuando 360dialog/Meta reporta que la entrega del
 * mensaje falló (via el webhook de estados), guardando el motivo exacto para que
 * se pueda ver y reintentar desde la pestaña "Fallidos" del panel. Solo se marca
 * si el lead sigue en un estado de "esperando respuesta" — si ya contestó o ya
 * se cerró, no se toca (para no pisar una conversación real en curso). */
export async function markLeadFailed(userId, jidDigits, errorMsg) {
  const { data } = await supabase
    .from("leads")
    .select("*")
    .eq("user_id", userId)
    .neq("status", "cerrado");
  if (!data) return null;

  const lead = data.find((l) => (l.jid || "").replace(/[^0-9]/g, "").slice(-8) === jidDigits.slice(-8));
  if (!lead) return null;
  if (!["nuevo", "escrito_enviado"].includes(lead.status)) return null;

  return upsertLeadPatch(userId, lead.jid, { status: "fallido", last_error: errorMsg });
}

export async function logClosedDeal(userId, deal) {
  const { data: lead } = await supabase
    .from("leads")
    .select("id")
    .eq("user_id", userId)
    .eq("jid", deal.jid)
    .maybeSingle();

  await supabase.from("closed_deals").insert({
    user_id: userId,
    lead_id: lead?.id || null,
    phone: deal.phone,
    price: deal.price,
    videos: deal.videos,
  });
}

export async function getScript(userId) {
  const { data } = await supabase.from("scripts").select("*").eq("user_id", userId).maybeSingle();
  return {
    message1: data?.message1 || "",
    message2: data?.message2 || "Your number was recommended in the VAAS community for pay collab.",
    gmvTotal: data?.gmv_total || "",
    market: data?.market || "Spanish-speaking",
    shortName: data?.short_name || "",
    gmv30d: data?.gmv_30d || "",
    tiktokHandle: data?.tiktok_handle || "",
  };
}

export async function getPricingTiers(userId) {
  const { data } = await supabase.from("pricing_tiers").select("videos,anchor,medio,floor").eq("user_id", userId);
  return (data || []).map((t) => ({
    videos: t.videos,
    anchor: t.anchor,
    medio: t.medio != null ? Number(t.medio) : null,
    floor: t.floor,
  }));
}

export async function setBotSession(userId, patch) {
  await supabase.from("bot_sessions").upsert({ user_id: userId, ...patch });
}
