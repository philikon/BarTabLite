/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is BarTab.
 *
 * The Initial Developer of the Original Code is
 * Philipp von Weitershausen.
 * Portions created by the Initial Developer are Copyright (C) 2011
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/AddonManager.jsm");

let unloaders = [];

// This will contain the file:// uri pointing to bartab.css
let css_uri;

const ONTAB_ATTR = "bartab-ontab";
const CONCURRENT_TABS_PREF = "browser.sessionstore.max_concurrent_tabs";
const BACKUP_PREF = "extensions.bartab.backup_concurrent_tabs";

/**
 * Lots of rubbish that's necessary because we're a restartless add-on
 * (no default preferences, no chrome manifest)
 */
function startup(data, reason) {
  if (!Services.prefs.prefHasUserValue(BACKUP_PREF)) {
    Services.prefs.setIntPref(
      BACKUP_PREF, Services.prefs.getIntPref(CONCURRENT_TABS_PREF));
    Services.prefs.setIntPref(CONCURRENT_TABS_PREF, 0);
  }

  AddonManager.getAddonByID(data.id, function(addon) {
    css_uri = addon.getResourceURI("bartab.css").spec;

    // Register BarTabLite handler for all existing windows and windows
    // that will still be opened.
    eachWindow(loadIntoWindow);

    Services.ww.registerNotification(windowWatcher);
    unloaders.push(function() {
      Services.ww.unregisterNotification(windowWatcher);
    });
  });
}

function shutdown(data, reason) {
  if (reason == APP_SHUTDOWN) {
    return;
  }

  if (Services.prefs.prefHasUserValue(BACKUP_PREF)) {
    Services.prefs.setIntPref(
      CONCURRENT_TABS_PREF, Services.prefs.getIntPref(BACKUP_PREF));
    Services.prefs.clearUserPref(BACKUP_PREF);
  }

  unloaders.forEach(function(unload) {
    if (unload) {
      unload();
    }
  });
  unloaders = [];
  css_uri = null;
}

function eachWindow(callback) {
  let enumerator = Services.wm.getEnumerator("navigator:browser");
  while (enumerator.hasMoreElements()) {
    let win = enumerator.getNext();
    if (win.document.readyState === "complete") {
      callback(win);
    } else {
      runOnLoad(win, callback);
    }
  }
}

function runOnLoad(window, callback) {
  window.addEventListener("load", function onLoad() {
    window.removeEventListener("load", onLoad, false);
    callback(window);
  }, false);
}

function windowWatcher(subject, topic) {
  if (topic !== "domwindowopened") {
    return;
  }
  let win = subject.QueryInterface(Ci.nsIDOMWindow);
  // We don't know the type of the window at this point yet, only when
  // the load event has been fired.
  runOnLoad(win, function (win) {
    let doc = win.document.documentElement;
    if (doc.getAttribute("windowtype") == "navigator:browser") {
      loadIntoWindow(win);
    }
  });
}

function loadIntoWindow(win) {
  // Load stylesheet.
  let pi = win.document.createProcessingInstruction(
    "xml-stylesheet", "href=\"" + css_uri + "\" type=\"text/css\"");
  win.document.insertBefore(pi, win.document.firstChild);
  unloaders.push(function () {
    win.document.removeChild(pi);
  });

  // Install BarTabLite hook.
  let barTabLite = new BarTabLite(win.gBrowser);
  unloaders.push(barTabLite.unload.bind(barTabLite));
}


/**
 * This handler attaches to the tabbrowser.  It listens to various tab
 * related events.
 */
function BarTabLite(aTabBrowser) {
  this.init(aTabBrowser);
}
BarTabLite.prototype = {

  init: function(aTabBrowser) {
    this.tabBrowser = aTabBrowser;
    aTabBrowser.BarTabLite = this;
    aTabBrowser.tabContainer.addEventListener('SSTabRestoring', this, false);
  },

  unload: function() {
    let tabBrowser = this.tabBrowser;
    tabBrowser.tabContainer.removeEventListener('SSTabRestoring', this, false);
    delete tabBrowser.BarTabLite;
  },

  handleEvent: function(aEvent) {
    switch (aEvent.type) {
      case 'SSTabRestoring':
        this.onTabRestoring(aEvent);
        return;
    }
  },

  /**
   * Handle the 'SSTabRestoring' event from the nsISessionStore service
   * and mark tabs that haven't loaded yet.
   */
  onTabRestoring: function(aEvent) {
    let tab = aEvent.originalTarget;
    if (tab.selected || tab.getAttribute(ONTAB_ATTR) == "true") {
      return;
    }
    tab.setAttribute(ONTAB_ATTR, "true");
    (new BarTabRestoreProgressListener()).hook(tab);
  }
};


/**
 * Progress listener for tabs that are being restored but haven't
 * loaded yet.
 */
function BarTabRestoreProgressListener () {}
BarTabRestoreProgressListener.prototype = {

  hook: function (aTab) {
    this._tab = aTab;
    aTab._barTabRestoreProgressListener = this;
    aTab.linkedBrowser.webProgress.addProgressListener(
      this, Ci.nsIWebProgress.NOTIFY_STATE_NETWORK);
  },

  unhook: function () {
    this._tab.linkedBrowser.webProgress.removeProgressListener(this);
    delete this._tab._barTabRestoreProgressListener;
    delete this._tab;
  },

  /*** nsIWebProgressListener ***/

  onStateChange: function (aWebProgress, aRequest, aStateFlags, aStatus) {
    this._tab.removeAttribute(ONTAB_ATTR);
    this.unhook();
  },
  onProgressChange: function () {},
  onLocationChange: function () {},
  onStatusChange:   function () {},
  onSecurityChange: function () {},

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIWebProgressListener,
                                         Ci.nsISupportsWeakReference])
};
