/**
 * NOL World Queue Monitor - Background Service Worker
 * 
 * Receives queue updates from content scripts, compares against user thresholds,
 * sends Feishu (Lark) bot notifications, and triggers browser notifications.
 */

const LOG_PREFIX = '[NOL Queue Monitor BG]';
// Feishu (Lark) custom bot webhook is supplied by the user as a full URL,
// so no fixed API endpoint constant is needed here.

// Cooldown periods (milliseconds)
const ERROR_COOLDOWN = 60 * 1000;          // 1 minute for the same error text

// In-memory state
let lastStates = {
  error: { time: 0, text: null }
};

// Wake-up alarm (起床铃) state
let alarmActive = false;
let alarmNotificationId = null;

/**
 * Log helper
 */
function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

/**
 * Get user settings from chrome.storage.local
 */
async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      {
        enabled: true,
        configured: false,
        feishuWebhook: '',
        threshold: 500,
        thresholds: [500],
        firedThresholds: [],
        enableFeishu: true,
        enableSound: true,
        enableBrowserNotification: true,
        enableAlarm: false,
        titleTemplate: 'NOL 排队提醒'
      },
      (result) => resolve(result)
    );
  });
}

/**
 * Persist which threshold values have already fired (one-time only)
 */
function saveFiredThresholds(fired) {
  chrome.storage.local.set({ firedThresholds: fired });
}

/**
 * Send Feishu (Lark) custom-bot notification.
 * The user supplies the full webhook URL (settings.feishuWebhook).
 */
async function sendFeishu(settings, title, content) {
  const webhook = settings.feishuWebhook?.trim();
  if (!webhook) {
    log('Feishu webhook not configured, skipping');
    return { success: false, reason: 'no_webhook' };
  }

  try {
    const text = `${title}\n\n${content}`;
    const response = await fetch(webhook, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        msg_type: 'text',
        content: { text: text }
      })
    });

    const result = await response.json();
    log('Feishu response:', result);

    // Feishu custom bot returns { code: 0, msg: 'success' } on success
    if (result.code === 0 || result.msg === 'success' || result.StatusMessage === 'success') {
      return { success: true, data: result };
    } else {
      return { success: false, reason: 'api_error', detail: result };
    }
  } catch (err) {
    log('Feishu request failed:', err);
    return { success: false, reason: 'network_error', detail: err.message };
  }
}

/**
 * Show native browser notification
 * @param {boolean} withStopButton - when true (alarm active), add a "停止起床铃" button
 */
function showBrowserNotification(title, message, withStopButton = false) {
  const id = `nol-queue-${Date.now()}`;
  const options = {
    type: 'basic',
    iconUrl: 'icon.png',
    title: title,
    message: message,
    priority: 2,
    requireInteraction: true
  };
  if (withStopButton) {
    options.buttons = [{ title: '⏹ 停止起床铃' }];
    alarmNotificationId = id;
  }
  chrome.notifications.create(id, options, (notificationId) => {
    if (chrome.runtime.lastError) {
      log('Notification error:', chrome.runtime.lastError.message);
    } else {
      log('Browser notification created:', notificationId);
    }
  });
}

/**
 * Tell content scripts to play the wake-up alarm (起床铃)
 */
async function playAlarm() {
  alarmActive = true;
  try {
    const nolTabs = await chrome.tabs.query({ url: '*://*.nol.com/*' });
    const interparkTabs = await chrome.tabs.query({ url: '*://*.interpark.com/*' });
    const tabs = [...nolTabs, ...interparkTabs];
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'PLAY_ALARM' }, () => {
          if (chrome.runtime.lastError) { /* ignore tabs without content script */ }
        });
      }
    }
    log('Wake-up alarm triggered');
  } catch (err) {
    log('Failed to send play alarm message:', err);
  }
}

/**
 * Tell content scripts to stop the wake-up alarm (起床铃)
 */
async function stopAlarm() {
  alarmActive = false;
  if (alarmNotificationId) {
    chrome.notifications.clear(alarmNotificationId, () => {});
    alarmNotificationId = null;
  }
  try {
    const nolTabs = await chrome.tabs.query({ url: '*://*.nol.com/*' });
    const interparkTabs = await chrome.tabs.query({ url: '*://*.interpark.com/*' });
    const tabs = [...nolTabs, ...interparkTabs];
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'STOP_ALARM' }, () => {
          if (chrome.runtime.lastError) { /* ignore */ }
        });
      }
    }
    log('Wake-up alarm stopped');
  } catch (err) {
    log('Failed to send stop alarm message:', err);
  }
}

/**
 * Tell content scripts to play alert sound
 */
async function playAlertSound() {
  try {
    const nolTabs = await chrome.tabs.query({ url: '*://*.nol.com/*' });
    const interparkTabs = await chrome.tabs.query({ url: '*://*.interpark.com/*' });
    const tabs = [...nolTabs, ...interparkTabs];
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'PLAY_ALERT_SOUND' }, () => {
          // Ignore errors for tabs that don't have content script
          if (chrome.runtime.lastError) {
            // Silent ignore
          }
        });
      }
    }
  } catch (err) {
    log('Failed to send play sound message:', err);
  }
}

/**
 * Handle threshold reached notification
 * @param {number} thresholdValue - the specific threshold that was crossed
 */
async function handleThresholdReached(settings, data, thresholdValue) {
  const peopleAhead = data.peopleAhead ?? data.waitingOrder ?? '未知';

  const title = `${settings.titleTemplate}：前方只剩 ${peopleAhead} 人（已低于阈值 ${thresholdValue}）`;
  const content = [
    `触发阈值：前方人数 ≤ ${thresholdValue}`,
    `当前排队顺位：${data.waitingOrder ?? '未检测到'}`,
    `前方等候人数：${data.peopleAhead ?? '未检测到'}`,
    `总等候人数：${data.waitingPeople ?? '未检测到'}`,
    `预订率：${data.bookingRate ? data.bookingRate + '%' : '未检测到'}`,
    `时间：${new Date().toLocaleString()}`
  ].join('\n');

  // Send Feishu (only if enabled)
  let pushResult = { success: false, reason: 'disabled' };
  if (settings.enableFeishu) {
    pushResult = await sendFeishu(settings, title, content);
  } else {
    log('Feishu disabled by user setting, skipping push');
  }

  // Browser notification
  if (settings.enableBrowserNotification) {
    showBrowserNotification(title, `前方约 ${peopleAhead} 人（阈值 ${thresholdValue}），赶紧去抢票！`, settings.enableAlarm);
  }

  // Sound
  if (settings.enableSound) {
    playAlertSound();
  }

  // Wake-up alarm (loops until stopped)
  if (settings.enableAlarm) {
    playAlarm();
  }

  return pushResult;
}

/**
 * Handle error/cancellation dialog detected
 */
async function handleErrorDetected(settings, data) {
  if (!data.errorText) return;

  const now = Date.now();
  const errorText = data.errorText;

  // Deduplicate same error within cooldown
  if (
    lastStates.error.text === errorText &&
    now - lastStates.error.time < ERROR_COOLDOWN
  ) {
    log('Same error notification on cooldown');
    return;
  }
  lastStates.error.text = errorText;
  lastStates.error.time = now;

  const title = 'NOL 排队异常提醒';
  const content = [
    `检测到异常：${errorText}`,
    `当前排队顺位：${data.waitingOrder ?? '未检测到'}`,
    `时间：${new Date().toLocaleString()}`,
    '请尽快回到浏览器检查页面状态。'
  ].join('\n');

  // Respect the same notification switches as threshold reminders
  let pushResult = { success: false, reason: 'disabled' };
  if (settings.enableFeishu) {
    pushResult = await sendFeishu(settings, title, content);
  } else {
    log('Feishu disabled by user setting, skipping push for error');
  }

  if (settings.enableBrowserNotification) {
    showBrowserNotification(title, errorText, settings.enableAlarm);
  }

  if (settings.enableSound) {
    playAlertSound();
  }

  if (settings.enableAlarm) {
    playAlarm();
  }

  return pushResult;
}

/**
 * Process incoming queue update
 */
async function processQueueUpdate(data) {
  const settings = await getSettings();

  if (!settings.enabled || settings.configured !== true) {
    log('Extension disabled or not configured yet, skipping');
    return;
  }

  // 1. Error/cancellation has highest priority
  if (data.errorText) {
    await handleErrorDetected(settings, data);
    return;
  }

  // 2. Queue threshold check (multiple thresholds, each fires once)
  const peopleAhead = data.peopleAhead ?? data.waitingOrder;
  if (peopleAhead === null) return;

  // Resolve threshold list: prefer `thresholds` array, fall back to legacy single value
  let thresholds = Array.isArray(settings.thresholds) && settings.thresholds.length > 0
    ? settings.thresholds
    : [typeof settings.threshold === 'number' ? settings.threshold : 500];

  // Track which threshold values have already fired (one-time only)
  let fired = Array.isArray(settings.firedThresholds) ? settings.firedThresholds.slice() : [];
  const newlyFired = [];

  for (const t of thresholds) {
    if (peopleAhead <= t && !fired.includes(t)) {
      await handleThresholdReached(settings, data, t);
      newlyFired.push(t);
    }
  }

  if (newlyFired.length > 0) {
    // Merge newly fired values, then prune any no longer in the configured list
    fired = fired.concat(newlyFired).filter((v) => thresholds.includes(v));
    saveFiredThresholds(fired);
  }
}

/**
 * Message listener from content scripts and popup
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'QUEUE_UPDATE') {
    processQueueUpdate(message.data)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        log('Error processing queue update:', err);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // Async response
  }

  if (message.type === 'TEST_FEISHU') {
    const settings = message.settings || {};
    const title = 'NOL 排队监控测试通知';
    const content = [
      '这是一条测试通知。',
      '如果你能在飞书收到这条消息，说明飞书配置成功。',
      `时间：${new Date().toLocaleString()}`
    ].join('\n');

    sendFeishu(settings, title, content)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, reason: 'exception', detail: err.message }));
    return true;
  }

  if (message.type === 'TEST_SOUND') {
    playAlertSound()
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, reason: 'exception', detail: err.message }));
    return true;
  }

  if (message.type === 'TEST_BROWSER_NOTIFICATION') {
    const title = 'NOL 排队监控测试通知';
    showBrowserNotification(title, '浏览器通知测试');
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'TEST_ALARM') {
    playAlarm();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'STOP_ALARM') {
    stopAlarm();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'GET_SETTINGS') {
    getSettings().then((settings) => sendResponse(settings));
    return true;
  }

  if (message.type === 'SAVE_SETTINGS') {
    chrome.storage.local.set(message.settings, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  return false;
});

/**
 * Notification interactions: clicking the "停止起床铃" button (or the
 * notification body) stops the wake-up alarm.
 */
if (typeof chrome !== 'undefined' && chrome.notifications) {
  chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
    if (notificationId === alarmNotificationId) {
      log('Alarm notification button clicked, stopping alarm');
      stopAlarm();
    }
  });
  chrome.notifications.onClicked.addListener((notificationId) => {
    if (notificationId === alarmNotificationId) {
      log('Alarm notification clicked, stopping alarm');
      stopAlarm();
    }
  });
}

/**
 * Initialize on install/update
 */
chrome.runtime.onInstalled.addListener((details) => {
  log('Extension installed/updated:', details.reason);
});

log('Background service worker started');
