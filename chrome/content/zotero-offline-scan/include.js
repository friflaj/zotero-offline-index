// Only create main object once
if (!Zotero.OfflineScan) {
	let loader = Components.classes["@mozilla.org/moz/jssubscript-loader;1"]
					.getService(Components.interfaces.mozIJSSubScriptLoader);
	loader.loadSubScript("chrome://zotero-offline-scan/content/zotero-offline-scan.js");
}
