/**
 * NOL World Queue Monitor - Content Script
 * 
 * Monitors the queue/waiting page on world.nol.com and sends
 * queue data to the background service worker for notifications.
 */

(function () {
  'use strict';

  // Avoid duplicate monitoring loops, but allow re-injection for message listener
  const alreadyMonitoring = window.__nolQueueMonitorStarted;
  window.__nolQueueMonitorStarted = true;

  const LOG_PREFIX = '[NOL Queue Monitor]';

  // Supported label patterns (multilingual)
  const WAITING_ORDER_LABELS = [
    'my waiting order',
    'waiting order',
    // Simplified Chinese
    '我的等候顺位',
    '等候顺位',
    // Traditional Chinese
    '我的等候順位',
    '我的等待順位',
    '等待順位',
    // Korean
    '대기 순서',
    '대기순서',
    // Japanese
    '私の順番'
  ];

  const WAITING_PEOPLE_LABELS = [
    'number of waiting people',
    'waiting people',
    // Simplified Chinese
    '现在等候人数',
    '等候人数',
    // Traditional Chinese
    '現在等候人數',
    '等候人數',
    // Korean
    '대기 인원',
    '대기인원',
    // Japanese
    '現在の待機人数'
  ];

  const BOOKING_RATE_LABELS = [
    'booking rate',
    // Simplified Chinese
    '预订率',
    '订购率',
    // Traditional Chinese
    '預訂率',
    '訂購率',
    // Korean
    '예매율',
    // Japanese
    '予約率'
  ];

  const ERROR_TEXT_PATTERNS = [
    // Simplified Chinese
    '长时间内没有任何回应，此订单已被取消',
    '此订单已被取消',
    '非正常接近',
    '请从新开始',

    // Traditional Chinese
    '長時間內沒有任何回應，此訂單已被取消',
    '此訂單已被取消',
    '請從新開始',

    // English / Interpark dialog variants
    'no response for a long time',
    'order has been cancelled',
    'order has been canceled',
    'orders have been cancelled',
    'orders have been canceled',
    'cancelled due to no response',
    'canceled due to no response',
    'booking has been terminated',
    'terminated due to inactivity',
    'inactivity for a long time',
    'reservation has been terminated',
    'booking has been cancelled',
    'booking has been canceled',
    'unauthorized access',
    'please try again from the start',

    // Korean (common Interpark error messages)
    '장시간 응답이 없어 예약이 취소되었습니다',
    '예약이 취소되었습니다',
    '예약이 종료되었습니다',
    '비정상적인 접근입니다',
    '처음부터 다시 시도해 주세요',

    // Japanese (from screenshots)
    'しばらく応答がなかったので、予約が終了されました',
    '予約が終了されました',
    '不正アクセスです',
    '最初からやり直してください'
  ];

  let lastQueueData = null;
  let lastErrorText = null;
  let observer = null;
  let pollingInterval = null;
  let isQueuePage = false;

  // Wake-up alarm (起床铃) state
  let alarmAudioCtx = null;
  let alarmTimer = null;

  /**
   * Log helper
   */
  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  /**
   * Normalize number string: remove commas, spaces, %, etc.
   */
  function parseNumber(text) {
    if (!text) return null;
    const cleaned = String(text)
      .replace(/,/g, '')
      .replace(/\s/g, '')
      .replace(/%/g, '')
      .trim();
    const match = cleaned.match(/\d+/);
    return match ? parseInt(match[0], 10) : null;
  }

  /**
   * Check if an element is visible
   */
  function isVisible(el) {
    if (!el) return false;
    if (el.nodeType !== Node.ELEMENT_NODE) return true;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    return true;
  }

  /**
   * Get direct text content of an element (excluding nested elements)
   */
  function getDirectText(el) {
    if (!el) return '';
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      }
    }
    return text.trim();
  }

  /**
   * Check if element text contains any of the given patterns (case-insensitive)
   */
  function containsPattern(element, patterns) {
    if (!element || !element.textContent) return false;
    const text = element.textContent.toLowerCase();
    return patterns.some(pattern => text.includes(pattern.toLowerCase()));
  }

  /**
   * Check if an element is a leaf text element (no element children)
   */
  function isLeafTextElement(el) {
    return el && el.children.length === 0 && el.textContent.trim().length > 0;
  }

  /**
   * Find the numeric value associated with a label pattern.
   * Primary strategy: use the visible page text order (label → next number).
   * Fallback: DOM-based search using document order proximity.
   */
  function findNumberByLabel(labels, options = {}) {
    const preferPercent = options.preferPercent || false;

    // --- Strategy A: text-order based extraction ---
    // On Interpark queue pages, labels and values are concatenated in reading order:
    // "My waiting order18,778Number of waiting people21,352Booking Rate?99%"
    const pageText = document.body ? document.body.textContent : '';
    let textResult = null;
    let earliestLabelIndex = Infinity;

    for (const label of labels) {
      const idx = pageText.toLowerCase().indexOf(label.toLowerCase());
      if (idx === -1) continue;
      if (idx > earliestLabelIndex) continue; // Prefer earliest occurrence

      const afterLabel = pageText.substring(idx + label.length);
      let match = null;

      if (preferPercent) {
        // Try to find a number followed by % first
        match = afterLabel.match(/([\d,]+)\s*%/);
      }
      if (!match) {
        match = afterLabel.match(/[\d,]+/);
      }

      if (match) {
        const num = parseNumber(match[0]);
        if (num !== null) {
          textResult = num;
          earliestLabelIndex = idx;
        }
      }
    }

    if (textResult !== null) {
      return textResult;
    }

    // --- Strategy B: DOM-based fallback using document order ---
    const labelElements = [];
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      if (!isVisible(el)) continue;
      if (el.children.length > 5) continue;
      if (containsPattern(el, labels)) {
        labelElements.push(el);
      }
    }

    let bestCandidate = null;
    let bestScore = -Infinity;

    for (const labelEl of labelElements) {
      const labelPosition = getTextNodeOffset(labelEl);

      // Search within ancestors up to 4 levels
      let container = labelEl;
      for (let level = 0; level < 4 && container; level++) {
        container = container.parentElement;
        if (!container) break;

        const candidates = [];

        // Visible leaf text elements inside container
        const descendants = container.querySelectorAll('*');
        for (const desc of descendants) {
          if (!isVisible(desc)) continue;
          if (desc === labelEl || labelEl.contains(desc)) continue;
          if (isLeafTextElement(desc)) {
            const txt = desc.textContent.trim();
            const hasPercent = txt.includes('%');
            const num = parseNumber(txt);
            if (num !== null) {
              candidates.push({ el: desc, num, hasPercent, position: getTextNodeOffset(desc) });
            }
          }
        }

        // Direct text of non-leaf siblings
        for (const sibling of container.children) {
          if (!isVisible(sibling)) continue;
          if (sibling === labelEl || labelEl.contains(sibling) || sibling.contains(labelEl)) continue;
          const txt = getDirectText(sibling);
          if (txt) {
            const hasPercent = txt.includes('%');
            const num = parseNumber(txt);
            if (num !== null) {
              candidates.push({ el: sibling, num, hasPercent, position: getTextNodeOffset(sibling) });
            }
          }
        }

        for (const cand of candidates) {
          // Only consider candidates that appear AFTER the label in document order
          if (cand.position < labelPosition) continue;

          const distance = cand.position - labelPosition;
          let score = 0;
          // Strongly prefer candidates close to the label in text order
          score -= distance * 0.5;
          // Prefer closer DOM levels
          score += (4 - level) * 10;
          // Prefer percent for booking rate
          if (preferPercent && cand.hasPercent) score += 50;

          if (score > bestScore) {
            bestScore = score;
            bestCandidate = cand.num;
          }
        }
      }
    }

    return bestCandidate;
  }

  /**
   * Get the character offset of an element's first text node within document.body.textContent
   */
  function getTextNodeOffset(el) {
    if (!el || !document.body) return 0;
    const fullText = document.body.textContent;
    const elText = el.textContent;
    if (!elText) return 0;
    const idx = fullText.indexOf(elText);
    return idx >= 0 ? idx : 0;
  }

  /**
   * Alternative extraction: look for large numbers on the page
   */
  function findLargeWaitingOrder() {
    // Queue pages usually show a very large bold number for the order
    const allElements = document.querySelectorAll('*');
    let bestCandidate = null;
    let bestFontSize = 0;

    for (const el of allElements) {
      if (el.children.length > 0) continue; // Leaf text nodes only
      const num = parseNumber(el.textContent);
      if (num === null || num < 1) continue;

      const style = window.getComputedStyle(el);
      const fontSize = parseFloat(style.fontSize) || 0;
      const fontWeight = parseFloat(style.fontWeight) || 0;

      // Prefer large, bold numbers
      const score = fontSize + (fontWeight > 500 ? 20 : 0);
      if (score > bestFontSize && fontSize >= 24) {
        bestFontSize = score;
        bestCandidate = num;
      }
    }

    return bestCandidate;
  }

  /**
   * Detect error/cancellation dialogs.
   * Only check visible, non-body elements to avoid matching page-wide text.
   */
  function detectErrorDialog() {
    const allElements = document.querySelectorAll('body *');
    const tagBlacklist = new Set(['script', 'style', 'noscript', 'iframe', 'object', 'embed']);

    for (const el of allElements) {
      if (tagBlacklist.has(el.tagName.toLowerCase())) continue;
      if (!isVisible(el)) continue;
      // Skip very large containers that likely contain the whole page text
      if (el.children.length > 10) continue;

      const text = (el.textContent || '').trim();
      if (!text) continue;
      const textLower = text.toLowerCase();

      for (const pattern of ERROR_TEXT_PATTERNS) {
        if (textLower.includes(pattern.toLowerCase())) {
          return text.substring(0, 200);
        }
      }
    }
    return null;
  }

  /**
   * Detect if the current page is a queue/waiting page
   */
  function detectQueuePage() {
    const text = document.body ? document.body.textContent.toLowerCase() : '';
    const hasOrderLabel = WAITING_ORDER_LABELS.some(l => text.includes(l.toLowerCase()));
    const hasPeopleLabel = WAITING_PEOPLE_LABELS.some(l => text.includes(l.toLowerCase()));
    const hasHighTrafficText = [
      'high volume of traffic',
      'please wait',
      // Simplified Chinese
      '请稍候',
      // Traditional Chinese
      '請稍候',
      // Japanese
      'お待ちください',
      // Korean
      '기다려주세요'
    ].some(p => text.includes(p));
    const hasQueueText = hasOrderLabel || hasPeopleLabel || hasHighTrafficText;
    return hasQueueText;
  }

  /**
   * Extract all queue-related data from the page
   */
  function extractQueueData() {
    const isQueuePage = detectQueuePage();

    let waitingOrder = isQueuePage ? findNumberByLabel(WAITING_ORDER_LABELS) : null;
    let waitingPeople = isQueuePage ? findNumberByLabel(WAITING_PEOPLE_LABELS) : null;
    let bookingRate = isQueuePage ? findNumberByLabel(BOOKING_RATE_LABELS, { preferPercent: true }) : null;

    // Fallback: if no waiting order found via label, try large number heuristic
    if (isQueuePage && waitingOrder === null) {
      waitingOrder = findLargeWaitingOrder();
    }

    const errorText = detectErrorDialog();

    // Calculate estimated people ahead
    let peopleAhead = null;
    if (waitingOrder !== null && waitingOrder > 0) {
      peopleAhead = waitingOrder - 1;
    }

    return {
      url: window.location.href,
      timestamp: Date.now(),
      waitingOrder,
      waitingPeople,
      bookingRate,
      peopleAhead,
      errorText,
      isQueuePage
    };
  }

  /**
   * Send queue data to background script
   */
  function sendToBackground(data) {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'QUEUE_UPDATE', data }, (response) => {
          if (chrome.runtime.lastError) {
            // Ignore errors when background is not ready
            log('Send message error:', chrome.runtime.lastError.message);
          }
        });
      }
    } catch (err) {
      log('Failed to send message:', err);
    }
  }

  /**
   * Check if data has meaningfully changed
   */
  function hasMeaningfulChange(prev, current) {
    if (!prev || !current) return true;
    const keys = ['waitingOrder', 'waitingPeople', 'bookingRate', 'errorText'];
    return keys.some(key => prev[key] !== current[key]);
  }

  /**
   * Main scan function
   */
  function scan() {
    const wasQueuePage = isQueuePage;
    isQueuePage = detectQueuePage();

    if (!isQueuePage && !wasQueuePage) {
      // Not a queue page, minimal logging
      return;
    }

    const data = extractQueueData();

    if (!isQueuePage && data.errorText === null) {
      // Page changed away from queue
      if (wasQueuePage) {
        log('Left queue page');
        sendToBackground({ ...data, event: 'LEFT_QUEUE' });
      }
      return;
    }

    if (hasMeaningfulChange(lastQueueData, data)) {
      log('Queue update:', data);
      sendToBackground({ ...data, event: 'UPDATE' });
      lastQueueData = data;
    }
  }

  /**
   * Start monitoring the page
   */
  function startMonitoring() {
    log('Content script started on', window.location.href);

    // Initial scan
    scan();

    // Set up MutationObserver for dynamic content changes
    observer = new MutationObserver((mutations) => {
      // Debounce: wait a bit for DOM to settle
      if (window.__nolScanTimeout) {
        clearTimeout(window.__nolScanTimeout);
      }
      window.__nolScanTimeout = setTimeout(scan, 300);
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // Backup polling every 2 seconds
    pollingInterval = setInterval(scan, 2000);

    // Also scan on visibility change (tab becomes active)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        scan();
      }
    });
  }

  /**
   * Play alert sound using Web Audio API
   */
  function playAlertSound() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) {
        log('Web Audio API not supported');
        return;
      }

      const ctx = new AudioContext();
      const now = ctx.currentTime;

      // Create oscillator for a pleasant alert tone
      const oscillator1 = ctx.createOscillator();
      const oscillator2 = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscillator1.type = 'sine';
      oscillator1.frequency.setValueAtTime(880, now); // A5
      oscillator1.frequency.exponentialRampToValueAtTime(440, now + 0.3);

      oscillator2.type = 'sine';
      oscillator2.frequency.setValueAtTime(1109, now); // C#6
      oscillator2.frequency.exponentialRampToValueAtTime(554, now + 0.3);

      gainNode.gain.setValueAtTime(0.3, now);
      gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.3);

      oscillator1.connect(gainNode);
      oscillator2.connect(gainNode);
      gainNode.connect(ctx.destination);

      oscillator1.start(now);
      oscillator2.start(now);
      oscillator1.stop(now + 0.35);
      oscillator2.stop(now + 0.35);

      // Play a second beep after a short delay
      setTimeout(() => {
        const ctx2 = new AudioContext();
        const osc = ctx2.createOscillator();
        const gain = ctx2.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, ctx2.currentTime);
        gain.gain.setValueAtTime(0.3, ctx2.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx2.currentTime + 0.3);
        osc.connect(gain);
        gain.connect(ctx2.destination);
        osc.start();
        osc.stop(ctx2.currentTime + 0.35);
      }, 400);

      log('Alert sound played');
    } catch (err) {
      log('Failed to play alert sound:', err);
    }
  }

  /**
   * Play a loud looping "wake-up" alarm (起床铃) using Web Audio.
   * Two alternating square-wave tones create a classic klaxon that loops
   * until stopAlarm() is called.
   */
  function startAlarm() {
    if (alarmAudioCtx) {
      // Already playing, just make sure the overlay is visible
      showAlarmOverlay();
      return;
    }
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) {
        log('Web Audio API not supported, cannot play alarm');
        return;
      }

      alarmAudioCtx = new AudioContext();
      if (alarmAudioCtx.state === 'suspended') {
        alarmAudioCtx.resume();
      }

      // Pleasant repeating wake-up chime: a major arpeggio (E5-G5-B5-G5)
      // built from sine waves with a gentle bell-like envelope. Far less
      // harsh than the old square-wave klaxon, but still easy to wake to.
      alarmStep = 0;
      alarmNextTime = alarmAudioCtx.currentTime + 0.05;
      scheduleAlarmNote();
      showAlarmOverlay();
      log('Wake-up alarm started');
    } catch (err) {
      log('Failed to start alarm:', err);
    }
  }

  // Arpeggio notes (Hz): E5, G5, B5, G5 — a bright major chord fragment
  const ALARM_NOTES = [659.25, 783.99, 987.77, 783.99];
  const ALARM_NOTE_DUR = 0.22;   // seconds per note
  const ALARM_GAP = 0.08;        // gap between notes
  const ALARM_LOOP_PAUSE = 0.5;  // pause before repeating the pattern
  let alarmStep = 0;
  let alarmNextTime = 0;

  /**
   * Schedule the next note of the chime, then self-reschedule until stopped.
   */
  function scheduleAlarmNote() {
    if (!alarmAudioCtx) return;
    const now = alarmAudioCtx.currentTime;

    // After finishing one full loop, add a short pause before repeating.
    if (alarmStep > 0 && alarmStep % ALARM_NOTES.length === 0) {
      alarmNextTime = Math.max(alarmNextTime, now) + ALARM_LOOP_PAUSE;
    }

    const note = ALARM_NOTES[alarmStep % ALARM_NOTES.length];
    const t0 = Math.max(now, alarmNextTime);

    const osc = alarmAudioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = note;

    const g = alarmAudioCtx.createGain();
    const attack = 0.01;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(1.0, t0 + attack);   // full, non-clipping volume
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + ALARM_NOTE_DUR);

    osc.connect(g);
    g.connect(alarmAudioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + ALARM_NOTE_DUR + 0.02);

    alarmStep++;
    alarmNextTime = t0 + ALARM_NOTE_DUR + ALARM_GAP;
    alarmTimer = setTimeout(scheduleAlarmNote, (ALARM_NOTE_DUR + ALARM_GAP) * 1000);
  }

  /**
   * Stop the wake-up alarm and remove the overlay.
   */
  function stopAlarm() {
    if (alarmTimer) {
      clearTimeout(alarmTimer);
      clearInterval(alarmTimer);
      alarmTimer = null;
    }
    if (alarmAudioCtx) {
      try {
        alarmAudioCtx.close();
      } catch (e) { /* ignore */ }
      alarmAudioCtx = null;
    }
    hideAlarmOverlay();
    log('Wake-up alarm stopped');
  }

  /**
   * Show a full-screen overlay with a big "stop" button (always visible on top).
   */
  function showAlarmOverlay() {
    hideAlarmOverlay();
    const overlay = document.createElement('div');
    overlay.id = '__nolAlarmOverlay';
    overlay.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'bottom:0',
      'z-index:2147483647', 'background:rgba(200,0,0,0.88)',
      'display:flex', 'flex-direction:column', 'align-items:center',
      'justify-content:center', 'font-family:sans-serif', 'color:#fff',
      'text-align:center', 'padding:20px'
    ].join(';') + ';';

    const title = document.createElement('div');
    title.textContent = '⏰ 起床铃！排队已到阈值 / 检测到异常';
    title.style.cssText = 'font-size:26px;font-weight:bold;margin-bottom:28px;line-height:1.4;';

    const btn = document.createElement('button');
    btn.textContent = '⏹ 停止起床铃';
    btn.style.cssText = [
      'font-size:22px', 'padding:18px 44px', 'border:none', 'border-radius:14px',
      'background:#fff', 'color:#c00', 'font-weight:bold', 'cursor:pointer',
      'box-shadow:0 4px 16px rgba(0,0,0,0.4)'
    ].join(';') + ';';
    btn.addEventListener('click', () => {
      stopAlarm();
      // Also let the background service worker know, so it can clear its
      // alarm state and the notification's stop button.
      if (typeof chrome !== 'undefined' && chrome.runtime) {
        try {
          chrome.runtime.sendMessage({ type: 'STOP_ALARM' });
        } catch (e) { /* ignore */ }
      }
    });

    overlay.appendChild(title);
    overlay.appendChild(btn);
    (document.body || document.documentElement).appendChild(overlay);
  }

  /**
   * Remove the alarm overlay if present.
   */
  function hideAlarmOverlay() {
    const existing = document.getElementById('__nolAlarmOverlay');
    if (existing) existing.remove();
  }

  /**
   * Listen for messages from background/popup (always register, even on re-injection)
   */
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    // Remove existing listener to avoid duplicates on re-injection
    if (window.__nolMessageListener) {
      chrome.runtime.onMessage.removeListener(window.__nolMessageListener);
    }

    window.__nolMessageListener = (message, sender, sendResponse) => {
      if (message.type === 'PLAY_ALERT_SOUND') {
        playAlertSound();
        sendResponse({ ok: true });
        return true;
      }

      if (message.type === 'PLAY_ALARM') {
        startAlarm();
        sendResponse({ ok: true });
        return true;
      }

      if (message.type === 'STOP_ALARM') {
        stopAlarm();
        sendResponse({ ok: true });
        return true;
      }

      if (message.type === 'GET_QUEUE_STATUS') {
        const freshData = extractQueueData();
        sendResponse({
          ok: true,
          data: freshData,
          isQueuePage: freshData.isQueuePage,
          debug: {
            url: window.location.href,
            title: document.title,
            bodyTextPreview: (document.body ? document.body.textContent : '').trim().substring(0, 300)
          }
        });
        return true;
      }

      return false;
    };

    chrome.runtime.onMessage.addListener(window.__nolMessageListener);
  }

  // Start monitoring only once
  if (!alreadyMonitoring) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startMonitoring);
    } else {
      startMonitoring();
    }
  }
})();
