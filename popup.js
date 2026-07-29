/**
 * NOL World Queue Monitor - Popup UI Script
 */

(function () {
  'use strict';

  // DOM elements
  const els = {
    enabled: document.getElementById('enabled'),
    settings: document.querySelector('.settings'),
    feishuWebhook: document.getElementById('feishuWebhook'),
    thresholdList: document.getElementById('thresholdList'),
    addThresholdBtn: document.getElementById('addThresholdBtn'),
    enableFeishu: document.getElementById('enableFeishu'),
    enableSound: document.getElementById('enableSound'),
    enableBrowserNotification: document.getElementById('enableBrowserNotification'),
    enableAlarm: document.getElementById('enableAlarm'),
    saveBtn: document.getElementById('saveBtn'),
    testFeishuBtn: document.getElementById('testFeishuBtn'),
    testSoundBtn: document.getElementById('testSoundBtn'),
    testBrowserBtn: document.getElementById('testBrowserBtn'),
    testAlarmBtn: document.getElementById('testAlarmBtn'),
    stopAlarmBtn: document.getElementById('stopAlarmBtn'),
    message: document.getElementById('message'),
    statusCard: document.getElementById('statusCard'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    errorBanner: document.getElementById('errorBanner'),
    errorText: document.getElementById('errorText'),
    refreshBtn: document.getElementById('refreshBtn'),
    debugText: document.getElementById('debugText')
  };

  const MAX_THRESHOLDS = 5;

  // `configured` becomes true the first time the user clicks 「保存设置」.
  // Until then, queue monitoring notifications are disabled.
  let isConfigured = false;

  const defaults = {
    enabled: true,
    configured: false,
    settingsLocked: false,
    feishuWebhook: '',
    threshold: 500,
    thresholds: [500],
    firedThresholds: [],
    enableFeishu: true,
    enableSound: true,
    enableBrowserNotification: true,
    enableAlarm: false,
    titleTemplate: 'NOL 排队提醒'
  };

  /**
   * Show temporary message
   */
  function showMessage(text, type = 'success') {
    els.message.textContent = text;
    els.message.className = `message ${type}`;
    setTimeout(() => {
      els.message.className = 'message';
      els.message.textContent = '';
    }, 3000);
  }

  /**
   * Load settings from storage and update UI
   */
  async function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(defaults, (result) => {
        isConfigured = result.configured === true;

        els.enabled.checked = result.enabled;
        els.feishuWebhook.value = result.feishuWebhook || '';
        els.enableFeishu.checked = result.enableFeishu;
        els.enableSound.checked = result.enableSound;
        els.enableBrowserNotification.checked = result.enableBrowserNotification;
        els.enableAlarm.checked = result.enableAlarm;

        // Determine threshold list: prefer `thresholds`, fall back to legacy single `threshold`
        let thresholds = Array.isArray(result.thresholds) ? result.thresholds : null;
        if (!thresholds || thresholds.length === 0) {
          const legacy = typeof result.threshold === 'number' ? result.threshold : 500;
          thresholds = [legacy];
        }
        renderThresholdRows(thresholds);

        setSettingsLocked(result.settingsLocked === true);

        resolve(result);
      });
    });
  }

  /**
   * Add a single threshold input row
   */
  function addThresholdRow(value) {
    const row = document.createElement('div');
    row.className = 'threshold-row';

    const prefix = document.createElement('span');
    prefix.className = 'threshold-prefix';
    prefix.textContent = '≤';

    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = '1';
    input.value = (typeof value === 'number') ? value : 500;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-remove';
    removeBtn.type = 'button';
    removeBtn.title = '删除该阈值';
    removeBtn.textContent = '−';
    removeBtn.addEventListener('click', () => {
      row.remove();
      updateRemoveButtonsState();
    });

    row.appendChild(prefix);
    row.appendChild(input);
    row.appendChild(removeBtn);
    els.thresholdList.appendChild(row);

    updateRemoveButtonsState();
    return row;
  }

  /**
   * Disable the add button when the maximum number of rows is reached
   */
  function updateAddButtonState() {
    const rows = els.thresholdList.querySelectorAll('.threshold-row');
    const atMax = rows.length >= MAX_THRESHOLDS;
    els.addThresholdBtn.disabled = atMax;
    els.addThresholdBtn.textContent = atMax ? `已达上限（最多 ${MAX_THRESHOLDS} 个）` : '+ 添加阈值';
  }

  /**
   * Render all threshold rows from an array of values
   */
  function renderThresholdRows(values) {
    els.thresholdList.innerHTML = '';
    if (!Array.isArray(values) || values.length === 0) {
      values = [500];
    }
    // Cap to the maximum allowed number of thresholds
    if (values.length > MAX_THRESHOLDS) {
      values = values.slice(0, MAX_THRESHOLDS);
    }
    values.forEach((v) => addThresholdRow(v));
    updateAddButtonState();
  }

  /**
   * Collect threshold values from the rows
   */
  function collectThresholds() {
    const inputs = els.thresholdList.querySelectorAll('input[type="number"]');
    const result = [];
    inputs.forEach((input) => {
      const num = parseInt(input.value, 10);
      if (!isNaN(num) && num >= 0) {
        result.push(num);
      }
    });
    return result.length > 0 ? result : [0];
  }

  /**
   * Disable the remove button when only one row remains
   */
  function updateRemoveButtonsState() {
    const rows = els.thresholdList.querySelectorAll('.threshold-row');
    const disable = rows.length <= 1;
    rows.forEach((row) => {
      const btn = row.querySelector('.btn-remove');
      if (btn) btn.disabled = disable;
    });
    updateAddButtonState();
  }

  /**
   * Save current UI settings to storage and lock editing
   */
  function saveSettings() {
    const settings = {
      enabled: els.enabled.checked,
      configured: true,
      settingsLocked: true,
      feishuWebhook: els.feishuWebhook.value.trim(),
      threshold: collectThresholds()[0] || 0,
      thresholds: collectThresholds(),
      // Reset all thresholds to "not yet fired" so every threshold can trigger again,
      // even if its numeric value was not changed by the user.
      firedThresholds: [],
      enableFeishu: els.enableFeishu.checked,
      enableSound: els.enableSound.checked,
      enableBrowserNotification: els.enableBrowserNotification.checked,
      enableAlarm: els.enableAlarm.checked
    };

    chrome.storage.local.set(settings, () => {
      if (chrome.runtime.lastError) {
        showMessage('保存失败：' + chrome.runtime.lastError.message, 'error');
      } else {
        isConfigured = true;
        setSettingsLocked(true);
        showMessage('设置已保存');
        refreshStatus();
      }
    });
  }

  /**
   * Toggle settings section between locked (view) and unlocked (edit) mode
   */
  function setSettingsLocked(locked) {
    if (locked) {
      els.settings.classList.add('settings-locked');
      els.saveBtn.textContent = '修改设置';
    } else {
      els.settings.classList.remove('settings-locked');
      els.saveBtn.textContent = '保存设置';
    }

    // Disable/enable all settings inputs and non-test buttons
    // (keep save/test/stop buttons usable even when locked)
    const inputs = els.settings.querySelectorAll('input, button');
    inputs.forEach((el) => {
      if (el.classList.contains('btn-test')) return;
      if (el.id === 'saveBtn') return;
      if (el.id === 'stopAlarmBtn') return;
      el.disabled = locked;
    });
  }

  /**
   * Update status UI from queue data
   */
  function updateStatus(data, isQueuePage, debug = null) {
    if (debug) {
      els.debugText.textContent = JSON.stringify({
        isQueuePage,
        url: debug.url,
        title: debug.title,
        data,
        bodyPreview: debug.bodyTextPreview
      }, null, 2);
    }

    if (!isConfigured) {
      els.statusDot.className = 'status-dot warning';
      els.statusText.textContent = '请先保存设置以开启监控';
      els.errorBanner.style.display = 'none';
      return;
    }

    if (!isQueuePage) {
      els.statusDot.className = 'status-dot';
      els.statusText.textContent = '未在排队页面';
      els.errorBanner.style.display = 'none';
      return;
    }

    if (data.errorText) {
      els.statusDot.className = 'status-dot danger';
      els.statusText.textContent = '检测到异常';
      els.errorBanner.style.display = 'block';
      els.errorText.textContent = data.errorText;
      return;
    }

    els.statusDot.className = 'status-dot active';
    els.statusText.textContent = '正在监控排队进度';
    els.errorBanner.style.display = 'none';
  }

  /**
   * Query the active tab for current queue status.
   * If content script is not injected, inject it programmatically (no page refresh needed).
   */
  async function refreshStatus(retry = false) {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const activeTab = tabs[0];

      const isTargetUrl = activeTab.url.includes('nol.com') || activeTab.url.includes('interpark.com');
      if (!activeTab || !activeTab.url || !isTargetUrl) {
        updateStatus(null, false);
        return;
      }

      try {
        const response = await chrome.tabs.sendMessage(activeTab.id, { type: 'GET_QUEUE_STATUS' });
        if (response && response.ok) {
          updateStatus(response.data, response.isQueuePage, response.debug);
          return;
        }
      } catch (msgErr) {
        // Content script not injected, try to inject it
        if (!retry) {
          log('Content script not detected, injecting programmatically...');
          try {
            await chrome.scripting.executeScript({
              target: { tabId: activeTab.id, allFrames: true },
              files: ['content.js']
            });
            // Wait a moment for script to initialize, then retry
            setTimeout(() => refreshStatus(true), 500);
            return;
          } catch (injectErr) {
            log('Failed to inject content script:', injectErr);
          }
        }
      }

      updateStatus(null, false);
    } catch (err) {
      log('refreshStatus error:', err);
      updateStatus(null, false);
    }
  }

  function log(...args) {
    console.log('[NOL Queue Popup]', ...args);
  }

  /**
   * Test Feishu notification only
   */
  function testFeishu() {
    const webhook = els.feishuWebhook.value.trim();
    if (!webhook) {
      showMessage('请先填写飞书机器人 Webhook 地址', 'error');
      return;
    }

    els.testFeishuBtn.disabled = true;
    els.testFeishuBtn.textContent = '...';

    chrome.runtime.sendMessage(
      { type: 'TEST_FEISHU', settings: { feishuWebhook: webhook } },
      (response) => {
        els.testFeishuBtn.disabled = false;
        els.testFeishuBtn.textContent = '测试';

        if (chrome.runtime.lastError) {
          showMessage('测试失败：' + chrome.runtime.lastError.message, 'error');
          return;
        }

        if (response && response.success) {
          showMessage('飞书测试已发送，请查看飞书');
        } else {
          const reason = response?.detail?.msg || response?.reason || '未知错误';
          showMessage('飞书测试失败：' + reason, 'error');
        }
      }
    );
  }

  /**
   * Test browser sound only
   */
  function testSound() {
    els.testSoundBtn.disabled = true;
    els.testSoundBtn.textContent = '...';

    chrome.runtime.sendMessage(
      { type: 'TEST_SOUND' },
      () => {
        els.testSoundBtn.disabled = false;
        els.testSoundBtn.textContent = '测试';

        if (chrome.runtime.lastError) {
          showMessage('铃声测试失败：' + chrome.runtime.lastError.message, 'error');
          return;
        }
        showMessage('浏览器铃声已播放');
      }
    );
  }

  /**
   * Test browser notification only
   */
  function testBrowserNotification() {
    els.testBrowserBtn.disabled = true;
    els.testBrowserBtn.textContent = '...';

    chrome.runtime.sendMessage(
      { type: 'TEST_BROWSER_NOTIFICATION' },
      () => {
        els.testBrowserBtn.disabled = false;
        els.testBrowserBtn.textContent = '测试';

        if (chrome.runtime.lastError) {
          showMessage('通知测试失败：' + chrome.runtime.lastError.message, 'error');
          return;
        }
        showMessage('浏览器通知已弹出');
      }
    );
  }

  /**
   * Test wake-up alarm only
   */
  function testAlarm() {
    els.testAlarmBtn.disabled = true;
    els.testAlarmBtn.textContent = '...';

    chrome.runtime.sendMessage(
      { type: 'TEST_ALARM' },
      () => {
        els.testAlarmBtn.disabled = false;
        els.testAlarmBtn.textContent = '测试';

        if (chrome.runtime.lastError) {
          showMessage('起床铃测试失败：' + chrome.runtime.lastError.message, 'error');
          return;
        }
        showMessage('起床铃已播放，页面上点「停止起床铃」可停止');
      }
    );
  }

  /**
   * Stop the wake-up alarm from the popup
   */
  function stopAlarm() {
    chrome.runtime.sendMessage({ type: 'STOP_ALARM' }, () => {
      if (chrome.runtime.lastError) {
        showMessage('停止失败：' + chrome.runtime.lastError.message, 'error');
        return;
      }
      showMessage('起床铃已停止');
    });
  }

  /**
   * Initialize popup
   */
  async function init() {
    await loadSettings();
    await refreshStatus();

    // Event listeners
    els.saveBtn.addEventListener('click', () => {
      if (els.saveBtn.textContent === '修改设置') {
        setSettingsLocked(false);
      } else {
        saveSettings();
      }
    });
    els.testFeishuBtn.addEventListener('click', testFeishu);
    els.testSoundBtn.addEventListener('click', testSound);
    els.testBrowserBtn.addEventListener('click', testBrowserNotification);
    els.testAlarmBtn.addEventListener('click', testAlarm);
    els.stopAlarmBtn.addEventListener('click', stopAlarm);
    els.addThresholdBtn.addEventListener('click', () => {
      const rows = els.thresholdList.querySelectorAll('.threshold-row');
      if (rows.length >= MAX_THRESHOLDS) {
        showMessage(`最多只能设置 ${MAX_THRESHOLDS} 个阈值`, 'error');
        return;
      }
      addThresholdRow(500);
    });
    els.refreshBtn.addEventListener('click', () => {
      els.refreshBtn.textContent = '...';
      refreshStatus().finally(() => {
        els.refreshBtn.textContent = '↻';
      });
    });

    // Master enable toggle auto-saves immediately (it is outside the locked notification settings section)
    els.enabled.addEventListener('change', () => {
      chrome.storage.local.set({ enabled: els.enabled.checked });
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
