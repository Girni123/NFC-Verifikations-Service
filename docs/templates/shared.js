/**
 * ═══════════════════════════════════════════════════════════════
 * SHARED PRODUCT PAGE LOGIC
 * Used by all templates (bold, clean, minimal)
 * ═══════════════════════════════════════════════════════════════
 *
 * FLOW:
 * 1. NFC chip → URL: girnstein.studio/templates/template-X.html?uid=...&ctr=...&cmac=...&enc=...
 * 2. Page loads → calls PRODUCT_DATA_LAMBDA with uid
 * 3. Lambda decrypts enc (or looks up uid in DynamoDB) → returns display data
 * 4. This script populates the template fields and hides empty sections
 * 5. User clicks "Verify" → calls VERIFICATION_LAMBDA with uid+ctr+cmac+cf_token
 *
 * URL PARAMETERS:
 *   uid   = NFC chip unique ID
 *   ctr   = rolling counter (anti-replay)
 *   cmac  = cryptographic MAC (authenticity proof)
 *   enc   = optional encrypted payload with product data
 *   t     = template override (e.g. "template-2-clean")
 */

// ═══════════════════════════════════════════════
// CONFIGURATION — Replace with your actual values
// ═══════════════════════════════════════════════
const CONFIG = {
  CF_SITE_KEY: '__CF_SITE_KEY__',                    // Cloudflare Turnstile site key — replace!
  VERIFICATION_LAMBDA: 'https://cgh2mb4wta.execute-api.eu-north-1.amazonaws.com/verification',
  PRODUCT_DATA_LAMBDA: 'https://YOUR_API_GATEWAY_URL/product-page',  // Replace with your product-data Lambda
  TOKEN_TTL: 4 * 60 * 1000,  // 4 minutes
};

let cfToken = null;
let tokenTimestamp = null;
let isLoading = false;

// ═══════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  initCaptcha();
  loadProductData();
});

// ═══════════════════════════════════════════════
// CLOUDFLARE TURNSTILE
// ═══════════════════════════════════════════════
function initCaptcha() {
  const check = setInterval(() => {
    if (window.turnstile) {
      clearInterval(check);
      window.turnstile.render('#captcha-box', {
        sitekey: CONFIG.CF_SITE_KEY,
        appearance: 'interaction-only',
        callback: (token) => {
          cfToken = token;
          tokenTimestamp = Date.now();
          updateButton('ready');
        },
        'error-callback': () => { cfToken = null; tokenTimestamp = null; },
        'expired-callback': () => { cfToken = null; tokenTimestamp = null; updateButton('wait'); },
      });
    }
  }, 200);
}

// Token expiry check
setInterval(() => {
  if (tokenTimestamp && (Date.now() - tokenTimestamp > CONFIG.TOKEN_TTL)) {
    cfToken = null;
    tokenTimestamp = null;
    updateButton('wait');
  }
}, 30000);

// ═══════════════════════════════════════════════
// BUTTON STATES (overrideable per template)
// ═══════════════════════════════════════════════
function updateButton(state, label) {
  const btn = document.getElementById('verifyBtn');
  if (!btn) return;
  btn.className = 'verify-btn';
  btn.disabled = false;

  switch (state) {
    case 'wait':
      btn.disabled = true;
      btn.innerHTML = 'Security Check...';
      break;
    case 'ready':
      btn.innerHTML = typeof getReadyLabel === 'function' ? getReadyLabel() : 'Verify Authenticity';
      break;
    case 'loading':
      btn.classList.add('loading');
      btn.disabled = true;
      btn.innerHTML = '<div class="spinner"></div> Checking...';
      break;
    case 'success':
      btn.classList.add('success');
      btn.innerHTML = '✓ Verified Authentic';
      break;
    case 'error':
      btn.classList.add('error');
      btn.innerHTML = label || '✕ Verification Failed';
      break;
  }
}

// ═══════════════════════════════════════════════
// VERIFICATION (Authenticity Check)
// ═══════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('verifyBtn');
  if (btn) btn.addEventListener('click', verify);
});

async function verify() {
  if (!cfToken || isLoading) return;

  if (tokenTimestamp && (Date.now() - tokenTimestamp > CONFIG.TOKEN_TTL)) {
    cfToken = null;
    tokenTimestamp = null;
    updateButton('wait');
    return;
  }

  isLoading = true;
  updateButton('loading');

  const params = new URLSearchParams(window.location.search);
  const uid = params.get('uid');
  const ctr = params.get('ctr');
  const cmac = params.get('cmac');

  if (!uid) {
    await sleep(800);
    showResult('error', 'missing_params');
    isLoading = false;
    return;
  }

  try {
    const url = `${CONFIG.VERIFICATION_LAMBDA}?uid=${encodeURIComponent(uid)}&ctr=${encodeURIComponent(ctr || '')}&cmac=${encodeURIComponent(cmac || '')}&cf_token=${encodeURIComponent(cfToken)}`;
    const res = await fetch(url);
    const data = await res.json();

    if (res.ok && data.verified === true) {
      updateButton('success');
      showResult('success', 'verified', data);
    } else {
      let errType = 'fake';
      if (data.error_code === 'CAPTCHA_INVALID' || data.error_code === 'CAPTCHA_MISSING') errType = 'captcha';
      else if (data.error_code === 'REPLAY_DETECTED') errType = 'replay';
      updateButton('error');
      showResult('error', errType, data);
    }
  } catch (e) {
    updateButton('error', '✕ Connection Error');
    showResult('error', 'server_error');
  }

  isLoading = false;
}

// ═══════════════════════════════════════════════
// RESULT OVERLAY
// ═══════════════════════════════════════════════
function showResult(type, code, data) {
  // Each template defines its own showResult via showResultOverlay()
  // This is a universal fallback
  if (typeof showResultOverlay === 'function') {
    showResultOverlay(type, code, data);
    return;
  }
  // Generic fallback if template doesn't define showResultOverlay
  console.warn('showResultOverlay not defined by template');
}

function closeResult() {
  const overlay = document.getElementById('resultOverlay');
  if (overlay) overlay.classList.remove('visible');
}

// ═══════════════════════════════════════════════
// DYNAMIC CONTENT LOADING
// ═══════════════════════════════════════════════
async function loadProductData() {
  const params = new URLSearchParams(window.location.search);
  const uid = params.get('uid');
  const enc = params.get('enc');

  // If no uid, we're in preview mode — show placeholder content
  if (!uid) {
    console.log('[ProductPage] No uid found — showing placeholder content');
    return;
  }

  try {
    // Call product-data Lambda
    const url = `${CONFIG.PRODUCT_DATA_LAMBDA}?uid=${encodeURIComponent(uid)}${enc ? '&enc=' + encodeURIComponent(enc) : ''}`;
    const res = await fetch(url);

    if (!res.ok) {
      console.warn('[ProductPage] Product data Lambda returned', res.status);
      // Keep showing placeholder content
      return;
    }

    const response = await res.json();

    // Lambda returns { template: "...", data: { ... } }
    // Extract the actual product data from the wrapper
    const productData = response.data || response;

    // Let the template-specific function handle the rendering
    if (typeof applyProductData === 'function') {
      applyProductData(productData);
    } else {
      // Fallback: generic field mapping
      applyGenericProductData(productData);
    }
  } catch (e) {
    console.warn('[ProductPage] Could not load product data:', e.message);
    // Keep showing placeholder content — graceful degradation
  }
}

/**
 * Generic product data application — maps standard field names to element IDs.
 * Templates can override this with their own `applyProductData(data)` function.
 *
 * STANDARD DATA SCHEMA (what Lambda should return):
 *
 * REQUIRED FIELDS (always present):
 *   product_name        → Product name / title
 *   brand_name          → Brand name
 *
 * CORE OPTIONAL FIELDS:
 *   product_size         → Size (e.g. "M", "42", "One Size")
 *   product_category     → Category (e.g. "Premium Outerwear")
 *   hero_image_url       → Main product image URL
 *   description          → Product description text
 *   shop_url             → Link to buy the product
 *
 * EXTENDED OPTIONAL FIELDS:
 *   story_text           → Brand/product story
 *   material             → Material info (e.g. "80% Wool, 20% Cashmere")
 *   origin               → Country of origin
 *   collection           → Collection name (e.g. "FW 2025")
 *   edition              → Edition info (e.g. "Limited", "1 of 500")
 *   production           → Production method (e.g. "Handmade")
 *   sustainability       → Sustainability info
 *   care_instructions    → Care instructions
 *   weight               → Weight info
 *   production_date      → When it was produced
 *
 * SUSTAINABILITY FEATURES (array, optional):
 *   sustainability_features: [
 *     { icon: "♻", label: "Eco Materials", description: "Responsibly sourced..." },
 *     { icon: "🌍", label: "Fair Production", description: "GOTS-certified..." },
 *   ]
 *
 * GALLERY IMAGES (array, optional):
 *   gallery_images: [
 *     "https://example.com/img1.jpg",
 *     "https://example.com/img2.jpg",
 *   ]
 *
 * CUSTOM FIELDS (array, optional — for extra sections):
 *   custom_fields: [
 *     { label: "Season", value: "Summer 2025" },
 *     { label: "Designer", value: "John Doe" },
 *   ]
 *
 * HERO BADGE / LABEL (optional):
 *   hero_badge_text      → Text for badge on hero image (e.g. "NFC Verified")
 */
function applyGenericProductData(data) {
  if (!data) return;

  // Helper: set text content if element exists and data field is truthy
  function setText(id, value) {
    const el = document.getElementById(id);
    if (el && value) el.textContent = value;
  }

  // Helper: set image src if element exists and URL is truthy
  function setImage(id, url) {
    const el = document.getElementById(id);
    if (el && url) el.src = url;
  }

  // Helper: show a section (remove 'hidden' class, add 'visible' class)
  function showSection(id) {
    const el = document.getElementById(id);
    if (el) {
      el.classList.remove('hidden');
      el.classList.add('visible');
      el.style.display = '';
    }
  }

  // Helper: hide a section
  function hideSection(id) {
    const el = document.getElementById(id);
    if (el) {
      el.classList.add('hidden');
      el.classList.remove('visible');
      el.style.display = 'none';
    }
  }

  // ── REQUIRED FIELDS ──
  setText('productName', data.product_name);
  setText('brandName', data.brand_name);

  // ── CORE OPTIONAL FIELDS ──
  setText('productSize', data.product_size);
  setText('activeSize', data.product_size);
  setText('productCategory', data.product_category);
  setImage('heroImage', data.hero_image_url);
  setText('heroBadge', data.hero_badge_text);
  setText('heroLabel', data.hero_badge_text);

  // Description
  if (data.description) {
    setText('productDesc', data.description);
    setText('descText', data.description);
    showSection('descSection');
  } else {
    hideSection('descSection');
  }

  // Story
  if (data.story_text) {
    setText('storyText', data.story_text);
    showSection('storySection');
  } else {
    hideSection('storySection');
  }

  // Shop link
  if (data.shop_url) {
    const shopEl = document.getElementById('shopLink');
    if (shopEl) {
      shopEl.href = data.shop_url;
      shopEl.classList.add('visible');
      shopEl.style.display = '';
    }
  } else {
    const shopEl = document.getElementById('shopLink');
    if (shopEl) {
      shopEl.style.display = 'none';
    }
  }

  // ── INFO CARDS (template-1-bold) ──
  if (data.material) { setText('infoVal1', data.material); } else { hideSection('infoCard1'); }
  if (data.origin) { setText('infoVal2', data.origin); } else { hideSection('infoCard2'); }
  if (data.collection) { setText('infoVal3', data.collection); } else { hideSection('infoCard3'); }
  if (data.edition) { setText('infoVal4', data.edition); } else { hideSection('infoCard4'); }

  // ── SPECS GRID (template-2-clean) ──
  setText('specMat', data.material);
  setText('specOrigin', data.origin);
  setText('specWeight', data.weight);
  setText('specCare', data.care_instructions);

  // ── DETAIL LIST (template-1-bold) ──
  setText('detailProd', data.production);
  setText('detailSust', data.sustainability);
  setText('detailCare', data.care_instructions);

  // Check if detail section has any data
  if (!data.production && !data.sustainability && !data.care_instructions) {
    hideSection('detailSection');
  } else {
    showSection('detailSection');
  }

  // ── SUSTAINABILITY FEATURES (template-2-clean) ──
  if (data.sustainability_features && data.sustainability_features.length > 0) {
    const featureList = document.getElementById('featureList');
    if (featureList) {
      featureList.innerHTML = data.sustainability_features.map((f, i) => `
        <div class="feature-item">
          <div class="feature-icon">${f.icon || '●'}</div>
          <div class="feature-content">
            <div class="feature-label">${f.label}</div>
            <div class="feature-desc">${f.description || ''}</div>
          </div>
        </div>
      `).join('');
    }
    showSection('sustainSection');
  } else if (data.sustainability) {
    // Simple text sustainability
    setText('sustainText', data.sustainability);
    showSection('sustainSection');
  } else {
    hideSection('sustainSection');
  }

  // ── EXTRA SECTIONS (template-2-clean + template-3-minimal) ──
  if (data.production) {
    setText('extraText', data.production);
    showSection('extraSection');
  } else {
    hideSection('extraSection');
  }

  // ── MATERIAL (template-3-minimal) ──
  if (data.material) {
    setText('materialText', data.material);
    showSection('materialSection');
  } else {
    hideSection('materialSection');
  }

  // ── CARE (template-3-minimal) ──
  if (data.care_instructions) {
    setText('careText', data.care_instructions);
    showSection('careSection');
  } else {
    hideSection('careSection');
  }

  // ── CUSTOM FIELDS → extra sections (template-3-minimal) ──
  if (data.custom_fields && data.custom_fields.length > 0) {
    data.custom_fields.forEach((field, i) => {
      const sectionId = `extraSection${i + 1}`;
      const labelId = `extra${i + 1}Label`;
      const textId = `extra${i + 1}Text`;
      setText(labelId, field.label);
      setText(textId, field.value);
      showSection(sectionId);
    });
  }

  // ── GALLERY IMAGES ──
  if (data.gallery_images && data.gallery_images.length > 0) {
    const gallery = document.getElementById('gallery');
    const gallerySection = document.getElementById('gallerySection');
    if (gallery) {
      gallery.innerHTML = data.gallery_images.map(url =>
        `<img class="gallery-img" src="${url}" alt="Product detail" loading="lazy">`
      ).join('');
    }
    // For template-2-clean gallery cells
    const galleryRow = document.querySelector('.gallery-row');
    if (galleryRow) {
      galleryRow.innerHTML = data.gallery_images.slice(0, 3).map(url =>
        `<div class="gallery-cell"><img src="${url}" alt="Product detail" loading="lazy"></div>`
      ).join('');
    }
    if (gallerySection) showSection('gallerySection');
  } else {
    hideSection('gallerySection');
    const galleryRow = document.querySelector('.gallery-row');
    if (galleryRow) galleryRow.style.display = 'none';
  }

  // ── SPECS SECTION visibility ──
  if (!data.material && !data.origin && !data.weight && !data.care_instructions) {
    hideSection('specsSection');
  }

  // ── INFO GRID visibility ──
  if (!data.material && !data.origin && !data.collection && !data.edition) {
    hideSection('infoGrid');
  }

  // ── SIZE visibility ──
  if (!data.product_size) {
    // Hide size-related elements
    const sizeRow = document.querySelector('.product-meta');
    if (sizeRow) sizeRow.style.display = 'none';
    const sizeRow2 = document.querySelector('.product-size-row');
    if (sizeRow2) sizeRow2.style.display = 'none';
    const sizeRow3 = document.querySelector('.size-row');
    if (sizeRow3) sizeRow3.style.display = 'none';
  }
}

// ═══════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function resultRow(key, val) {
  // Template-specific row renderers can override this
  return `<div class="result-detail-row result-row"><span class="result-detail-key result-key">${key}</span><span class="result-detail-val result-val">${val}</span></div>`;
}
