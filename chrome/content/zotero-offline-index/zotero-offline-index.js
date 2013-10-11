Zotero.OfflineIndex = {
  init: function () {
    function getOfflineData()
    {
      if (!Zotero.Prefs.get("sync.storage.enabled") || Zotero.Prefs.get("sync.storage.protocol") != 'webdav') { return; }

      Zotero.DB.query("CREATE TEMPORARY TABLE IF NOT EXISTS fulltextimport (word, chars)");
      Zotero.DB.query("DELETE FROM fulltextimport");

      var scheme = Zotero.Prefs.get('sync.storage.scheme');
      var urlRoot = scheme + '://' + Zotero.Prefs.get('sync.storage.url') + '/zotero/.';
      var username = Zotero.Sync.Storage.WebDAV._username;
      var password = Zotero.Sync.Storage.WebDAV._password;

      var status = null;

      try {
        var url = urlRoot + 'offline.txt';
        Zotero.debug('Fetching status: from ' + url);
        var request = new XMLHttpRequest();
        request.open('GET', url, false, username, password);  // `false` makes the request synchronous
        request.send(null);
        if (request.status != 200) {
          Zotero.debug('Could not fetch ' + url + ': ' + request.status);
          return;
        }
        status = JSON.parse(request.responseText);
      } catch (err) {
          Zotero.debug('Could not fetch ' + url + ': ' + err);
          return;
      }

      var hashes = {}
      var rows = Zotero.DB.query('select items.key, fulltextItems.attachmentHash from items join fulltextItems on items.itemID = fulltextItems.itemID where attachmentHash is not null');
      for each(var row in rows) {
        hashes[row[0]] = row[1];
      }

      for each(var item in Zotero.Items.getAll()) {
        if (!status[item.key] || status[item.key] == hashes[item.key] || !item.isAttachment()) { continue; }

        Zotero.DB.query("REPLACE INTO fulltextItems (itemID, version, attachmentHash) VALUES (?,?,NULL)", [item.id, 1]);

        var url = urlRoot + item.key + '.offline.txt';
        Zotero.debug('Fetching: ' + url);

        try {
          Zotero.debug('Fetching annotations: ' + url);
          var request = new XMLHttpRequest();
          request.open('GET', url, false, username, password);  // `false` makes the request synchronous
          request.send(null);

          if (request.status === 200) {
            var data = JSON.parse(request.responseText);
            Zotero.debug('Annotation chars: ' + data['chars']);
            // actually update fulltext index here
          }
        } catch(err) {
          Zotero.debug('Annotation error: ' + err);
          continue;
        }

        Zotero.DB.query("UPDATE fulltextItems set attachmentHash = ? where itemID = ?", [status[item.key], item.id]);
      }
    }

    // monkey-patch Zotero.Sync.Runner.stop
    Zotero.Sync.Runner.stop = (function (self, original)
    {
      return function ()
      {
        getOfflineData();
        return original.apply(this);
      }
    })(this, Zotero.Sync.Runner.stop);
  }
};

// Initialize the utility
window.addEventListener('load', function(e) { Zotero.OfflineIndex.init(); }, false);
