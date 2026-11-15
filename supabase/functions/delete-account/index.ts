// EX_23 — deletes the calling user's account. verify_jwt = true (config.toml) and the wrapper's 'user' mode both
// require a valid user access token (added by supabase.functions.invoke). lists, inventory_items and sync_devices
// cascade from auth.users. Never logs the request or any key. Not executed locally (no Deno / Docker).
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    if (req.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
    const userId = ctx.userClaims?.id;
    if (!userId) return Response.json({ error: "delete_failed" }, { status: 500 });
    const { error } = await ctx.supabaseAdmin.auth.admin.deleteUser(userId);
    return error ? Response.json({ error: "delete_failed" }, { status: 500 }) : Response.json({ ok: true });
  }),
};
