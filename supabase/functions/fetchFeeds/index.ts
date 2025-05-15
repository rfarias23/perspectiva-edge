/**
 * Edge Function: fetchFeeds
 * ------------------------------------------------------------
 * Recorre los RSS de la tabla `sources`, inserta artículos nuevos
 * en `articles` y guarda su embedding en `embeddings`.
 * Usa la SDK nativa de Deno para OpenAI (https://deno.land/x/openai)
 * ------------------------------------------------------------
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42";
import OpenAI from "https://deno.land/x/openai@v4.14.1/mod.ts";
import Parser       from "https://esm.sh/rss-parser@3.13";

// ──────────────────────────────────────────────────────────

Deno.serve( async () => {
  /* 1. Conexión Supabase (service-role) */
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  /* 2. Cliente OpenAI */
  const openai = new OpenAI({
    apiKey: Deno.env.get("OPENAI_API_KEY")!,
  });

  /* 3. Fuentes RSS */
  const { data: sources, error } = await supabase
    .from("sources")
    .select("id,name,url,bias_label,country");

  if (error) {
    console.error("Reading sources:", error);
    return new Response("Failed to read sources", { status: 500 });
  }

  const parser   = new Parser();
  let   inserted = 0;

  /* 4. Procesa cada fuente (en serie para no saturar) */
  for (const src of sources) {
    try {
      const feed = await parser.parseURL(src.url);

      for (const item of feed.items) {
        /* 4.1 Salta si el artículo ya existe */
        const { data: exists } = await supabase
          .from("articles")
          .select("id")
          .eq("url", item.link!)
          .maybeSingle();

        if (exists) continue;

        /* 4.2 Inserta artículo */
        const { data: art, error: artErr } = await supabase
          .from("articles")
          .insert({
            source_id:  src.id,
            title:      item.title,
            url:        item.link,
            published_at: item.pubDate ? new Date(item.pubDate) : new Date(),
            content:    item.contentSnippet ?? "",
            bias:       src.bias_label,
          })
          .select("id")
          .single();

        if (artErr) throw artErr;

        /* 4.3 Embedding (≤ 8 k tokens aprox.) */
        const text  = (item.contentSnippet ?? "").slice(0, 4000);
        const emb   = await openai.embeddings.create({
          model: "text-embedding-ada-002",
          input: text,
        });

        const vector = emb.data[0].embedding;

        /* 4.4 Guarda embedding */
        await supabase.from("embeddings").insert({
          article_id: art.id,
          embedding:  vector,
        });

        inserted++;
      }
    } catch (e) {
      /* Continúa con la siguiente fuente si falla esta */
      console.error(`Feed ${src.name} error:`, e);
    }
  }

  return new Response(`Sync done. Articles inserted: ${inserted}`);
});