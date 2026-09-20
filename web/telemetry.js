/**
 * SiftrCode Lightweight Client Telemetry
 * Privacy-first, zero third-party dependencies, asynchronous and non-blocking.
 */
(function() {
  // Generate or retrieve persistent session ID
  let sessionId = sessionStorage.getItem('siftr_sid');
  if (!sessionId) {
    sessionId = 's_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now().toString(36);
    try { sessionStorage.setItem('siftr_sid', sessionId); } catch (e) {}
  }

  function sendEvent(eventName, properties) {
    const payload = {
      event: eventName,
      properties: properties || {},
      path: window.location.pathname,
      referrer: document.referrer || '',
      sessionId: sessionId,
      screen: `${window.innerWidth}x${window.innerHeight}`,
      timestamp: new Date().toISOString()
    };

    try {
      if (navigator.sendBeacon) {
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        navigator.sendBeacon('/api/telemetry/event', blob);
      } else {
        fetch('/api/telemetry/event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true
        }).catch(() => {});
      }
    } catch (e) {
      // Fail silently to never interrupt user interaction
    }
  }

  // Expose global tracker
  window.siftrTrack = sendEvent;

  // Track initial pageview
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => sendEvent('pageview', { title: document.title }));
  } else {
    sendEvent('pageview', { title: document.title });
  }

  // Intercept click events on actionable elements (copy buttons, demo toggles, modal triggers)
  document.addEventListener('click', function(e) {
    const target = e.target.closest('button, a, [data-track]');
    if (!target) return;

    // Track explicit data-track attributes
    const trackName = target.getAttribute('data-track');
    if (trackName) {
      sendEvent(trackName, { text: target.innerText?.trim().substring(0, 50) });
      return;
    }

    // Track copy actions
    const onClickAttr = target.getAttribute('onclick') || '';
    if (onClickAttr.includes('copy') || target.innerText?.includes('Copy') || target.title?.includes('Copy')) {
      const codeSnippet = target.closest('.group, div, pre')?.querySelector('code')?.innerText || '';
      sendEvent('cli_copy', {
        command: (codeSnippet || target.innerText || '').trim().substring(0, 80)
      });
    }

    // Track modal opens
    if (onClickAttr.includes('openTrialModal')) {
      sendEvent('modal_open', { modal: 'trial_b2b' });
    } else if (onClickAttr.includes('openFeedbackModal')) {
      sendEvent('modal_open', { modal: 'feedback' });
    }
  }, { passive: true });

  // Hook into custom AST simulator events if fired
  window.addEventListener('siftr:simulator_scan', function(e) {
    sendEvent('simulator_scan', e.detail || {});
  });
})();
