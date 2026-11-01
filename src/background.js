/*
 * better z.ai — background (Chrome MV3 service worker / Firefox event page).
 * Responsibilities: badge, notifications, live tab tracking (for the popup), install seed.
 * (core/defaults.js is prepended to this file at build time.)
 */
(function () {
  'use strict';

  var DEFAULTS = self.__zaiExtDefaults || {};

  function setAlive(tab) {
    try {
      chrome.storage.local.set({ aliveTab: { id: tab.id, at: Date.now() } });
    } catch (e) { /* ignore */ }
  }

  function getAlive(cb) {
    try {
      chrome.storage.local.get(['aliveTab'], function (got) {
        var a = got && got.aliveTab;
        if (!a || !a.id) return cb(null);
        if (Date.now() - (a.at || 0) > 6 * 3600000) return cb(null); // stale
        chrome.tabs.get(a.id, function (t) {
          if (chrome.runtime.lastError || !t) return cb(null);
          cb(t);
        });
      });
    } catch (e) { cb(null); }
  }

  chrome.runtime.onInstalled.addListener(function (details) {
    chrome.storage.local.get(['settings'], function (got) {
      if (!got || !got.settings) {
        chrome.storage.local.set({ settings: DEFAULTS, records: {}, log: [] });
      }
    });
  });

  chrome.runtime.onMessage.addListener(function (m, sender, sendResponse) {
    if (!m) return;
    if (m.type === 'badge') {
      try {
        var badgeApi = chrome.action || chrome.browserAction; // MV3: action, MV2 Firefox: browserAction
        badgeApi.setBadgeText({ text: m.text || '' });
        if (m.color) badgeApi.setBadgeBackgroundColor({ color: m.color });
      } catch (e) { /* ignore */ }
      sendResponse({ ok: true });
      return;
    }
    if (m.type === 'notify') {
      try {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: m.title || 'better z.ai',
          message: m.message || ''
        });
      } catch (e) { /* ignore */ }
      sendResponse({ ok: true });
      return;
    }
    if (m.type === 'alive' && sender && sender.tab) {
      setAlive(sender.tab);
      sendResponse({ ok: true });
      return;
    }
    if (m.type === 'GET_TAB') {
      getAlive(function (tab) {
        sendResponse({ tab: tab ? { id: tab.id, url: tab.url || '' } : null });
      });
      return true; // async
    }
    return;
  });

  chrome.notifications.onClicked.addListener(function () {
    getAlive(function (tab) {
      if (tab) {
        try {
          chrome.tabs.update(tab.id, { active: true });
          chrome.windows.update(tab.windowId, { focused: true });
          return;
        } catch (e) { /* ignore */ }
      }
      chrome.tabs.create({ url: 'https://chat.z.ai/' });
    });
  });

  /* ---------- keyboard shortcuts (commands API) ----------
   *
   * Alt+R — resend the pending message right now ("Retry now")
   * Alt+P — pause/resume automatic retries
   * Alt+E — export the current chat as Markdown
   *
   * The command is sent to the live z.ai tab (the content script handles CMD_SHORTCUT).
   */
  function sendToAliveTab(msg) {
    getAlive(function (tab) {
      if (!tab) return;
      try {
        chrome.tabs.sendMessage(tab.id, msg, function () {
          if (chrome.runtime.lastError) { /* tab is dead — wait for the next alive one */ }
        });
      } catch (e) { /* ignore */ }
    });
  }

  try {
    chrome.commands.onCommand.addListener(function (command) {
      sendToAliveTab({ cmd: 'CMD_SHORTCUT', action: command });
    });
  } catch (e) { /* commands not supported */ }
})();
