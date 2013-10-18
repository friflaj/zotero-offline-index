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
          this.load();
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

  fetchURL: function(url) {
    // this whole rigemarole is to deal with the fact that the only known-to-work way to make *sure* the data is getting
    // interpreted as utf-8 is to stuff it in a html document that declares itself utf-8. I can't rely on browser
    // mime-type to be set properly across webdav servers.
    this.log('fetching ' + url);
    var request = new XMLHttpRequest();
    request.open('GET', url, false, Zotero.Sync.Storage.WebDAV._username, Zotero.Sync.Storage.WebDAV._password);  // `false` makes the request synchronous
    request.setRequestHeader("If-Modified-Since", new Date(0));
    request.send(null);
    if (request.status != 200) {
      throw 'could not fetch ' + url + ': ' + request.status;
    }
    var parser = new DOMParser();
    var doc = parser.parseFromString(request.responseText, "text/html");

    var data = {}
    for (meta of doc.getElementsByTagName('meta')) {
      if (meta.getAttribute('name') == 'application-name') {
        data['version'] = meta.getAttribute('content');
      }
    }

    for (div of doc.getElementsByTagName('div')) {
      var id = div.getAttribute('id');
      if (!id) { continue; }
      data[id] = div.textContent;
      if (div.getAttribute('class') == 'json') { data[id] = JSON.parse(data[id]); }
    }
    return data;
  },

  log: function(msg) {
          msg = '[' + this.DBNAME + '] ' + msg;
          Zotero.debug(msg);
          console.log(msg);
       },

  fetch: function() {
            try {
              this.fetchIndex();
            } catch (err) {
              this.log('fetch failed: ' + err + ' (' + err.stack + ')');
            }
         },

  fetchIndex: function() {
    if (!Zotero.Prefs.get("sync.storage.enabled") || Zotero.Prefs.get("sync.storage.protocol") != 'webdav') { return; }

    var scheme = Zotero.Prefs.get('sync.storage.scheme');
    var urlRoot = scheme + '://' + Zotero.Prefs.get('sync.storage.url') + '/zotero/.';

    var remote = null;

    try {
      remote = this.fetchURL(urlRoot + 'offline.html');
      if (!remote || !remote['hashes']) { throw "Offline index unavailable"; }

      var local = {'version' : Zotero.DB.valueQuery('select version from items join offlineindex.version')};
      if (remote['version'] != local['version']) {
        this.log('local version: ' + local['version'] + ', remote version: ' + remote['version']);
        this.reset();
      }
    } catch (err) {
      this.log('could not fetch status: ' + err);
      return;
    }

    this.log('getting local status');
    var local = {}
    var rows = Zotero.DB.query('SELECT items.key AS itemKey, _status.attachmentHash AS itemHash FROM items JOIN offlineindex.status AS _status ON items.itemID = _status.itemID JOIN fulltextItems ON fulltextItems.itemID = items.itemID WHERE (totalPages IS NOT NULL AND indexedPages = totalPages) OR (totalChars IS NOT NULL AND indexedChars = totalPages)') || [];
    for (row of rows) {
      local[row['itemKey']] = row['itemHash'];
    }

    this.log('scanning attachments');
    var processed = {'good': 0, 'bad': 0};
    for (item of Zotero.Items.getAll()) {
      if (!item.isAttachment()) { continue; }
      if (!remote['hashes'][item.key]) { this.log('no index for attachment ' + item.key); continue; }
      if (remote['hashes'][item.key] == local[item.key]) { this.log(item.key + ' up to date'); continue; }
      this.log('loading ' + item.key);

      try {
        // Zotero.DB.beginTransaction();
        Zotero.DB.query("DELETE FROM offlineindex.status WHERE itemID = ?", [item.id]);

        var data = this.fetchURL(urlRoot + item.key + '.offline.html');
        if (!data) { throw "Fetch failed for " + item.key; }

        var pages = (data['data']['pages'] || null);
        var chars = pages ? null : data['data']['chars'];
        var words = data['data']['words'];
        var text = data['text'];
        var wordsFetched = words.length;

        Zotero.DB.query("delete from offlineindex.fulltextwords");

        while (words.length > 0) {
          Zotero.DB.query('INSERT INTO offlineindex.fulltextwords (word) ' + ["SELECT '" + word + "'" for (word of words.splice(0, 50))].join(' UNION '));
        }
        this.log('Total words for ' + item.key + ': ' + Zotero.DB.valueQuery('select count(*) from offlineindex.fulltextwords'));

        Zotero.DB.query('INSERT INTO fulltextWords (word) SELECT word FROM offlineindex.fulltextwords EXCEPT SELECT word FROM fulltextWords');
        this.log('FTW accounted for? ' + Zotero.DB.valueQuery('select count(*) from fulltextwords ftw join offlineindex.fulltextwords oftw on oftw.word = ftw.word'));

        Zotero.DB.query('DELETE FROM fulltextItemWords WHERE itemID = ?', [item.id]);
        Zotero.DB.query('INSERT INTO fulltextItemWords (wordID, itemID) SELECT wordID, ? FROM fulltextWords ftw JOIN offlineindex.fulltextwords oftw ON oftw.word = ftw.word', [item.id]);
        this.log('FTIW accounted for? ' + Zotero.DB.valueQuery('select count(*) from fulltextitemwords ftiw join fulltextwords ftw on ftiw.wordID = ftw.wordID and ftiw.itemID = ?', [item.id]));

        this.log(item.key + ': ' + pages + ' pages, ' + chars + ' chars');
        Zotero.DB.query('REPLACE INTO fulltextItems (itemID, version, indexedPages, totalPages, indexedChars, totalChars) VALUES (?, 1, ?, ?, ?, ?)', [item.id, pages, pages, chars, chars]);

        Zotero.DB.query("INSERT INTO offlineindex.status (itemID, attachmentHash) VALUES (?, ?)", [item.id, remote['hashes'][item.key]]);
        // Zotero.DB.commitTransaction();

        var wordsStored = Zotero.DB.valueQuery('select count(*) from fulltextwords ftw join fulltextitemwords ftiw on ftw.wordID = ftiw.wordID join fulltextitems fti on ftiw.itemID = fti.itemID and fti.itemID = ?', [item.id]);
        if (wordsStored != wordsFetched) { throw "Wordcount mismatch for " + item.key + ": fetched " + wordsFetched + ", stored " + wordsStored; }

        // write .zotero-ft-info
        var infoFile = Zotero.Attachments.getStorageDirectory(item.id);
        infoFile.append(Zotero.Fulltext.pdfInfoCacheFile);
        if (pages) {
          Zotero.File.putContentsAsync(infoFile, "Pages: " + pages, 'UTF-8');
        } else {
          if (infoFile.exists()) {
            try {
              infoFile.remove(false);
            } catch (e) {
              Zotero.File.checkFileAccessError(e, cacheFile, 'delete');
            }
          }
        }
        var cacheFile = Zotero.Fulltext.getItemCacheFile(item.id);
        Zotero.File.putContentsAsync(cacheFile, text, 'UTF-8');
      } catch(err) {
        this.log('error: ' + err);
        processed['bad']++;
        continue;
      }
      processed['good']++;

    }
    this.log('scanning finished, good: ' + processed['good'] + ', bad: ' + processed['bad']);
    Zotero.DB.query('REPLACE INTO offlineindex.version (version) VALUES (?)', [remote['version']]);
    this.log('local version set to ' + remote['version']);
  }
};

// Initialize the utility
window.addEventListener('load', function(e) { Zotero.OfflineIndex.init(); }, false);
