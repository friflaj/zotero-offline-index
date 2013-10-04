Zotero.OfflineScan = {
  init: function () {
    // monkey-patch Zotero.Sync.Runner
    Zotero.Sync.Runner.stop = (function (self, original)
    {
      return function ()
      {
        v = original.apply(this);

        if (Zotero.Prefs.get("sync.storage.enabled") && Zotero.Prefs.get("sync.storage.protocol") == 'webdav') {
          var scheme = Zotero.Prefs.get('sync.storage.scheme');
          var url = scheme + '://' + Zotero.Prefs.get('sync.storage.url') + '/zotero/.annotations.txt';
          var username = Zotero.Sync.Storage.WebDAV._username;
          var password = Zotero.Sync.Storage.WebDAV._password;

          try {
            Zotero.debug('Fetching annotations: ' + url);
            var request = new XMLHttpRequest();
            request.open('GET', url, false, username, password);  // `false` makes the request synchronous
            request.send(null);

            Zotero.debug('Annotation status: ' + request.status);

            if (request.status === 200) {
              var data = JSON.parse(request.responseText);
            }
          } catch(err) {
              Zotero.debug('Annotation error: ' + err);
          }
        }
        return v;
      }
    })(this, Zotero.Sync.Runner.stop);
  }

};

// Initialize the utility
window.addEventListener('load', function(e) { Zotero.OfflineScan.init(); }, false);
