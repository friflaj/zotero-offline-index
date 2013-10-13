Zotero.OfflineIndex = {
  DB: null,
  DBNAME: 'zotero-offline-index',

  init: function () {
    this.DB = new Zotero.DBConnection(this.DBNAME);
    this.DB.query('PRAGMA temp_store = MEMORY');
    this.DB.query('CREATE TABLE IF NOT EXISTS status (itemID NOT NULL, attachmentHash NOT NULL)');
    this.DB.query('CREATE TABLE IF NOT EXISTS fulltextwords (word NOT NULL)');
    Zotero.DB.query("ATTACH '" + Zotero.getZoteroDatabase(this.DBNAME).path + "' AS 'offlineindex'");

    function getOfflineData()
    {
      if (!Zotero.Prefs.get("sync.storage.enabled") || Zotero.Prefs.get("sync.storage.protocol") != 'webdav') { return; }

      Zotero.DB.query("DELETE FROM offlineindex.fulltextwords");

      var scheme = Zotero.Prefs.get('sync.storage.scheme');
      var urlRoot = scheme + '://' + Zotero.Prefs.get('sync.storage.url') + '/zotero/.';
      var username = Zotero.Sync.Storage.WebDAV._username;
      var password = Zotero.Sync.Storage.WebDAV._password;

      var remote = null;

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
        remote = JSON.parse(request.responseText);
      } catch (err) {
          Zotero.debug('Could not fetch ' + url + ': ' + err);
          return;
      }

      var local = {}
      var rows = Zotero.DB.query('select items.key, offlineindex.status.attachmentHash from items join offlineindex.status on items.itemID = offlineindex.status.itemID');
      for each(var row in rows) {
        local[row[0]] = row[1];
      }

      for each(var item in Zotero.Items.getAll()) {
        if (!remote[item.key] || remote[item.key] == local[item.key] || !item.isAttachment()) { continue; }

        Zotero.DB.beginTransaction();
        Zotero.DB.query("delete from offlineindex.status where itemID = ?", [item.id]);

        var url = urlRoot + item.key + '.offline.txt';
        Zotero.debug('Fetching: ' + url);

        try {
          Zotero.debug('Fetching annotations: ' + url);
          var request = new XMLHttpRequest();
          request.open('GET', url, false, username, password);  // `false` makes the request synchronous
          request.send(null);

          if (request.status === 200) {
            var data = JSON.parse(request.responseText);
            Zotero.DB.query("delete from offlineindex.fulltextwords");
            for (var word in data['words']) {
              Zotero.DB.query("insert into offlineindex.fulltextwords (word) values (?)", [word]);
            }

            Zotero.DB.query('INSERT INTO fulltextWords (word) SELECT word FROM offlineindex.fulltextwords EXCEPT SELECT word FROM fulltextWords');
            Zotero.DB.query('INSERT INTO fulltextItemWords (wordID, itemID) SELECT wordID, ? FROM fulltextWords EXCEPT SELECT wordID, ? from fulltextItemWords', [item.id, item.id]);
            Zotero.DB.query('DELETE FROM fulltextItemWords where itemID is ? and wordID not in (SELECT wordID FROM fulltextWords JOIN offlineindex.fulltextwords ON fulltextWords.word = offlineindex.fulltextwords.word)', [item.id]);
            if (data['pages']) { data['chars'] = null; }
            Zotero.DB.query('REPLACE INTO fulltextItems SET version = 1, indexedPages = ?, totalPages = ?, indexedChars = ?, totalChars = ? WHERE itemID = ?', [data['pages'], data['pages'], data['chars'], data['chars']]);
          }
        } catch(err) {
          Zotero.debug('Annotation error: ' + err);
          continue;
        }

        Zotero.DB.query("INSERT INTO offlineindex.status (itemID, attachmentHash) VALUES (?, ?)", [item.id, remote[item.key]]);
        Zotero.DB.commitTransaction();
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
