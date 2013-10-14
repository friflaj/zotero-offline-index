Zotero.OfflineIndex = {
  DBNAME: 'zotero-offline-index',

  init: function () {
    var db = new Zotero.DBConnection(this.DBNAME);
    db.query('CREATE TABLE IF NOT EXISTS version (version PRIMARY KEY)');
    db.query('CREATE TABLE IF NOT EXISTS status (itemID NOT NULL, attachmentHash NOT NULL)');
    db.query('CREATE TABLE IF NOT EXISTS fulltextwords (word NOT NULL)');
    db.closeDatabase();
    Zotero.DB.query("ATTACH '" + Zotero.getZoteroDatabase(this.DBNAME).path + "' AS 'offlineindex'");
    this.log(this.DBNAME + ' attached');

    // monkey-patch Zotero.Sync.Runner.stop
    Zotero.Sync.Runner.stop = (function (self, original)
    {
      return function ()
      {
        try {
          this.fetch();
        } catch (err) {
          this.log('error getting remote index: ' + err);
        }
        this.log('patched Zotero.Sync.Runner.stop');
        return original.apply(this);
      }
    })(this, Zotero.Sync.Runner.stop);
  },

  reset: function() {
    this.log('clearing fulltext index');
    Zotero.DB.query('DELETE FROM fulltextItems');
    Zotero.DB.query('DELETE FROM fulltextItemWords');
    Zotero.DB.query('DELETE FROM fulltextWords');
    Zotero.DB.query('DELETE FROM offlineindex.status');
    Zotero.DB.query('DELETE FROM offlineindex.version');
    this.log('fulltext index cleared');
  },

  data: function(url) {
    // this whole rigemarole is to deal with the fact that the only known-to-work way to make *sure* the data is getting
    // interpreted as utf-8 is to stuff it in a html document that declares itself utf-8. I can't rely on browser
    // mime-type to be set properly across webdav servers.
    this.log('fetching status from ' + url);
    var request = new XMLHttpRequest();
    request.open('GET', url, false, Zotero.Sync.Storage.WebDAV._username, Zotero.Sync.Storage.WebDAV._password);  // `false` makes the request synchronous
    request.setRequestHeader("If-Modified-Since", new Date(0));
    request.send(null);
    if (request.status != 200) {
      this.log('could not fetch ' + url + ': ' + request.status);
      return null;
    }
    var parser = new DOMParser();
    var doc = parser.parseFromString(request.responseText, "text/html");
    
    return JSON.parse(doc.getElementsByTagName ("body")[0].textContent);
  },

  log: function(msg) {
          msg = '[' + this.DBNAME + '] ' + msg;
          Zotero.debug(msg);
          console.log(msg);
       },

  fetch: function() {
    if (!Zotero.Prefs.get("sync.storage.enabled") || Zotero.Prefs.get("sync.storage.protocol") != 'webdav') { return; }

    var scheme = Zotero.Prefs.get('sync.storage.scheme');
    var urlRoot = scheme + '://' + Zotero.Prefs.get('sync.storage.url') + '/zotero/.';

    var remote = null;

    try {
      remote = this.data(urlRoot + 'offline.html');
      if (!remote) { return; }

      var local = {'version' : Zotero.DB.valueQuery('select version from items join offlineindex.version')};
      if (remote['version'] != local['version']) {
        this.log('local version: ' + local['version'] + ', remote version: ' + remote['version']);
        this.reset();
      }
    } catch (err) {
      this.log('could not fetch status: ' + err);
      return;
    }
    remote = remote['hash'];

    this.log('getting local status');
    var local = {}
    var rows = Zotero.DB.query('select items.key as itemKey, _status.attachmentHash as itemHash from items join offlineindex.status as _status on items.itemID = _status.itemID') || [];
    for (row of rows) {
      local[row['itemKey']] = row['itemHash'];
    }

    this.log('scanning attachments');
    for (item of Zotero.Items.getAll()) {
      if (!item.isAttachment()) { continue; }
      if (!remote[item.key]) { this.log('no index for attachment ' + item.key); continue; }
      if (remote[item.key] == local[item.key]) { this.log(item.key + ' up to date'); continue; }
      this.log('loading ' + item.key);

      Zotero.DB.beginTransaction();
      Zotero.DB.query("DELETE FROM offlineindex.status WHERE itemID = ?", [item.id]);

      try {
        var data = this.data(urlRoot + item.key + '.offline.html');
        if (data) {
          Zotero.DB.query("delete from offlineindex.fulltextwords");

          while (data['words'].length > 0) {
            Zotero.DB.query('INSERT INTO offlineindex.fulltextwords (word) ' + ["SELECT '" + word + "'" for (word of data['words'].splice(0, 50))].join(' UNION '));
          }

          Zotero.DB.query('INSERT INTO fulltextWords (word) SELECT word FROM offlineindex.fulltextwords EXCEPT SELECT word FROM fulltextWords');
          Zotero.DB.query('INSERT INTO fulltextItemWords (wordID, itemID) SELECT wordID, ? FROM fulltextWords EXCEPT SELECT wordID, ? from fulltextItemWords', [item.id, item.id]);
          Zotero.DB.query('DELETE FROM fulltextItemWords where itemID is ? and wordID not in (SELECT wordID FROM fulltextWords JOIN offlineindex.fulltextwords as _fulltextWords ON fulltextWords.word = _fulltextWords.word)', [item.id]);
          var pages = (data['pages'] || null);
          var chars = (data['chars'] || null);
          Zotero.DB.query('REPLACE INTO fulltextItems (itemID, version, indexedPages, totalPages, indexedChars, totalChars) VALUES (?, 1, ?, ?, ?, ?)', [item.id, pages, pages, chars, chars]);
        }
      } catch(err) {
        this.log('error: ' + err);
        continue;
      }

      Zotero.DB.query("INSERT INTO offlineindex.status (itemID, attachmentHash) VALUES (?, ?)", [item.id, remote[item.key]]);
      Zotero.DB.commitTransaction();
    }
    this.log('scanning finished');
    Zotero.DB.query('REPLACE INTO offlineindex.version (version) VALUES (?)', [remote['version']]);
    this.log('local version set to ' + remote['version']);
  }
};

// Initialize the utility
window.addEventListener('load', function(e) { Zotero.OfflineIndex.init(); }, false);
