(function() {
  const dataLayer = window.dataLayer = window.dataLayer || [];
  const defaultContainerId = 'GTM-NDCKPZ6Z';
  const privateKeys = new Set(['email', 'phone', 'phone_number', 'user_name', 'username', 'full_name', 'first_name', 'last_name']);
  const isDevelopment = ['localhost', '127.0.0.1'].includes(window.location.hostname);

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
    if (isDevelopment) console.log(`[tracking] ${eventName}`, safe);
  }

  window.KillerWorkTracking = { trackEvent };

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
