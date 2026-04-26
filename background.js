// Open as side panel on icon click — stays open while browsing
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
});

// Keep side panel enabled on all tabs
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setOptions({ enabled: true });
});
