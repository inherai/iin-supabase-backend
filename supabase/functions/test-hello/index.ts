import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

serve(async (req) => {
    console.log("✅ Test function reached Supabase!");
    
    return new Response(
        JSON.stringify({
            status: "success",
            message: "Hello from Supabase Edge Function!",
            timestamp: new Date().toISOString(),
        }),
        {
            status: 200,
            headers: { "Content-Type": "application/json" }
        }
    );
});
