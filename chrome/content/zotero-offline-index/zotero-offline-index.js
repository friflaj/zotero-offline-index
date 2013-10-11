Zotero.OfflineIndex = {
  DB: null,
  DBNAME: 'zotero-offline-index.sqlite',

  init: function () {
    this.DB = new Zotero.DBConnection(this.DBNAME);
    this.DB.query('PRAGMA temp_store = MEMORY');
    this.DB.query('CREATE TABLE IF NOT EXISTS status (itemID NOT NULL, attachmentHash NOT NULL)');
    this.DB.query('CREATE TEMP TABLE IF NOT EXISTS fulltextwords (words NOT NULL, length NOT NULL)');
    Zotero.DB.query('ATTACH ' + this.DBNAME + ' AS offlineindex');

    function getOfflineData()
    {
      if (!Zotero.Prefs.get("sync.storage.enabled") || Zotero.Prefs.get("sync.storage.protocol") != 'webdav') { return; }

      Zotero.DB.query("DELETE FROM offlineindex.fulltextimport");

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
            Zotero.debug('Annotation chars: ' + data['chars']);
            // actually update fulltext index here
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
