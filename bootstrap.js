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

// This will contain the file:// uri pointing to bartab.css
let css_uri;

const ONTAB_ATTR = "bartab-ontab";
const RESTORE_ON_DEMAND_PREF = "browser.sessionstore.restore_on_demand";
const NS_XUL = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

XPCOMUtils.defineLazyServiceGetter(this, "gSessionStore",
                                   "@mozilla.org/browser/sessionstore;1",
                                   "nsISessionStore");

/**
 * Load and execute another file.
 */
let GLOBAL_SCOPE = this;
function include(src) {
  Services.scriptloader.loadSubScript(src, GLOBAL_SCOPE);
}

/**
 * Lots of rubbish that's necessary because we're a restartless add-on
 * (no default preferences, no chrome manifest)
 */
function startup(data, reason) {
  //TODO we should really save a backup here, even if this pref is true
  // by default.
  Services.prefs.setBoolPref(RESTORE_ON_DEMAND_PREF, true);

  if (reason != APP_STARTUP) {
    return;
  }

  css_uri = data.resourceURI.spec + "bartab.css";
  include(data.resourceURI.spec + "utils.js");
  // Register BarTabLite handler for all existing windows and windows
  // that will still be opened.
  watchWindows(loadIntoWindow, "navigator:browser");
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

  unload();
}

function loadIntoWindow(win) {
  // Load stylesheet.
  let pi = win.document.createProcessingInstruction(
    "xml-stylesheet", "href=\"" + css_uri + "\" type=\"text/css\"");
  win.document.insertBefore(pi, win.document.firstChild);
  unload(function () {
    win.document.removeChild(pi);
  }, win);

  // Install BarTabLite hook.
  let barTabLite = new BarTabLite(win.gBrowser);
  unload(barTabLite.unload.bind(barTabLite), win);
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

    let document = aTabBrowser.ownerDocument;
    let menuitem_unloadTab = document.createElementNS(NS_XUL, "menuitem");
    menuitem_unloadTab.setAttribute("label", "Unload Tab"); // TODO l10n
    menuitem_unloadTab.setAttribute("tbattr", "tabbrowser-multiple");
    menuitem_unloadTab.setAttribute(
      "oncommand", "gBrowser.BarTabLite.unloadTab(gBrowser.mContextTab);");
    let tabContextMenu = document.getElementById("tabContextMenu");
    tabContextMenu.insertBefore(menuitem_unloadTab,
                                tabContextMenu.childNodes[1]);
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
  },

  /**
   * Unload a tab.
   */
  unloadTab: function(aTab) {
    // Ignore tabs that are already unloaded or are on the host whitelist.
    if (aTab.getAttribute(ONTAB_ATTR) == "true") {
      return;
    }

    let tabbrowser = this.tabBrowser;

    // Make sure that we're not on this tab.  If we are, find the
    // closest tab that isn't on the bar tab.
    if (aTab.selected) {
      let activeTab = this.findClosestLoadedTab(aTab);
      if (activeTab) {
        tabbrowser.selectedTab = activeTab;
      }
    }

    let state = gSessionStore.getTabState(aTab);
    let newtab = tabbrowser.addTab(null, {skipAnimation: true});
    // If we ever support a mode where 'browser.sessionstore.max_concurrent_tabs'
    // wasn't set to 0, we'd have to do some trickery here.
    gSessionStore.setTabState(newtab, state);

    // Move the new tab next to the one we're removing, but not in
    // front of it as that confuses Tree Style Tab.
    tabbrowser.moveTabTo(newtab, aTab._tPos + 1);

    // Restore tree when using Tree Style Tab
    if (tabbrowser.treeStyleTab) {
      let parent = tabbrowser.treeStyleTab.getParentTab(aTab);
      if (parent) {
        tabbrowser.treeStyleTab.attachTabTo(newtab, parent,
          {dontAnimate: true, insertBefore: aTab.nextSibling});
      }
      let children = tabbrowser.treeStyleTab.getChildTabs(aTab);
      children.forEach(function(aChild) {
        tabbrowser.treeStyleTab.attachTabTo(
          aChild, newtab, {dontAnimate: true});
      });
    }

    // Close the original tab.  We're taking the long way round to
    // ensure the nsISessionStore service won't save this in the
    // recently closed tabs.
    if (tabbrowser._beginRemoveTab(aTab, true, null, false)) {
      tabbrowser._endRemoveTab(aTab);
    }
  },

  unloadOtherTabs: function(aTab) {
    let tabbrowser = this.tabBrowser;

    // Make sure we're sitting on the tab that isn't going to be unloaded.
    if (tabbrowser.selectedTab != aTab) {
      tabbrowser.selectedTab = aTab;
    }

    // unloadTab() mutates the tabs so the only sane thing to do is to
    // copy the list of tabs now and then work off that list.
    //TODO can we use Array.slice() here?
    let tabs = [];
    for (let i = 0; i < tabbrowser.mTabs.length; i++) {
      tabs.push(tabbrowser.mTabs[i]);
    }
    for (let i = 0; i < tabs.length; i++) {
      if (tabs[i] != aTab) {
        this.unloadTab(tabs[i]);
      }
    }
  },

  /*
   * In relation to a given tab, find the closest tab that is loaded.
   * Note: if there's no such tab available, this will return unloaded
   * tabs as a last resort.
   */
  findClosestLoadedTab: function(aTab) {
    let tabbrowser = this.tabBrowser;

    // Shortcut: if this is the only tab available, we're not going to
    // find another active one, are we...
    if (tabbrowser.mTabs.length == 1) {
      return null;
    }

    // The most obvious choice would be the owner tab, if it's active.
    if (aTab.owner
        && Services.prefs.getBoolPref("browser.tabs.selectOwnerOnClose")
        && aTab.owner.getAttribute(ONTAB_ATTR) != "true") {
      return aTab.owner;
    }

    // Otherwise walk the tab list and see if we can find an active one.
    let i = 1;
    while ((aTab._tPos - i >= 0) ||
         (aTab._tPos + i < tabbrowser.mTabs.length)) {
      if (aTab._tPos + i < tabbrowser.mTabs.length) {
        if (tabbrowser.mTabs[aTab._tPos+i].getAttribute(ONTAB_ATTR) != "true") {
          return tabbrowser.mTabs[aTab._tPos+i];
        }
      }
      if (aTab._tPos - i >= 0) {
        if (tabbrowser.mTabs[aTab._tPos-i].getAttribute(ONTAB_ATTR) != "true") {
          return tabbrowser.mTabs[aTab._tPos-i];
        }
      }
      i++;
    }

    // Fallback: there isn't an active tab available, so we're going
    // to have to nominate a non-active one.
    if (aTab.owner
        && Services.prefs.getBoolPref("browser.tabs.selectOwnerOnClose")) {
      return aTab.owner;
    }
    if (aTab.nextSibling) {
      return aTab.nextSibling;
    }
    return aTab.previousSibling;
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
