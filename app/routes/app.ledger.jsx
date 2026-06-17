import { unauthenticated } from "../shopify.server";

const API_VERSION = "2026-04";
const TEMPLATE_SUFFIX = "theledgerpost";
const DEFAULT_SHOP = "97f908-22.myshopify.com";

/* =========================
   DYNAMIC BLOG ID MAP (Ledger-Cat -> blogId)
========================= */
const BLOG_ID_MAP = {
  "Baby": "100928258280",
  "Beauty": "100928323816",
  "Home": "100928356584",
  "How To": "100928389352",
  "Wellbeing": "100928422120",
};

/* =========================
   METAFIELD HELPER
========================= */
function normalizeUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";

  const candidate = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : "https://" + trimmed;

  try {
    const url = new URL(candidate);
    return url.href;
  } catch {
    console.warn(`[metafield] Skipping invalid URL value: ${trimmed}`);
    return "";
  }
}

function mf(namespace, key, type, value) {
  if (!value || String(value).trim() === "") return null;
  const finalValue = type === "url" ? normalizeUrl(value) : String(value);
  if (!finalValue) return null;
  return { namespace, key, type, value: finalValue };
}

/* =========================
   SHOP DETECTION (UNCHANGED)
========================= */
function detectShop(request, payload) {
  const url = new URL(request.url);

  let shop =
    payload?.shop ||
    payload?.shopDomain ||
    url.searchParams.get("shop") ||
    request.headers.get("x-shopify-shop-domain") ||
    process.env.SHOP ||
    DEFAULT_SHOP;

  shop = shop.trim().toLowerCase();

  if (!shop.includes(".myshopify.com")) {
    shop += ".myshopify.com";
  }

  console.log("✅ FINAL SHOP USED:", shop);
  return shop;
}

/* =========================
   ACTION
========================= */
export async function action({ request }) {
  console.log("=======================================");
  console.log("🚀 BLOG ACTION STARTED");
  console.log("=======================================");

  try {
    const payload = await request.json();
    console.log("📦 FULL PAYLOAD:", JSON.stringify(payload, null, 2));

    const { data } = payload;

    if (!data) {
      return new Response(JSON.stringify({ error: "Data missing" }), { status: 400 });
    }

    const blogTitle = data.firstName || "Untitled Blog";
    const blogDescription = data.message || "<p>No content</p>";
    const author = data.Author || "Lorissa Violet";
    const visibility = data.Visibility;

    // ----------------------
    // Ledger-Cat dynamic blog ID
    // ----------------------
    const ledgerCategory = String(data["Ledger-Cat"] || "").trim();
    const BLOG_ID = BLOG_ID_MAP[ledgerCategory];

    if (!BLOG_ID) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "No blog mapped for Ledger-Cat: " + ledgerCategory,
          availableCategories: Object.keys(BLOG_ID_MAP),
        }),
        { status: 400 }
      );
    }

    console.log("📂 LEDGER CATEGORY:", ledgerCategory);
    console.log("🆔 BLOG ID USED:", BLOG_ID);

    // ----------------------
    // Shopify session
    // ----------------------
    const shop = detectShop(request, payload);
    const { session } = await unauthenticated.admin(shop);

    if (!session?.accessToken) {
      return new Response(JSON.stringify({ error: "Invalid session" }), { status: 401 });
    }

    const base = `https://${shop}/admin/api/${API_VERSION}`;

    // ----------------------
    // CREATE ARTICLE
    // ----------------------
    const createRes = await fetch(
      `${base}/blogs/${BLOG_ID}/articles.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": session.accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          article: {
            title: blogTitle,
            author,
            body_html: blogDescription,
            published: String(visibility).toLowerCase() !== "hidden",
            template_suffix: TEMPLATE_SUFFIX,
          },
        }),
      }
    );

    const createJson = await createRes.json();
    console.log("📝 ARTICLE STATUS:", createRes.status, createJson);

    if (!createRes.ok || !createJson?.article?.id) {
      return new Response(JSON.stringify(createJson), { status: 400 });
    }

    const articleId = createJson.article.id;
    console.log("🎉 ARTICLE CREATED:", articleId);

    // ----------------------
    // METAFIELDS
    // ----------------------
    const metafields = [

      /* PRODUCTS */
      mf("custom","product_1_name","single_line_text_field",data.text),
      mf("custom","product_1_url","url",data["text-2"]),
      mf("custom","product_1_desc","multi_line_text_field",data.textarea),

      mf("custom","product_2_name","single_line_text_field",data.fullName),
      mf("custom","product_2_url","url",data["text-3"]),
      mf("custom","product_2_desc","multi_line_text_field",data["textarea-2"]),

      mf("custom","product_3_name","single_line_text_field",data["fullName-2"]),
      mf("custom","product_3_url","url",data["text-4"]),
      mf("custom","product_3_desc","multi_line_text_field",data["textarea-3"]),

      mf("custom","product_4_name","single_line_text_field",data["fullName-3"]),
      mf("custom","product_4_url","url",data["text-5"]),
      mf("custom","product_4_desc","multi_line_text_field",data["textarea-4"]),

      mf("custom","product_5_name","single_line_text_field",data["fullName-4"]),
      mf("custom","product_5_url","url",data["text-6"]),
      mf("custom","product_5_desc","multi_line_text_field",data["textarea-5"]),

      /* PROVIDERS */
      mf("custom","provider_1_name","single_line_text_field",data["fullName-5"]),
      mf("custom","provider_1_url","url",data["text-7"]),
      mf("custom","provider_1_phone","single_line_text_field",data.phone),
      mf("custom","provider_1_email","single_line_text_field",data.email),
      mf("custom","provider_1_desc","multi_line_text_field",data["textarea-6"]),

      mf("custom","provider_2_name","single_line_text_field",data["fullName-6"]),
      mf("custom","provider_2_url","url",data["text-8"]),
      mf("custom","provider_2_phone","single_line_text_field",data["phone-2"]),
      mf("custom","provider_2_email","single_line_text_field",data["email-2"]),
      mf("custom","provider_2_desc","multi_line_text_field",data["textarea-7"]),

      mf("custom","provider_3_name","single_line_text_field",data["fullName-7"]),
      mf("custom","provider_3_url","url",data["text-9"]),
      mf("custom","provider_3_phone","single_line_text_field",data["phone-3"]),
      mf("custom","provider_3_email","single_line_text_field",data["email-3"]),
      mf("custom","provider_3_desc","multi_line_text_field",data["textarea-8"]),

      mf("custom","provider_4_name","single_line_text_field",data["fullName-8"]),
      mf("custom","provider_4_url","url",data["text-10"]),
      mf("custom","provider_4_phone","single_line_text_field",data["phone-4"]),
      mf("custom","provider_4_email","single_line_text_field",data["email-4"]),
      mf("custom","provider_4_desc","multi_line_text_field",data["textarea-9"]),

      mf("custom","provider_5_name","single_line_text_field",data["fullName-9"]),
      mf("custom","provider_5_url","url",data["text-11"]),
      mf("custom","provider_5_phone","single_line_text_field",data["phone-5"]),
      mf("custom","provider_5_email","single_line_text_field",data["email-5"]),
      mf("custom","provider_5_desc","multi_line_text_field",data["textarea-10"]),

    ].filter(Boolean);

    console.log("📊 TOTAL METAFIELDS:", metafields.length);

    // ----------------------
    // SAVE METAFIELDS
    // ----------------------
    for (const m of metafields) {
      const mfRes = await fetch(
        `${base}/articles/${articleId}/metafields.json`,
        {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": session.accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ metafield: m }),
        }
      );

      const mfJson = await mfRes.json();
      console.log("➡", m.key, mfRes.status, mfJson);

      if (!mfRes.ok) {
        console.log("❌ FAILED:", m.key);
      } else {
        console.log("✅ SAVED:", m.key);
      }
    }

    console.log("🔥 BLOG PROCESS COMPLETED SUCCESSFULLY");

    return new Response(
      JSON.stringify({ success: true, articleId, ledgerCategory, blogId: BLOG_ID }),
      { status: 200 }
    );

  } catch (error) {
    console.log("💥 GLOBAL ERROR:", error);
    return new Response(
      JSON.stringify({ success: false, error: String(error) }),
      { status: 500 }
    );
  }
}
