Zotero.OfflineIndex = {
  DBNAME: 'zotero-offline-index',

  init: function () {
    var db = new Zotero.DBConnection(this.DBNAME);
    db.query('CREATE TABLE IF NOT EXISTS version (version PRIMARY KEY)');
    db.query('CREATE TABLE IF NOT EXISTS status (itemID NOT NULL, attachmentHash NOT NULL)');
    db.query('CREATE TABLE IF NOT EXISTS fulltextwords (word NOT NULL)');
    db.closeDatabase();
    Zotero.DB.query("ATTACH '" + Zotero.getZoteroDatabase(this.DBNAME).path + "' AS 'offlineindex'");

    // monkey-patch Zotero.Sync.Runner.stop
    Zotero.Sync.Runner.stop = (function (self, original)
    {
      return function ()
      {
        try {
          getOfflineData();
        } catch (err) {
          Zotero.debug('Error getting remote index: ' + err);
        }
        return original.apply(this);
      }
    })(this, Zotero.Sync.Runner.stop);
  },

  reset: function()
  {
    Zotero.DB.query('DELETE FROM fulltextWords');
    Zotero.DB.query('DELETE FROM fulltextItemWords');
    Zotero.DB.query('DELETE FROM fulltextItems');
    Zotero.DB.query('DELETE FROM offlineindex.status');
    Zotero.DB.query('DELETE FROM offlineindex.version');
  },

  getOfflineData: function()
  {
    if (!Zotero.Prefs.get("sync.storage.enabled") || Zotero.Prefs.get("sync.storage.protocol") != 'webdav') { return; }

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

      var local = {'version' : Zotero.DB.valueQuery('select version from items join offlineindex.version')};
      if (remote['version'] != local['version']) {
        this.reset();
      }
    } catch (err) {
      Zotero.debug('Could not fetch ' + url + ': ' + err);
      return;
    }

    var local = {}
    var rows = Zotero.DB.query('select items.key as itemKey, offlineindex.status.attachmentHash as itemHash from items join offlineindex.status on items.itemID = offlineindex.status.itemID') || [];
    rows.map(function(row){
      local[row['itemKey']] = row['itemHash'];
    });

    Zotero.Items.getAll().map(function(item){
      if (!remote[item.key] || remote[item.key] == local[item.key] || !item.isAttachment()) { return; }

      Zotero.DB.beginTransaction();
      Zotero.DB.query("delete from offlineindex.status where itemID = ?", [item.id]);

      var url = urlRoot + item.key + '.offline.txt';
      Zotero.debug('Fetching: ' + url);

      try {
        Zotero.debug('Fetching offline index: ' + url);
        var request = new XMLHttpRequest();
        request.open('GET', url, false, username, password);  // `false` makes the request synchronous
        request.send(null);

        if (request.status === 200) {
          var data = JSON.parse(request.responseText);
          Zotero.DB.query("delete from offlineindex.fulltextwords");

          while (data['words'].length > 0) {
            Zotero.DB.query('INSERT INTO offlineindex.fulltextwords (word) ' + data['words'].splice(0, 50).map(function(word){ return "SELECT '" + word + "'"; }).join(' UNION '));
          }

          Zotero.DB.query('INSERT INTO fulltextWords (word) SELECT word FROM offlineindex.fulltextwords EXCEPT SELECT word FROM fulltextWords');
          Zotero.DB.query('INSERT INTO fulltextItemWords (wordID, itemID) SELECT wordID, ? FROM fulltextWords EXCEPT SELECT wordID, ? from fulltextItemWords', [item.id, item.id]);
          Zotero.DB.query('DELETE FROM fulltextItemWords where itemID is ? and wordID not in (SELECT wordID FROM fulltextWords JOIN offlineindex.fulltextwords ON fulltextWords.word = offlineindex.fulltextwords.word)', [item.id]);
          if (data['pages']) { data['chars'] = null; }
          Zotero.DB.query('REPLACE INTO fulltextItems SET version = 1, indexedPages = ?, totalPages = ?, indexedChars = ?, totalChars = ? WHERE itemID = ?', [data['pages'], data['pages'], data['chars'], data['chars']]);
        }
      } catch(err) {
        Zotero.debug('Offline Index error: ' + err);
        return;
      }

      Zotero.DB.query("INSERT INTO offlineindex.status (itemID, attachmentHash) VALUES (?, ?)", [item.id, remote[item.key]]);
      Zotero.DB.commitTransaction();
    });
    Zotero.DB.query('REPLACE INTO offlineindex.version WHERE version=?', [remote['version']]);
  }
};

// Initialize the utility
window.addEventListener('load', function(e) { Zotero.OfflineIndex.init(); }, false);
