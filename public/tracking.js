(function() {
  const dataLayer = window.dataLayer = window.dataLayer || [];
  const defaultContainerId = 'GTM-NDCKPZ6Z';
  const clarityProjectId = 'x0t08kbqi9';
  const googleAdsId = 'AW-18188860218';
  const signupConversionLabel = 'h929CMCvj7gcELr2j-FD';
  const purchaseConversionLabel = 'Zp-LCJf73rYcELr2j-FD';
  const privateKeys = new Set(['email', 'phone', 'phone_number', 'user_name', 'username', 'full_name', 'first_name', 'last_name']);
  const isDevelopment = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  let googleAdsConfigured = false;
  let clarityConfigured = false;

  function safeParams(params = {}) {
    return Object.fromEntries(Object.entries(params).flatMap(([key, value]) => {
      if (privateKeys.has(key) || value == null) return [];
      if (['string', 'number', 'boolean'].includes(typeof value)) return [[key, value]];
      return [];
    }));
  }

  function trackEvent(eventName, params = {}) {
    if (!eventName) return;
    const safe = safeParams(params);
    dataLayer.push({ event: eventName, ...safe });
    if (eventName === 'signup_complete') trackSignupConversion();
    if (eventName === 'subscription_purchase') trackPurchaseConversion(safe);
    if (isDevelopment) console.log(`[tracking] ${eventName}`, safe);
  }

  window.KillerWorkTracking = { trackEvent };

  function configureClarity() {
    if (clarityConfigured || !clarityProjectId || isDevelopment) return;
    clarityConfigured = true;
    if (typeof window.clarity === 'function') return;
    window.clarity = function() {
      (window.clarity.q = window.clarity.q || []).push(arguments);
    };
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.clarity.ms/tag/${encodeURIComponent(clarityProjectId)}`;
    const firstScript = document.getElementsByTagName('script')[0];
    firstScript.parentNode.insertBefore(script, firstScript);
  }

  function configureGoogleAds() {
    window.gtag = window.gtag || function() { dataLayer.push(arguments); };
    if (googleAdsConfigured) return;
    googleAdsConfigured = true;
    if (!document.querySelector(`script[src*="googletagmanager.com/gtag/js?id=${googleAdsId}"]`)) {
      const script = document.createElement('script');
      script.async = true;
      script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(googleAdsId)}`;
      document.head.appendChild(script);
    }
    window.gtag('js', new Date());
    window.gtag('config', googleAdsId);
  }

  function trackSignupConversion() {
    configureGoogleAds();
    window.gtag('event', 'conversion', {
      send_to: `${googleAdsId}/${signupConversionLabel}`,
      value: 1.0,
      currency: 'AED'
    });
  }

  function trackPurchaseConversion(params = {}) {
    configureGoogleAds();
    window.gtag('event', 'conversion', {
      send_to: `${googleAdsId}/${purchaseConversionLabel}`,
      value: Number(params.value) || 5.0,
      currency: params.currency || 'USD',
      transaction_id: params.transaction_id || ''
    });
  }

  configureClarity();
  configureGoogleAds();

  fetch('/api/tracking-config')
    .then(response => response.json())
    .then(({ containerId }) => {
      containerId = containerId || defaultContainerId;
      if (!containerId) {
        if (isDevelopment) console.warn('[tracking] GTM_CONTAINER_ID is missing. GTM is disabled.');
        return;
      }
      if (!/^GTM-[A-Z0-9]+$/i.test(containerId)) {
        if (isDevelopment) console.warn('[tracking] GTM_CONTAINER_ID is invalid. GTM is disabled.');
        return;
      }
      if (document.querySelector(`script[src*="googletagmanager.com/gtm.js?id=${containerId}"]`)) return;
      dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
      const script = document.createElement('script');
      script.async = true;
      script.src = `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(containerId)}`;
      document.head.appendChild(script);
    })
    .catch(() => {
      if (isDevelopment) console.warn('[tracking] Could not load GTM configuration.');
    });
})();
