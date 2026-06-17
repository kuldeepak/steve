import { unauthenticated } from "../shopify.server";

const API_VERSION = "2026-04";

/* ---------------------------
   Dynamic Blog IDs (main-cat -> blogId)
---------------------------- */
const BLOG_ID_MAP = {
  "Restaurants": "100939989224",
  "Shopping": "100752425192",
  "Health & Wellness": "100765925608",
  "Beauty & Spa": "100765958376",
  "Home Services": "100765991144",
  "Local Services": "100766023912",
  "Event Planning": "100766056680",
  "Professional Services": "100766089448",
  "Automotive": "100766122216",
};

/* ---------------------------
   Helpers
---------------------------- */
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
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const finalValue = type === "url" ? normalizeUrl(value) : String(value);
  if (!finalValue) return null;
  return { namespace, key, type, value: finalValue };
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


function buildTagsFromData(data) {
  const tagKeys = [
    "tag1","tag2","tag3","tag4","tag5","tag6",
    "tag7","tag8","tag9","tag10","tag11","tag12",
  ];

  const tags = tagKeys
    .map((k) => String(data[k] || "").trim())
    .filter(Boolean);

  console.log("🏷️ [buildTagsFromData] Collected tags:", tags);
  return tags.join(", ");
}


function resolveTemplateSuffix(mainCategory, themeField) {
  if (String(mainCategory).trim() === "Restaurants") {
    return "therestaurantpost";
  }
  return String(themeField || "thelistpost").trim();
}

async function resolveMyshopifyFromCustomDomain(customDomain, rid) {
  console.log(`[${rid}] 🌐 Resolving myshopify domain from custom domain: ${customDomain}`);
  const metaUrl = "https://" + customDomain + "/meta.json";
  const res = await fetch(metaUrl, { method: "GET", headers: { Accept: "application/json" } });
  const txt = await res.text();
  const json = safeJsonParse(txt);
  console.log(`[${rid}] 🌐 meta.json response status: ${res.status}`, json);
  if (!res.ok || !json?.myshopify_domain) {
    console.warn(`[${rid}] ⚠️ Could not resolve myshopify domain from custom domain: ${customDomain}`);
    return "";
  }
  console.log(`[${rid}] ✅ Resolved myshopify domain: ${json.myshopify_domain}`);
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
  console.log(`\n📁 [primyUrlToFile] Starting upload for label="${label}", url="${url}"`);
  const result = { fileId: "", resourceUrl: "", error: "" };

  if (!url) {
    console.warn(`📁 [primyUrlToFile] No URL provided for label="${label}", skipping.`);
    return result;
  }

  // 1) Download from Primy
  console.log(`📁 [primyUrlToFile] Downloading file from Primy: ${url}`);
  const dlRes = await fetch(url, { method: "GET" });
  const dlBuf = await dlRes.arrayBuffer();

  console.log(`📁 [primyUrlToFile] Download status: ${dlRes.status}, size: ${dlBuf?.byteLength ?? 0} bytes`);

  if (!dlRes.ok || !dlBuf?.byteLength) {
    result.error = "Primy download failed (" + dlRes.status + ")";
    console.error(`📁 [primyUrlToFile] ❌ ${result.error}`);
    return result;
  }

  const finalMime = mimeType || dlRes.headers.get("content-type") || "image/jpeg";
  const finalName = filename || label + ".jpg";
  console.log(`📁 [primyUrlToFile] Final mime: ${finalMime}, filename: ${finalName}`);

  // 2) stagedUploadsCreate
  console.log(`📁 [primyUrlToFile] Calling stagedUploadsCreate...`);
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

  console.log(`📁 [primyUrlToFile] stagedUploadsCreate response status: ${stagedResp.status}`, JSON.stringify(stagedResp.json, null, 2));

  const stagedErrors = stagedResp.json?.data?.stagedUploadsCreate?.userErrors || [];
  const target = stagedResp.json?.data?.stagedUploadsCreate?.stagedTargets?.[0];

  if (!stagedResp.ok || stagedErrors.length || !target?.url || !target?.resourceUrl) {
    result.error = stagedErrors?.[0]?.message || "stagedUploadsCreate failed";
    console.error(`📁 [primyUrlToFile] ❌ stagedUploadsCreate error: ${result.error}`, stagedErrors);
    return result;
  }

  console.log(`📁 [primyUrlToFile] ✅ Staged target URL: ${target.url}`);
  console.log(`📁 [primyUrlToFile] ✅ Resource URL: ${target.resourceUrl}`);

  // 3) Upload to staged target
  console.log(`📁 [primyUrlToFile] Uploading to staged target...`);
  const form = new FormData();
  for (const p of target.parameters || []) form.append(p.name, p.value);

  const blob = new Blob([dlBuf], { type: finalMime });
  form.append("file", blob, finalName);

  const upRes = await fetch(target.url, { method: "POST", body: form });
  console.log(`📁 [primyUrlToFile] Staged upload response status: ${upRes.status}`);

  if (!upRes.ok) {
    result.error = "staged upload failed (" + upRes.status + ")";
    console.error(`📁 [primyUrlToFile] ❌ ${result.error}`);
    return result;
  }

  console.log(`📁 [primyUrlToFile] ✅ Staged upload successful for label="${label}"`);

  // 4) fileCreate
  console.log(`📁 [primyUrlToFile] Calling fileCreate mutation...`);
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

  console.log(`📁 [primyUrlToFile] fileCreate response status: ${createResp.status}`, JSON.stringify(createResp.json, null, 2));

  const createErrors = createResp.json?.data?.fileCreate?.userErrors || [];
  const file = createResp.json?.data?.fileCreate?.files?.[0];

  if (createResp.json?.errors?.length) {
    result.error = createResp.json.errors?.[0]?.message || "fileCreate top-level error";
    result.resourceUrl = target.resourceUrl;
    console.error(`📁 [primyUrlToFile] ❌ fileCreate top-level error: ${result.error}`);
    return result;
  }

  if (!createResp.ok || createErrors.length || !file?.id) {
    result.error = createErrors?.[0]?.message || "fileCreate failed";
    result.resourceUrl = target.resourceUrl;
    console.error(`📁 [primyUrlToFile] ❌ fileCreate failed: ${result.error}`, createErrors);
    return result;
  }

  result.fileId = file.id;
  result.resourceUrl = target.resourceUrl;
  console.log(`📁 [primyUrlToFile] ✅ File created successfully. fileId: ${file.id}, status: ${file.fileStatus}`);
  return result;
}

/* ---------------------------
   Action
---------------------------- */
export async function action({ request }) {
  const rid = Date.now() + "-" + Math.random().toString(16).slice(2);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`🚀 [${rid}] New request received`);
  console.log(`🚀 [${rid}] Method: ${request.method}, URL: ${request.url}`);

  try {
    const raw = await request.text();
    console.log(`📦 [${rid}] Raw body length: ${raw.length}`);
    console.log(`📦 [${rid}] Raw body preview:`, raw.slice(0, 500));

    const payload = safeJsonParse(raw);

    if (!payload) {
      console.error(`❌ [${rid}] Invalid JSON body`);
      return new Response(JSON.stringify({ success: false, rid, message: "Invalid JSON body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    console.log(`📦 [${rid}] Parsed payload keys:`, Object.keys(payload));

    // 1) Resolve shop domain
    let shop = pickShopDomainFromPayload(payload, request);
    console.log(`🏪 [${rid}] Shop domain from payload: "${shop}"`);

    if (!shop) {
      const pageUrl = payload?.metadata?.pageUrl || payload?.metadata?.page?.url || "";
      console.log(`🏪 [${rid}] Trying to resolve shop from pageUrl: "${pageUrl}"`);
      const customDomain = getDomainFromUrl(pageUrl);
      if (customDomain) shop = await resolveMyshopifyFromCustomDomain(customDomain, rid);
    }

    if (!shop) {
      console.error(`❌ [${rid}] Shop domain not found`);
      return new Response(JSON.stringify({ success: false, rid, message: "Shop domain not found" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    console.log(`🏪 [${rid}] Final shop domain: "${shop}"`);

    // 2) Offline session
    console.log(`🔑 [${rid}] Fetching offline session for shop: ${shop}`);
    const { session } = await unauthenticated.admin(shop);

    if (!session?.accessToken) {
      console.error(`❌ [${rid}] No offline access token found for shop: ${shop}`);
      return new Response(
        JSON.stringify({ success: false, rid, message: "No offline access token found", shop }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    console.log(`🔑 [${rid}] ✅ Session found for shop: ${session.shop}`);

    const base = "https://" + session.shop + "/admin/api/" + API_VERSION;
    console.log(`🔗 [${rid}] Base API URL: ${base}`);

    // 3) Field Mapping (screenshot ke hisaab se)
    const { entryId, documentId, data = {}, attachments = {} } = payload;

    console.log(`\n📋 [${rid}] Full data payload:`, JSON.stringify(data, null, 2));
    console.log(`📋 [${rid}] Attachments keys:`, Object.keys(attachments));

    // -----------------------------------------------
    // ARTICLE LEVEL FIELDS
    // Title        ← data.title
    // Content      ← data.message
    // Excerpt      ← data.message  (same as Content per screenshot)
    // Author       ← data.Author
    // Visibility   ← data.Visibility
    // Blog         ← data["main-cat"]
    // Tags         ← data.tag1 ... data.tag12
    // Theme        ← "therestaurantpost" if Restaurants, else data.theme || "thelistpost"
    // -----------------------------------------------
    const articleTitle  = String(data.title       || "").trim();
    const content       = String(data.message     || "").trim();
    const author        = String(data.Author      || "").trim();
    const visibility    = String(data.Visibility  || "").trim();
    const mainCategory  = String(data["main-cat"] || "").trim();
    const themeFromData = String(data.theme       || "").trim();

    // -----------------------------------------------
    // METAFIELD LEVEL FIELDS (screenshot mapping)
    // Fullname       ← data.firstName     (Primy: First name)
    // Years          ← data.lastName      (Primy: Last name)
    // Email          ← data.email
    // Phone          ← data.phone
    // URL            ← data.website
    // WebsiteDisplay ← data["url display"]
    // DiscountCode   ← data["d-code"]
    // ServicesAreas  ← data.areas
    // Cuisines       ← data.Cuisines
    // OtherCuisine   ← data["Other Cuisine"]
    // Address        ← data.Address
    // Notes          ← REMOVED from form per screenshot — skipped
    // -----------------------------------------------
    const fullname       = String(data.firstName         || "").trim();
    const years          = String(data.lastName          || "").trim();
    const email          = String(data.email             || "").trim();
    const phone          = String(data.phone             || "").trim();
    const websiteUrl     = String(data.website           || "").trim();
    const websiteDisplay = String(data["url display"]    || "").trim();
    const discountCode   = String(data["d-code"]         || "").trim();
    const serviceAreas   = String(data.areas             || "").trim();
    const cuisines       = String(data.Cuisines          || "").trim();
    const otherCuisine   = String(data["Other Cuisine"]  || "").trim();
    const address        = String(data.Address           || "").trim();

    console.log(`\n📝 [${rid}] Mapped article fields:`);
    console.log(`   title          = "${articleTitle}"`);
    console.log(`   content        = "${content}"`);
    console.log(`   author         = "${author}"`);
    console.log(`   visibility     = "${visibility}"`);
    console.log(`   mainCategory   = "${mainCategory}"`);
    console.log(`   themeFromData  = "${themeFromData}"`);

    console.log(`\n📝 [${rid}] Mapped metafield fields:`);
    console.log(`   fullname       = "${fullname}"`);
    console.log(`   years          = "${years}"`);
    console.log(`   email          = "${email}"`);
    console.log(`   phone          = "${phone}"`);
    console.log(`   websiteUrl     = "${websiteUrl}"`);
    console.log(`   websiteDisplay = "${websiteDisplay}"`);
    console.log(`   discountCode   = "${discountCode}"`);
    console.log(`   serviceAreas   = "${serviceAreas}"`);
    console.log(`   cuisines       = "${cuisines}"`);
    console.log(`   otherCuisine   = "${otherCuisine}"`);
    console.log(`   address        = "${address}"`);

    // Blog ID
    const blogId = BLOG_ID_MAP[mainCategory];
    console.log(`🗂️ [${rid}] Mapped blogId: "${blogId}" for category: "${mainCategory}"`);

    if (!blogId) {
      console.error(`❌ [${rid}] No blog mapped for main category: "${mainCategory}"`);
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

    // Tags: tag1 to tag12
    const finalTags = buildTagsFromData(data);
    console.log(`🏷️ [${rid}] Final tags: "${finalTags}"`);

    // Template suffix
    const templateSuffix = resolveTemplateSuffix(mainCategory, themeFromData);
    console.log(`🎨 [${rid}] Template suffix: "${templateSuffix}"`);

    // Attachments
    const logoFile = attachments?.["logo-file"] || [];
    const gallery1 = attachments?.["gal-1"]     || [];
    const gallery2 = attachments?.["gal-2"]     || [];
    const gallery3 = attachments?.["gal-3"]     || [];

    console.log(`\n🖼️ [${rid}] Attachment URLs:`);
    console.log(`   logo    = "${logoFile?.[0]?.url || ""}"`);
    console.log(`   gal-1   = "${gallery1?.[0]?.url || ""}"`);
    console.log(`   gal-2   = "${gallery2?.[0]?.url || ""}"`);
    console.log(`   gal-3   = "${gallery3?.[0]?.url || ""}"`);

    // Upload files (logo + gallery — DO NOT TOUCH)
    console.log(`\n⬆️ [${rid}] Starting file uploads...`);

    const logoUp = await primyUrlToFile({
      base,
      token: session.accessToken,
      url: logoFile?.[0]?.url || "",
      filename: logoFile?.[0]?.filename || "logo.jpg",
      mimeType: logoFile?.[0]?.mimetype || "image/jpeg",
      label: "logo",
    });
    console.log(`🖼️ [${rid}] Logo upload result:`, logoUp);

    const g1 = await primyUrlToFile({
      base,
      token: session.accessToken,
      url: gallery1?.[0]?.url || "",
      filename: gallery1?.[0]?.filename || "gallery1.jpg",
      mimeType: gallery1?.[0]?.mimetype || "image/jpeg",
      label: "galleryimg1",
    });
    console.log(`🖼️ [${rid}] Gallery 1 upload result:`, g1);

    const g2 = await primyUrlToFile({
      base,
      token: session.accessToken,
      url: gallery2?.[0]?.url || "",
      filename: gallery2?.[0]?.filename || "gallery2.jpg",
      mimeType: gallery2?.[0]?.mimetype || "image/jpeg",
      label: "galleryimg2",
    });
    console.log(`🖼️ [${rid}] Gallery 2 upload result:`, g2);

    const g3 = await primyUrlToFile({
      base,
      token: session.accessToken,
      url: gallery3?.[0]?.url || "",
      filename: gallery3?.[0]?.filename || "gallery3.jpg",
      mimeType: gallery3?.[0]?.mimetype || "image/jpeg",
      label: "galleryimg3",
    });
    console.log(`🖼️ [${rid}] Gallery 3 upload result:`, g3);

    const featuredImageSrc = logoUp.resourceUrl || logoFile?.[0]?.url || "";
    console.log(`\n🖼️ [${rid}] Featured image src: "${featuredImageSrc}"`);

    // 4) Create Article
    const handleBase = (articleTitle || "new-article")
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");

    const articlePayload = {
      article: {
        title:           articleTitle || "New Article",
        author:          author       || "Admin",
        handle:          handleBase + "-" + Date.now(),
        body_html:       content,
        summary_html:    content,   // Excerpt = same as Content per screenshot
        published:       false,
        tags:            finalTags,
        template_suffix: templateSuffix,
        ...(featuredImageSrc
          ? { image: { src: featuredImageSrc, alt: articleTitle || "logo" } }
          : {}),
      },
    };

    console.log(`\n📰 [${rid}] Creating article in blog: ${blogId}`);
    console.log(`📰 [${rid}] Article payload:`, JSON.stringify(articlePayload, null, 2));

    const createRes = await fetch(base + "/blogs/" + blogId + "/articles.json", {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": session.accessToken,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(articlePayload),
    });

    const createText = await createRes.text();
    const createJson = safeJsonParse(createText);

    console.log(`📰 [${rid}] Article creation response status: ${createRes.status}`);
    console.log(`📰 [${rid}] Article creation response:`, JSON.stringify(createJson, null, 2));

    if (!createRes.ok) {
      console.error(`❌ [${rid}] Article creation failed`);
      return new Response(
        JSON.stringify({
          success: false,
          rid,
          step: "createArticle",
          status: createRes.status,
          response: createJson || createText,
          sentTags: finalTags,
          templateSuffix,
        }),
        { status: createRes.status, headers: { "Content-Type": "application/json" } }
      );
    }

    const articleId = createJson?.article?.id;
    if (!articleId) {
      console.error(`❌ [${rid}] Missing articleId in response`);
      return new Response(
        JSON.stringify({ success: false, rid, message: "Missing articleId", response: createJson }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    console.log(`✅ [${rid}] Article created successfully! articleId: ${articleId}`);

    // 5) Metafields (screenshot mapping)
    const metafields = [
      mf("custom", "fullname",       "single_line_text_field", fullname),
      mf("custom", "years",          "single_line_text_field", years),
      mf("custom", "email",          "single_line_text_field", email),
      mf("custom", "phone",          "single_line_text_field", phone),
      mf("custom", "url",            "url",                    websiteUrl),
      mf("custom", "websitedisplay", "single_line_text_field", websiteDisplay),
      mf("custom", "discountcode",   "single_line_text_field", discountCode),
      mf("custom", "servicesareas",  "single_line_text_field", serviceAreas),
      mf("custom", "cuisines",       "single_line_text_field", cuisines),
      mf("custom", "othercuisine",   "single_line_text_field", otherCuisine),
      mf("custom", "address",        "single_line_text_field", address),
      // Notes REMOVED from form per screenshot — skipped
      // Images (DO NOT TOUCH)
      mf("custom", "logo",           "file_reference",         logoUp.fileId),
      mf("custom", "galleryimg1",    "file_reference",         g1.fileId),
      mf("custom", "galleryimg2",    "file_reference",         g2.fileId),
      mf("custom", "galleryimg3",    "file_reference",         g3.fileId),
    ].filter(Boolean);

    console.log(`\n🧩 [${rid}] Total metafields to create: ${metafields.length}`);
    console.log(`🧩 [${rid}] Metafield keys:`, metafields.map((m) => m.key));

    const results = [];

    for (const m of metafields) {
      console.log(`\n🧩 [${rid}] Creating metafield: key="${m.key}", type="${m.type}", value="${m.value}"`);

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

      console.log(`🧩 [${rid}] Metafield "${m.key}" → status: ${mfRes.status}, ok: ${mfRes.ok}`);
      if (!mfRes.ok) {
        console.error(`🧩 [${rid}] ❌ Metafield "${m.key}" failed:`, JSON.stringify(mfJson, null, 2));
      } else {
        console.log(`🧩 [${rid}] ✅ Metafield "${m.key}" created. id: ${mfJson?.metafield?.id}`);
      }

      results.push({
        key:      m.key,
        ok:       mfRes.ok,
        status:   mfRes.status,
        response: mfJson || mfText,
      });
    }

    const failedMF = results.filter((r) => !r.ok);
    if (failedMF.length > 0) {
      console.warn(`⚠️ [${rid}] ${failedMF.length} metafield(s) failed:`, failedMF.map((r) => r.key));
    } else {
      console.log(`✅ [${rid}] All ${results.length} metafields created successfully!`);
    }

    const finalResponse = {
      success: true,
      rid,
      shop,
      entryId,
      documentId,
      blogId,
      mainCategory,
      templateSuffix,
      sentTags: finalTags,
      articleId,
      logoUpload:    logoUp,
      galleryUpload: { g1, g2, g3 },
      featuredImageSrc,
      metafieldCreateResults: results,
    };

    console.log(`\n🎉 [${rid}] ✅ All done! Summary:`, JSON.stringify({
      shop,
      blogId,
      mainCategory,
      templateSuffix,
      articleId,
      sentTags: finalTags,
      logoFileId: logoUp.fileId,
      galleryFileIds: [g1.fileId, g2.fileId, g3.fileId],
      totalMetafields: results.length,
      failedMetafields: failedMF.length,
    }, null, 2));

    return new Response(
      JSON.stringify(finalResponse),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (err) {
    if (err instanceof Response) return err;

    console.error(`\n💥 [${rid}] UNHANDLED ERROR:`, err);
    console.error(`💥 [${rid}] Stack:`, err?.stack);

    return new Response(
      JSON.stringify({ success: false, rid, message: "Server error", error: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
