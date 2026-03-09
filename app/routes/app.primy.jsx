import { unauthenticated } from "../shopify.server";

const API_VERSION = "2026-01";
const TEMPLATE_SUFFIX = "thelistpost";

/* ---------------------------
   Dynamic Blog IDs (main-cat -> blogId)
---------------------------- */
const BLOG_ID_MAP = {
  Restaurants: "100939989224",
  Shopping: "100752425192",
  "Health & Wellness": "100765925608",
  "Beauty & Spa": "100765958376",
  "Home Services": "100765991144",
  "Local Services": "100766023912",
  "Event Planning": "100766056680",
  "Professional Services": "100766089448",
  Automotive: "100766122216",
};

/* ---------------------------
   Helpers
---------------------------- */
function mf(namespace, key, type, value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return { namespace, key, type, value: String(value) };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getDomainFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * Shopify tags safe builder (keeps spaces inside tag)
 * - "Traditional Chinese Med" => stays as one tag
 * - If comma separated => multiple tags
 */
function buildTags(value) {
  const raw = Array.isArray(value) ? value.join(",") : String(value || "");

  const normalized = raw
    .replace(/\u00A0/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!normalized) return "";

  // Shopify expects tags as comma-separated string
  const tags = normalized
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  return tags.join(", ");
}

/**
 * ✅ Dynamic subcategory finder (debug only)
 * - data me jo bhi key "sub-cat" se start hoti ho
 * - uska first non-empty value return
 * - returns { key, value }
 */
function pickSubCategory(data) {
  if (!data || typeof data !== "object") return { key: "", value: "" };

  // Prefer known keys first if present (fixed list)
  const preferred = [
    "sub-cat1-2",
    "sub-cat2",
    "sub-cat3",
    "sub-cat4",
    "sub-cat5",
    "sub-cat6",
    "sub-cat7",
    "sub-cat8",
    "sub-cat9",
    "sub-cat10",
    "sub-cat9-2",
    "sub-cat9-3",
    "sub-cat9-4",
  ];

  for (const k of preferred) {
    const v = data[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      return { key: k, value: String(v).trim() };
    }
  }

  // Otherwise: ANY key that starts with "sub-cat"
  const subKeys = Object.keys(data).filter((k) => k.toLowerCase().startsWith("sub-cat"));

  for (const k of subKeys) {
    const v = data[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      return { key: k, value: String(v).trim() };
    }
  }

  return { key: "", value: "" };
}

/**
 * ✅ Get tag values from exact keys (keeps order), removes duplicates (case-insensitive)
 */
function pickTagsFromKeys(data, keys = []) {
  if (!data || typeof data !== "object") return [];

  const vals = keys
    .map((k) => data[k])
    .filter((v) => v !== undefined && v !== null && String(v).trim() !== "")
    .map((v) => String(v).trim());

  const seen = new Set();
  return vals.filter((v) => {
    const key = v.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * ✅ NEW: Collect ALL sub-cat* values into tags
 * - First: use ordered keys you care about (sub-cat2...sub-cat10 + sub-cat9-2/3/4)
 * - Then: add any other sub-cat* keys automatically (future proof)
 * - Dedup case-insensitive
 */
function pickAllSubCatTags(data) {
  if (!data || typeof data !== "object") return [];

  // Your required keys (ordered)
  const orderedKeys = [
    "sub-cat2",
    "sub-cat3",
    "sub-cat4",
    "sub-cat5",
    "sub-cat6",
    "sub-cat7",
    "sub-cat8",
    "sub-cat9",
    "sub-cat10",
    "sub-cat9-2",
    "sub-cat9-3",
    "sub-cat9-4",
  ];

  const pickedOrdered = pickTagsFromKeys(data, orderedKeys);

  // auto-pick any other sub-cat* keys not in ordered list
  const orderedSet = new Set(orderedKeys.map((k) => k.toLowerCase()));
  const otherKeys = Object.keys(data)
    .filter((k) => k && k.toLowerCase().startsWith("sub-cat"))
    .filter((k) => !orderedSet.has(k.toLowerCase()));

  const pickedOther = pickTagsFromKeys(data, otherKeys);

  // merge + dedupe again (to be safe)
  const merged = [...pickedOrdered, ...pickedOther];
  const seen = new Set();
  return merged.filter((v) => {
    const key = String(v).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function resolveMyshopifyFromCustomDomain(customDomain, rid) {
  const metaUrl = "https://" + customDomain + "/meta.json";
  const res = await fetch(metaUrl, { method: "GET", headers: { Accept: "application/json" } });
  const txt = await res.text();
  const json = safeJsonParse(txt);
  if (!res.ok || !json?.myshopify_domain) return "";
  return json.myshopify_domain;
}

function pickShopDomainFromPayload(payload, request) {
  const url = new URL(request.url);
  const meta = payload?.metadata || {};

  return (
    payload?.shop ||
    payload?.shopDomain ||
    meta?.shop ||
    meta?.shopDomain ||
    meta?.store ||
    meta?.storeDomain ||
    url.searchParams.get("shop") ||
    request.headers.get("x-shopify-shop-domain") ||
    request.headers.get("x-shop-domain") ||
    request.headers.get("shop") ||
    ""
  );
}

/* ---------------------------
   Shopify GraphQL
---------------------------- */
async function shopifyGraphql({ base, token, query, variables }) {
  const res = await fetch(base + "/graphql.json", {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
  return { ok: res.ok, status: res.status, json };
}

/* ---------------------------
   STAGED UPLOAD FLOW
---------------------------- */
async function primyUrlToFile({ base, token, url, filename, mimeType, label }) {
  const result = { fileId: "", resourceUrl: "", error: "" };
  if (!url) return result;

  // 1) Download from Primy
  const dlRes = await fetch(url, { method: "GET" });
  const dlBuf = await dlRes.arrayBuffer();

  if (!dlRes.ok || !dlBuf?.byteLength) {
    result.error = "Primy download failed (" + dlRes.status + ")";
    return result;
  }

  const finalMime = mimeType || dlRes.headers.get("content-type") || "image/jpeg";
  const finalName = filename || label + ".jpg";

  // 2) stagedUploadsCreate
  const stagedMutation = `#graphql
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }`;

  const stagedResp = await shopifyGraphql({
    base,
    token,
    query: stagedMutation,
    variables: {
      input: [
        {
          resource: "IMAGE",
          filename: finalName,
          mimeType: finalMime,
          httpMethod: "POST",
        },
      ],
    },
  });

  const stagedErrors = stagedResp.json?.data?.stagedUploadsCreate?.userErrors || [];
  const target = stagedResp.json?.data?.stagedUploadsCreate?.stagedTargets?.[0];

  if (!stagedResp.ok || stagedErrors.length || !target?.url || !target?.resourceUrl) {
    result.error = stagedErrors?.[0]?.message || "stagedUploadsCreate failed";
    return result;
  }

  // 3) Upload to staged target
  const form = new FormData();
  for (const p of target.parameters || []) form.append(p.name, p.value);

  const blob = new Blob([dlBuf], { type: finalMime });
  form.append("file", blob, finalName);

  const upRes = await fetch(target.url, { method: "POST", body: form });
  if (!upRes.ok) {
    result.error = "staged upload failed (" + upRes.status + ")";
    return result;
  }

  // 4) fileCreate
  const fileCreateMutation = `#graphql
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files { id fileStatus }
        userErrors { field message }
      }
    }`;

  const createResp = await shopifyGraphql({
    base,
    token,
    query: fileCreateMutation,
    variables: {
      files: [{ contentType: "IMAGE", originalSource: target.resourceUrl, alt: label }],
    },
  });

  const createErrors = createResp.json?.data?.fileCreate?.userErrors || [];
  const file = createResp.json?.data?.fileCreate?.files?.[0];

  if (createResp.json?.errors?.length) {
    result.error = createResp.json.errors?.[0]?.message || "fileCreate top-level error";
    result.resourceUrl = target.resourceUrl;
    return result;
  }

  if (!createResp.ok || createErrors.length || !file?.id) {
    result.error = createErrors?.[0]?.message || "fileCreate failed";
    result.resourceUrl = target.resourceUrl;
    return result;
  }

  result.fileId = file.id;
  result.resourceUrl = target.resourceUrl;
  return result;
}

/* ---------------------------
   Action
---------------------------- */
export async function action({ request }) {
  const rid = Date.now() + "-" + Math.random().toString(16).slice(2);

  try {
    const raw = await request.text();
    const payload = safeJsonParse(raw);

    if (!payload) {
      return new Response(JSON.stringify({ success: false, rid, message: "Invalid JSON body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 1) Resolve shop domain
    let shop = pickShopDomainFromPayload(payload, request);

    if (!shop) {
      const pageUrl = payload?.metadata?.pageUrl || payload?.metadata?.page?.url || "";
      const customDomain = getDomainFromUrl(pageUrl);
      if (customDomain) shop = await resolveMyshopifyFromCustomDomain(customDomain, rid);
    }

    if (!shop) {
      return new Response(JSON.stringify({ success: false, rid, message: "Shop domain not found" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 2) Offline session
    const { session } = await unauthenticated.admin(shop);
    if (!session?.accessToken) {
      return new Response(JSON.stringify({ success: false, rid, message: "No offline access token found", shop }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const base = "https://" + session.shop + "/admin/api/" + API_VERSION;

    // 3) Primy mapping
    const { entryId, documentId, data = {}, attachments = {} } = payload;

    console.log(data);

    const author = data.Author;
    const visibility = data.Visibility;

    const mainCategory = String(data["main-cat"] || "").trim();

    // debug only
    const picked = pickSubCategory(data);
    const subCategory = picked.value;
    const subCatPickedKey = picked.key;

    const blogId = BLOG_ID_MAP[mainCategory];

    if (!blogId) {
      return new Response(
        JSON.stringify({
          success: false,
          rid,
          message: "No blog mapped for main category: " + mainCategory,
          availableCategories: Object.keys(BLOG_ID_MAP),
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const firstName = data.firstName;
    const years_in_bussiness = data.lastName;
    const bussiness_name = data.text;
    const email = data.email;
    const phone = data.phone;
    const website_url = data.website;

    const url_display = data["text-2"];
    const discount = data["text-3"];
    const content = data.message;
    const service_area = data["text-4"];
    const Notes = data.textarea;

    const logoFile = attachments?.["logo-file"] || [];
    const gallery1 = attachments?.["gal-1"] || [];
    const gallery2 = attachments?.["gal-2"] || [];
    const gallery3 = attachments?.["gal-3"] || [];

    // Upload files
    const logoUp = await primyUrlToFile({
      base,
      token: session.accessToken,
      url: logoFile?.[0]?.url || "",
      filename: logoFile?.[0]?.filename || "logo.jpg",
      mimeType: logoFile?.[0]?.mimetype || "image/jpeg",
      label: "logo",
    });

    const g1 = await primyUrlToFile({
      base,
      token: session.accessToken,
      url: gallery1?.[0]?.url || "",
      filename: gallery1?.[0]?.filename || "gallery1.jpg",
      mimeType: gallery1?.[0]?.mimetype || "image/jpeg",
      label: "galleryimg1",
    });

    const g2 = await primyUrlToFile({
      base,
      token: session.accessToken,
      url: gallery2?.[0]?.url || "",
      filename: gallery2?.[0]?.filename || "gallery2.jpg",
      mimeType: gallery2?.[0]?.mimetype || "image/jpeg",
      label: "galleryimg2",
    });

    const g3 = await primyUrlToFile({
      base,
      token: session.accessToken,
      url: gallery3?.[0]?.url || "",
      filename: gallery3?.[0]?.filename || "galleryimg3.jpg",
      mimeType: gallery3?.[0]?.mimetype || "image/jpeg",
      label: "galleryimg3",
    });

    const featuredImageSrc = logoUp.resourceUrl || logoFile?.[0]?.url || "";

    /* ✅ FINAL TAG MAPPING (WHAT YOU ASKED)
       - sub-cat2...sub-cat10
       - sub-cat9-2, sub-cat9-3, sub-cat9-4
       - AND auto includes any other "sub-cat*" keys too (future proof)
    */
    const tagValues = pickAllSubCatTags(data);
    const finalTags = buildTags(tagValues);

    // 4) Create article
    const createRes = await fetch(base + "/blogs/" + blogId + "/articles.json", {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": session.accessToken,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        article: {
          title: bussiness_name || "New Article Title",
          author: author || "Test User",
          handle: (bussiness_name || "new-article-title")
            .toLowerCase()
            .replace(/\s+/g, "-")
            .replace(/[^a-z0-9-]/g, ""),
          body_html: content || "",
          summary_html: Notes || "",
          published: false,
          tags: finalTags,
          template_suffix: TEMPLATE_SUFFIX,
          ...(featuredImageSrc ? { image: { src: featuredImageSrc, alt: bussiness_name || "logo" } } : {}),
        },
      }),
    });

    const createText = await createRes.text();
    const createJson = safeJsonParse(createText);

    if (!createRes.ok) {
      return new Response(
        JSON.stringify({
          success: false,
          rid,
          step: "createArticle",
          status: createRes.status,
          response: createJson || createText,
          sentTags: finalTags,
          tagValues,
          subCatPickedKey,
          rawSubCategory: subCategory,
        }),
        { status: createRes.status, headers: { "Content-Type": "application/json" } }
      );
    }

    const articleId = createJson?.article?.id;
    if (!articleId) {
      return new Response(JSON.stringify({ success: false, rid, message: "Missing articleId", response: createJson }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 5) Metafields
    const metafields = [
      mf("custom", "years", "single_line_text_field", years_in_bussiness),
      mf("custom", "fullname", "single_line_text_field", firstName),
      mf("custom", "email", "single_line_text_field", email),
      mf("custom", "phone", "single_line_text_field", phone),
      mf("custom", "websitedisplay", "single_line_text_field", url_display),
      mf("custom", "url", "url", website_url),
      mf("custom", "discountcode", "single_line_text_field", discount),
      mf("custom", "servicesareas", "single_line_text_field", service_area),
      mf("custom", "notes", "single_line_text_field", Notes),

      mf("custom", "logo", "file_reference", logoUp.fileId),
      mf("custom", "galleryimg1", "file_reference", g1.fileId),
      mf("custom", "galleryimg2", "file_reference", g2.fileId),
      mf("custom", "galleryimg3", "file_reference", g3.fileId),
    ].filter(Boolean);

    const results = [];
    for (const m of metafields) {
      const mfRes = await fetch(base + "/articles/" + articleId + "/metafields.json", {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": session.accessToken,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ metafield: m }),
      });

      const mfText = await mfRes.text();
      const mfJson = safeJsonParse(mfText);

      results.push({
        key: m.key,
        ok: mfRes.ok,
        status: mfRes.status,
        response: mfJson || mfText,
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        rid,
        shop,
        entryId,
        documentId,
        blogId,
        mainCategory,

        // debug
        subCategory,
        subCatPickedKey,
        tagValues,
        sentTags: finalTags,

        articleId,
        logoUpload: logoUp,
        galleryUpload: { g1, g2, g3 },
        featuredImageSrc,
        metafieldCreateResults: results,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    if (err instanceof Response) return err;

    console.error("[" + rid + "] error", err);
    return new Response(JSON.stringify({ success: false, rid, message: "Server error", error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}