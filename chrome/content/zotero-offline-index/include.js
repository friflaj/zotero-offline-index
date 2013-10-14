// Only create main object once
if (!Zotero.OfflineIndex) {
	let loader = Components.classes["@mozilla.org/moz/jssubscript-loader;1"].getService(Components.interfaces.mozIJSSubScriptLoader);
	loader.loadSubScript("chrome://zotero-offline-index/content/zotero-offline-index.js");
}
