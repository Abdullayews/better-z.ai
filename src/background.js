/*
 * Z.ai Auto-Resend — background (Chrome MV3 service worker / Firefox event page).
 * Vəzifəsi: badge, bildirişlər, canlı tab izləməsi (popup üçün), quraşdırma toxumu.
 * (Build zamanı bu faylın ƏVVƏLİNƏ core/defaults.js yapışdırılır.)
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
        if (Date.now() - (a.at || 0) > 6 * 3600000) return cb(null); // köhnədir
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
    if (details && details.reason === 'install') {
      try { chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') }); } catch (e) { /* ignore */ }
    }
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
          title: m.title || 'Z.ai Auto-Resend',
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
})();
