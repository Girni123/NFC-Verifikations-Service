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
  CF_SITE_KEY: '0x4AAAAAACwaUtYu34lDvzDL',              // Cloudflare Turnstile site key
  VERIFICATION_LAMBDA: 'https://verify.product-id.org/verification',
  PRODUCT_DATA_LAMBDA: 'https://9krn2xlz1a.execute-api.eu-north-1.amazonaws.com/get-product',
  TOKEN_TTL: 4 * 60 * 1000,  // 4 minutes
};

let cfToken = null;
let tokenTimestamp = null;
let isLoading = false;
let productDataLoaded = false;  // true wenn Produktdaten erfolgreich geladen

// ── Session-Token: wird aus URL gelesen und in Memory gehalten ──
// Der Token wird sofort aus der URL entfernt (history.replaceState),
// damit er beim Teilen des Links NICHT mitgesendet wird.
let sessionToken = null;

// ═══════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  // Token aus URL extrahieren und aus URL entfernen
  extractAndRemoveToken();
  initCaptcha();
  loadProductData();
});

/**
 * Extrahiert den Session-Token aus der URL, speichert ihn in Memory,
 * und entfernt ihn sofort aus der URL-Leiste.
 * → Wenn jemand den Link kopiert/teilt, ist der Token NICHT enthalten.
 */
function extractAndRemoveToken() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');

  if (token) {
    sessionToken = token;
    console.log('[TOKEN] Session-Token aus URL extrahiert:', token.substring(0, 12) + '...');

    // Token aus URL entfernen (bleibt nur in Memory)
    params.delete('token');
    const remaining = params.toString();
    const newUrl = remaining
      ? `${window.location.pathname}?${remaining}`
      : window.location.pathname;
    window.history.replaceState({}, '', newUrl);
    console.log('[TOKEN] Token aus URL entfernt, neue URL:', newUrl);
  }
}

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

  // Wenn keine Produktdaten geladen → Button bleibt deaktiviert
  if (!productDataLoaded && state === 'ready') {
    return;  // Nicht aktivieren
  }

  btn.className = 'verify-btn';
  btn.disabled = false;
  btn.style.opacity = '1';

  switch (state) {
    case 'wait':
      btn.disabled = true;
      btn.innerHTML = 'Verifying you\'re human...';
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

  // ── SESSION-TOKEN basierte Verifikation (bevorzugt) ──
  // Wenn sessionToken vorhanden: nur Token + Cloudflare-Token senden
  // Wenn nicht: Legacy-Flow mit uid/ctr/cmac aus URL
  if (sessionToken) {
    console.log('[VERIFY] Session-Token Modus:', sessionToken.substring(0, 12) + '...');
    try {
      const url = `${CONFIG.VERIFICATION_LAMBDA}?token=${encodeURIComponent(sessionToken)}&cf_token=${encodeURIComponent(cfToken)}`;
      const res = await fetch(url);
      const data = await res.json();

      if (res.ok && data.verified === true) {
        updateButton('success');
        showResult('success', 'verified', data);
      } else {
        var ec = data.error_code || '';

        // CAPTCHA Fehler
        if (ec === 'E-CF01' || ec === 'E-CF02' || ec === 'E-CF04') {
          go(S.WARNING, { title: 'Sicherheits-Check fehlgeschlagen', message: 'Bitte lade die Seite neu.', hint: 'Cloudflare konnte dich nicht verifizieren.' });

        // USER ERROR: Replay / Session verbraucht (Doppelklick / Reload)
        } else if (ec === 'E-RP01' || ec === 'E-TK04') {
          go(S.WARNING, { title: 'Code bereits verarbeitet', message: 'Dieser Scan wurde bereits genutzt.', hint: 'Bitte scanne den NFC-Chip erneut, um das Produkt nochmals zu prüfen.' });

        // USER ERROR: Session abgelaufen oder nicht gefunden
        } else if (ec === 'E-TK02' || ec === 'E-TK03') {
          go(S.WARNING, { title: 'Sitzung abgelaufen', message: 'Der Verifizierungscode ist nicht mehr gültig.', hint: 'Halte dein Smartphone erneut an den NFC-Chip.' });

        // FAKE / COUNTERFEIT: Echte Fehler (Signatur, Encryption, Chip nicht in DB)
        } else {
          go(S.ERROR, { title: 'Nicht verifizierbar', message: 'Dieses Produkt konnte nicht als authentisch verifiziert werden.', hint: 'Bei Fragen wende dich bitte an den Kundenservice.' });
        }
      }
    } catch (e) {
      updateButton('error', '✕ Connection Error');
      showResult('error', 'server_error');
    }
    isLoading = false;
    return;
  }

  // ── LEGACY: uid/ctr/cmac aus URL ──
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
      var ec = data.error_code || '';

      // CAPTCHA Fehler
      if (ec === 'E-CF01' || ec === 'E-CF02' || ec === 'E-CF04') {
        go(S.WARNING, { title: 'Sicherheits-Check fehlgeschlagen', message: 'Bitte lade die Seite neu.', hint: 'Cloudflare konnte dich nicht verifizieren.' });

      // USER ERROR: Replay / Session verbraucht (Doppelklick / Reload)
      } else if (ec === 'E-RP01' || ec === 'E-TK04') {
        go(S.WARNING, { title: 'Code bereits verarbeitet', message: 'Dieser Scan wurde bereits genutzt.', hint: 'Bitte scanne den NFC-Chip erneut, um das Produkt nochmals zu prüfen.' });

      // USER ERROR: Session abgelaufen oder nicht gefunden
      } else if (ec === 'E-TK02' || ec === 'E-TK03') {
        go(S.WARNING, { title: 'Sitzung abgelaufen', message: 'Der Verifizierungscode ist nicht mehr gültig.', hint: 'Halte dein Smartphone erneut an den NFC-Chip.' });

      // FAKE / COUNTERFEIT: Echte Fehler (Signatur, Encryption, Chip nicht in DB)
      } else {
        go(S.ERROR, { title: 'Nicht verifizierbar', message: 'Dieses Produkt konnte nicht als authentisch verifiziert werden.', hint: 'Bei Fragen wende dich bitte an den Kundenservice.' });
      }
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

  // Reset button state
  isLoading = false;
  if (cfToken && tokenTimestamp && (Date.now() - tokenTimestamp <= CONFIG.TOKEN_TTL)) {
    updateButton('ready');
  } else {
    updateButton('wait');
  }
}

// ═══════════════════════════════════════════════
// DYNAMIC CONTENT LOADING
// ═══════════════════════════════════════════════
async function loadProductData() {
  const params = new URLSearchParams(window.location.search);

  // ── NEUE PARAMETER (vom Redirect Lambda gesetzt) ──
  const pid = params.get('pid');   // Product ID
  const did = params.get('did');   // Display ID (individueller Chip)

  // ── LEGACY PARAMETER (alter Flow, abwaertskompatibel) ──
  const uid = params.get('uid');
  const enc = params.get('e') || params.get('enc');
  const bid = params.get('bid');

  // ── DEBUG: Alle Parameter loggen ──
  console.group('%c[ProductPage] DEBUG', 'color: #CDFF00; background: #111; padding: 2px 6px; border-radius: 3px;');
  console.log('URL:', window.location.href);
  console.log('Session Token:', sessionToken ? sessionToken.substring(0, 12) + '...' : 'null');
  console.log('Parameter:', { pid, did, uid, enc: enc ? enc.substring(0, 16) + '...' : null, bid });

  // Kein pid, did, uid ODER enc → Preview-Modus
  if (!pid && !did && !uid && !enc) {
    console.log('Keine Daten-Parameter → Preview-Modus');
    console.groupEnd();
    return;
  }

  // ── Sofort: Platzhalter verstecken bevor Daten geladen werden ──
  hideAllPlaceholders();

  try {
    // ── Lambda-URL bauen: pid/did bevorzugt, uid/enc als Legacy ──
    let lambdaUrl = `${CONFIG.PRODUCT_DATA_LAMBDA}?`;
    if (pid) {
      lambdaUrl += `pid=${encodeURIComponent(pid)}`;
    } else if (did) {
      lambdaUrl += `did=${encodeURIComponent(did)}`;
    } else {
      // Legacy: uid/enc/bid
      if (uid) lambdaUrl += `uid=${encodeURIComponent(uid)}&`;
      if (enc) lambdaUrl += `enc=${encodeURIComponent(enc)}&`;
      if (bid) lambdaUrl += `bid=${encodeURIComponent(bid)}&`;
      lambdaUrl = lambdaUrl.replace(/&$/, '');
    }

    console.log('Lambda Request:', lambdaUrl);
    const t0 = performance.now();
    const res = await fetch(lambdaUrl);
    const duration = Math.round(performance.now() - t0);
    console.log(`Lambda Response: ${res.status} ${res.statusText} (${duration}ms)`);

    // Response-Headers loggen (CORS etc.)
    console.log('Response Headers:', {
      'content-type': res.headers.get('content-type'),
      'access-control-allow-origin': res.headers.get('access-control-allow-origin'),
    });

    if (!res.ok) {
      let errBody = await res.json().catch(() => ({}));
      // Unwrap double-JSON if needed
      if (errBody && typeof errBody.body === 'string' && errBody.statusCode) {
        try { errBody = JSON.parse(errBody.body); } catch(e) { /* keep original */ }
      }
      console.error('Lambda Error Response:', JSON.stringify(errBody, null, 2));
      console.groupEnd();
      showDataError(res.status, errBody);
      return;
    }

    const rawResponse = await res.json();
    console.log('Lambda Raw Response:', JSON.stringify(rawResponse, null, 2));

    // ── Handle double-wrapped API Gateway response ──
    // API Gateway HTTP API v2 (payload format 2.0) may return the entire
    // Lambda proxy response as JSON: { statusCode, headers, body: "..." }
    // In that case, the actual data is inside body (as a JSON string).
    let response = rawResponse;
    if (rawResponse && typeof rawResponse.body === 'string' && rawResponse.statusCode) {
      try {
        response = JSON.parse(rawResponse.body);
        console.log('Unwrapped double-JSON body:', JSON.stringify(response, null, 2));
      } catch (e) {
        console.warn('body is a string but not valid JSON:', rawResponse.body);
      }
      // Check if the inner statusCode indicates an error
      if (rawResponse.statusCode >= 400) {
        console.error('Lambda returned error status:', rawResponse.statusCode);
        showDataError(rawResponse.statusCode, response);
        return;
      }
    }

    const productData = response.data || response;
    console.log('Extracted productData:', JSON.stringify(productData, null, 2));
    console.log('template_id:', response.template_id, '| template_file:', response.template_file);

    if (!productData || (!productData.product_name && !productData.brand_name)) {
      console.warn('Keine product_name/brand_name in Antwort → Fehler anzeigen');
      console.warn('Verfuegbare Keys in productData:', productData ? Object.keys(productData) : 'null');
      console.warn('Verfuegbare Keys in response:', response ? Object.keys(response) : 'null');
      console.warn('Verfuegbare Keys in rawResponse:', rawResponse ? Object.keys(rawResponse) : 'null');
      console.groupEnd();
      showDataError(0, { error_code: 'EMPTY_DATA' });
      return;
    }

    // Erfolgreich geladen
    productDataLoaded = true;
    console.log('Produktdaten erfolgreich geladen, wende auf Template an...');
    console.groupEnd();

    // Let the template-specific function handle the rendering
    if (typeof applyProductData === 'function') {
      applyProductData(productData);
    } else {
      applyGenericProductData(productData);
    }
  } catch (e) {
    console.error('Netzwerk-/Fetch-Fehler:', e.message, e);
    console.groupEnd();
    showDataError(0, { error_code: 'NETWORK_ERROR', error: e.message });
  }
}

/**
 * Versteckt alle Platzhalter-Inhalte sofort beim Laden,
 * damit kein falsches Produktbild/Name aufblitzt.
 */
function hideAllPlaceholders() {
  // Hero-Image verstecken bis echte Daten da sind
  const heroImg = document.getElementById('heroImage');
  if (heroImg) heroImg.style.opacity = '0';

  // Produktname/Brand ausblenden
  const nameEl = document.getElementById('productName');
  if (nameEl) nameEl.style.opacity = '0';
  const brandEl = document.getElementById('brandName');
  if (brandEl) brandEl.style.opacity = '0';

  // Sizes, Shop, Meta ausblenden
  const sizeRow = document.getElementById('sizeRow');
  if (sizeRow) sizeRow.style.opacity = '0';
  const shopLink = document.getElementById('shopLink');
  if (shopLink) shopLink.style.opacity = '0';
}

/**
 * Zeigt eine Fehlermeldung wenn keine Produktdaten geladen werden konnten.
 * Ersetzt die Platzhalter-Inhalte durch eine klare Fehlermeldung.
 */
function showDataError(status, errBody) {
  productDataLoaded = false;

  // Verstecke Platzhalter-Inhalte
  const hideIds = ['descSection', 'storySection', 'detailSection', 'gallerySection',
    'specsSection', 'sustainSection', 'extraSection', 'infoGrid',
    'materialSection', 'careSection'];
  hideIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  // Setze Produktname auf Fehlermeldung (sichtbar machen)
  const nameEl = document.getElementById('productName');
  if (nameEl) { nameEl.textContent = 'Produktdaten nicht verfügbar'; nameEl.style.opacity = '1'; }

  const brandEl = document.getElementById('brandName');
  if (brandEl) { brandEl.textContent = ''; brandEl.style.opacity = '1'; }

  const catEl = document.getElementById('productCategory');
  if (catEl) catEl.textContent = '';

  // Verstecke Hero-Image komplett
  const heroImg = document.getElementById('heroImage');
  if (heroImg) { heroImg.style.display = 'none'; heroImg.style.opacity = '1'; }
  // Verstecke auch den Image-Container
  const imgContainer = document.querySelector('.product-image, .hero-section');
  if (imgContainer) imgContainer.style.display = 'none';

  // Verstecke Size, Shop etc.
  const sizeRow = document.getElementById('sizeRow');
  if (sizeRow) { sizeRow.style.display = 'none'; sizeRow.style.opacity = '1'; }
  const shopLink = document.getElementById('shopLink');
  if (shopLink) { shopLink.style.display = 'none'; shopLink.style.opacity = '1'; }
  const meta = document.querySelector('.product-meta');
  if (meta) meta.style.display = 'none';

  // Zeige Fehlermeldung im Description-Bereich
  const descSection = document.getElementById('descSection');
  const descText = document.getElementById('descText') || document.getElementById('productDesc');
  if (descSection && descText) {
    descSection.style.display = '';
    descSection.classList.remove('hidden');
    descSection.classList.add('visible');
    descText.textContent = 'Die Produktdaten konnten leider nicht geladen werden. Bitte versuche es später erneut oder scanne den NFC-Chip noch einmal.';
    const label = descSection.querySelector('.section-label, .section-title, h3');
    if (label) label.textContent = 'Hinweis';
  }

  // ── Verify-Button deaktivieren wenn keine Daten geladen ──
  disableVerifyButton();
}

/**
 * Deaktiviert den Verify-Button dauerhaft wenn keine Produktdaten vorhanden.
 */
function disableVerifyButton() {
  const btn = document.getElementById('verifyBtn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = 'Verifizierung nicht möglich';
    btn.classList.add('error');
    btn.style.opacity = '0.5';
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
 *   sizes_available      → Array of sizes (e.g. ["S", "M", "L", "XL"])
 *   product_size         → Legacy single size (e.g. "M", "42", "One Size")
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
 * INFO CARDS (array, optional — for bold template info grid):
 *   info_cards: [
 *     { label: "Material", value: "Full-Grain Leather" },
 *     { label: "Origin", value: "Italy" },
 *   ]
 *
 * SPEC CARDS (array, optional — for clean template specs grid):
 *   spec_cards: [
 *     { label: "Material", value: "80% Wool" },
 *     { label: "Origin", value: "Italy" },
 *   ]
 *
 * HERO BADGE / LABEL (optional):
 *   hero_badge_text      → Text for badge on hero image (e.g. "NFC Verified")
 */
function applyGenericProductData(data) {
  if (!data) return;

  // ── Platzhalter wieder sichtbar machen (wurden in hideAllPlaceholders versteckt) ──
  ['productName', 'brandName', 'sizeRow', 'shopLink'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.opacity = '1';
  });
  const heroImg = document.getElementById('heroImage');
  if (heroImg) heroImg.style.opacity = '1';

  // Update browser tab title with product name
  if (data.product_name) {
    document.title = data.brand_name
      ? `${data.product_name} — ${data.brand_name}`
      : data.product_name;
  }

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
  setText('productCategory', data.product_category);

  // Hero image: set src and fade in when loaded
  if (data.hero_image_url) {
    const heroEl = document.getElementById('heroImage');
    if (heroEl) {
      heroEl.onload = () => { heroEl.style.opacity = '1'; };
      heroEl.src = data.hero_image_url;
    }
  }

  setText('heroBadge', data.hero_badge_text);
  setText('heroLabel', data.hero_badge_text);

  // ── SIZES (dynamic from sizes_available array) ──
  const sizes = data.sizes_available || (data.product_size ? [data.product_size] : []);
  if (sizes.length > 0) {
    // Template-2-clean: size chips in sizeOptions container
    const sizeOpts = document.getElementById('sizeOptions');
    if (sizeOpts) {
      sizeOpts.innerHTML = sizes.map((s, i) =>
        `<div class="size-chip${i === 0 ? ' active' : ''}">${s}</div>`
      ).join('');
    }
    // Template-3-minimal: size-value boxes
    const sizeValues = document.querySelector('.size-values');
    if (sizeValues) {
      sizeValues.innerHTML = sizes.map(s =>
        `<span class="size-value">${s}</span>`
      ).join('');
    }
    // Template-1-bold: single size pill (show first size or comma-joined)
    setText('productSize', sizes.join(', '));
    setText('activeSize', sizes[0]);
  } else {
    // Hide size-related elements if no sizes
    const sizeRow = document.querySelector('.product-meta');
    if (sizeRow) sizeRow.style.display = 'none';
    const sizeRow2 = document.querySelector('.product-size-row');
    if (sizeRow2) sizeRow2.style.display = 'none';
    const sizeRow3 = document.getElementById('sizeRow');
    if (sizeRow3) sizeRow3.style.display = 'none';
  }

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

  // ── SHOP LINK (configurable text + icon) ──
  if (data.shop_url) {
    const shopEl = document.getElementById('shopLink');
    if (shopEl) {
      shopEl.href = data.shop_url;
      shopEl.classList.remove('hidden');
      shopEl.classList.add('visible');
      shopEl.style.display = '';

      // Configurable text
      if (data.shop_text) {
        const shopTextEl = document.getElementById('shopText');
        if (shopTextEl) shopTextEl.textContent = data.shop_text;
      }

      // Configurable icon (emoji or short text; if empty, keep default SVG)
      if (data.shop_icon) {
        const shopIconEl = document.getElementById('shopIcon');
        if (shopIconEl) shopIconEl.innerHTML = data.shop_icon;
      }
    }
  } else {
    const shopEl = document.getElementById('shopLink');
    if (shopEl) {
      shopEl.classList.add('hidden');
      shopEl.style.display = 'none';
    }
  }

  // ── TOP LINK (optional — shown at top-right of hero) ──
  if (data.top_link_url) {
    const topLink = document.getElementById('topLink');
    if (topLink) {
      topLink.href = data.top_link_url;
      topLink.style.display = '';
      if (data.top_link_text) {
        const topText = document.getElementById('topLinkText');
        if (topText) topText.textContent = data.top_link_text;
      }
    }
  }

  // ── INFO CARDS (template-1-bold) — editable labels via info_cards array ──
  if (data.info_cards && data.info_cards.length > 0) {
    // Custom info cards: each has {label, value}
    const grid = document.getElementById('infoGrid');
    if (grid) {
      // Hide all default cards first
      for (let i = 1; i <= 4; i++) hideSection('infoCard' + i);
      // Show only the provided ones
      data.info_cards.forEach((card, i) => {
        const idx = i + 1;
        if (idx <= 4) {
          setText('infoLabel' + idx, card.label);
          setText('infoVal' + idx, card.value);
          showSection('infoCard' + idx);
        }
      });
    }
  } else {
    // Fallback: use individual fields with default labels
    if (data.material) { setText('infoVal1', data.material); } else { hideSection('infoCard1'); }
    if (data.origin) { setText('infoVal2', data.origin); } else { hideSection('infoCard2'); }
    if (data.collection) { setText('infoVal3', data.collection); } else { hideSection('infoCard3'); }
    if (data.edition) { setText('infoVal4', data.edition); } else { hideSection('infoCard4'); }
  }

  // ── SPECS GRID (template-2-clean) — editable labels via spec_cards array ──
  if (data.spec_cards && data.spec_cards.length > 0) {
    const specsGrid = document.getElementById('specsGrid');
    if (specsGrid) {
      specsGrid.innerHTML = data.spec_cards.map((card, i) => {
        const idx = i + 1;
        return `<div class="spec-cell" id="specCell${idx}"><span class="spec-key" id="specKey${idx}">${card.label}</span><span class="spec-val" id="specVal${idx}">${card.value}</span></div>`;
      }).join('');
    }
    showSection('specsSection');
  } else {
    // Fallback: use individual fields
    setText('specVal1', data.material);
    setText('specVal2', data.origin);
    setText('specVal3', data.weight);
    setText('specVal4', data.care_instructions);
    // Also set old IDs for backwards compatibility
    setText('specMat', data.material);
    setText('specOrigin', data.origin);
    setText('specWeight', data.weight);
    setText('specCare', data.care_instructions);
  }

  // ── DETAIL LIST (template-1-bold) ──
  setText('detailProd', data.production);
  setText('detailSust', data.sustainability);
  setText('detailCare', data.care_instructions);

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

  // ── GALLERY IMAGES (clickable → lightbox) ──
  if (data.gallery_images && data.gallery_images.length > 0) {
    const gallery = document.getElementById('gallery');
    const gallerySection = document.getElementById('gallerySection');
    if (gallery) {
      gallery.innerHTML = data.gallery_images.map((url, i) =>
        `<img class="gallery-img" src="${url}" alt="Product detail" loading="lazy" onclick="openLightbox(${i})">`
      ).join('');
      // Store gallery URLs globally for lightbox navigation
      window.__galleryImages = data.gallery_images;
    }
    // For template-2-clean gallery cells (clickable → lightbox)
    const galleryRow = document.querySelector('.gallery-row');
    if (galleryRow) {
      galleryRow.innerHTML = data.gallery_images.slice(0, 3).map((url, i) =>
        `<div class="gallery-cell"><img src="${url}" alt="Product detail" loading="lazy" onclick="openLightbox(${i})"></div>`
      ).join('');
    }
    if (gallerySection) showSection('gallerySection');
  } else {
    hideSection('gallerySection');
    const galleryRow = document.querySelector('.gallery-row');
    if (galleryRow) galleryRow.style.display = 'none';
  }

  // ── SPECS SECTION visibility ──
  if (!data.spec_cards && !data.material && !data.origin && !data.weight && !data.care_instructions) {
    hideSection('specsSection');
  }

  // ── INFO GRID visibility ──
  if (!data.info_cards && !data.material && !data.origin && !data.collection && !data.edition) {
    hideSection('infoGrid');
  }
}

// ═══════════════════════════════════════════════
// LIGHTBOX (Fullscreen Gallery Viewer)
// ═══════════════════════════════════════════════
let __lightboxIndex = 0;

function openLightbox(index) {
  const images = window.__galleryImages;
  if (!images || !images.length) return;

  __lightboxIndex = index;
  const overlay = document.getElementById('lightbox');
  const img = document.getElementById('lightboxImg');
  const counter = document.getElementById('lbCounter');
  if (!overlay || !img) return;

  img.src = images[index];
  if (counter) counter.textContent = `${index + 1} / ${images.length}`;

  // Hide nav arrows if only one image
  const prevBtn = document.getElementById('lbPrev');
  const nextBtn = document.getElementById('lbNext');
  if (prevBtn) prevBtn.style.display = images.length > 1 ? '' : 'none';
  if (nextBtn) nextBtn.style.display = images.length > 1 ? '' : 'none';

  overlay.classList.add('visible');
  document.body.style.overflow = 'hidden';
}

function closeLightbox(e) {
  if (e) e.stopPropagation();
  const overlay = document.getElementById('lightbox');
  if (overlay) overlay.classList.remove('visible');
  document.body.style.overflow = '';
}

function lightboxNav(dir, e) {
  if (e) e.stopPropagation();
  const images = window.__galleryImages;
  if (!images || !images.length) return;

  __lightboxIndex = (__lightboxIndex + dir + images.length) % images.length;
  const img = document.getElementById('lightboxImg');
  const counter = document.getElementById('lbCounter');
  if (img) img.src = images[__lightboxIndex];
  if (counter) counter.textContent = `${__lightboxIndex + 1} / ${images.length}`;
}

// Keyboard navigation for lightbox
document.addEventListener('keydown', (e) => {
  const overlay = document.getElementById('lightbox');
  if (!overlay || !overlay.classList.contains('visible')) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') lightboxNav(-1);
  if (e.key === 'ArrowRight') lightboxNav(1);
});

// ═══════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function resultRow(key, val) {
  // Template-specific row renderers can override this
  return `<div class="result-detail-row result-row"><span class="result-detail-key result-key">${key}</span><span class="result-detail-val result-val">${val}</span></div>`;
}
