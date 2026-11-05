(function () {
    'use strict';

    if (window.__folderSorter) {
        return;
    }
    window.__folderSorter = true;

    var KNOWN_COMMANDS = ['addtoplaylist', 'delete', 'refresh', 'identify', 'download'];
    var TRIGGER_MAX_AGE_MS = 3000;
    var DESTINATIONS_TTL_MS = 60000;

    var pending = null; // { time, promise: Promise<string|null> }
    var destinationsCache = null; // { time, value }

    function api() {
        return window.ApiClient;
    }

    // ---------- trigger tracking ----------

    function resolveItemId(target, eventType) {
        var el = target && target.closest ? target : null;
        if (!el) {
            return null;
        }

        if (el.closest('.btnToggleContextMenu')) {
            return api().getSessions({ DeviceId: api().deviceId() }).then(function (sessions) {
                var s = sessions && sessions[0];
                return (s && s.NowPlayingItem && s.NowPlayingItem.Id) || null;
            });
        }

        if (el.closest('.btnMoreCommands')) {
            var query = (location.hash.split('?')[1]) || '';
            return Promise.resolve(new URLSearchParams(query).get('id'));
        }

        if (eventType === 'contextmenu' || el.closest('[data-action="menu"]')) {
            var holder = el.closest('[data-id]');
            return Promise.resolve(holder ? holder.getAttribute('data-id') : null);
        }

        return null;
    }

    function onTrigger(e) {
        if (!api()) {
            return;
        }
        var result = resolveItemId(e.target, e.type);
        if (result) {
            pending = { time: Date.now(), promise: result.catch(function () { return null; }) };
        }
    }

    document.addEventListener('click', onTrigger, true);
    document.addEventListener('contextmenu', onTrigger, true);

    // ---------- menu injection ----------

    function getDestinations() {
        if (destinationsCache && Date.now() - destinationsCache.time < DESTINATIONS_TTL_MS) {
            return Promise.resolve(destinationsCache.value);
        }
        return api().getJSON(api().getUrl('FolderSorter/Destinations')).then(function (value) {
            destinationsCache = { time: Date.now(), value: value };
            return value;
        });
    }

    function isMenuSheet(sheet) {
        var items = sheet.querySelectorAll('.actionSheetMenuItem');
        for (var i = 0; i < items.length; i++) {
            if (KNOWN_COMMANDS.indexOf(items[i].getAttribute('data-id')) !== -1) {
                return true;
            }
        }
        return false;
    }

    function scan() {
        if (!api() || !pending) {
            return;
        }
        var sheets = document.querySelectorAll('.actionSheet:not(.foldersorter-added)');
        for (var i = 0; i < sheets.length; i++) {
            var sheet = sheets[i];
            if (sheet.querySelector('.actionSheetScroller') && isMenuSheet(sheet)) {
                sheet.classList.add('foldersorter-added');
                if (Date.now() - pending.time > TRIGGER_MAX_AGE_MS) {
                    continue;
                }
                inject(sheet, pending.promise);
            }
        }
    }

    function inject(sheet, idPromise) {
        idPromise.then(function (id) {
            if (!id) {
                return null;
            }
            return Promise.all([
                api().getItem(api().getCurrentUserId(), id),
                getDestinations()
            ]).then(function (r) {
                var item = r[0];
                var destinations = r[1] || [];
                if (!item || (item.Type !== 'Audio' && item.Type !== 'MusicAlbum') || item.CanDelete !== true) {
                    return;
                }
                var scroller = sheet.querySelector('.actionSheetScroller');
                if (!scroller || !sheet.isConnected) {
                    return;
                }

                destinations.forEach(function (d) {
                    scroller.appendChild(makeButton('drive_file_move', 'Move to ' + d.Name, function () {
                        runMove(sheet, item, d);
                    }));
                });
                scroller.appendChild(makeButton('folder_delete', 'Delete folder', function () {
                    runDelete(sheet, item);
                }));
                if (confirmationSkipped()) {
                    scroller.appendChild(confirmationEntry(function () { closeSheet(sheet); }));
                }
            });
        }).catch(function (err) {
            console.warn('Folder Sorter: could not add menu entries', err);
        });
    }

    function makeButton(icon, label, onClick) {
        var button = document.createElement('button');
        button.setAttribute('is', 'emby-button');
        button.type = 'button';
        button.className = 'listItem listItem-button foldersorter-item';

        var iconEl = document.createElement('span');
        iconEl.className = 'actionsheetMenuItemIcon listItemIcon listItemIcon-transparent material-icons ' + icon;
        iconEl.setAttribute('aria-hidden', 'true');
        button.appendChild(iconEl);

        var body = document.createElement('div');
        body.className = 'listItemBody actionsheetListItemBody';
        var text = document.createElement('div');
        text.className = 'listItemBodyText actionSheetItemText';
        text.textContent = label;
        body.appendChild(text);
        button.appendChild(body);

        button.addEventListener('click', function (e) {
            e.stopPropagation();
            onClick();
        });
        return button;
    }

    new MutationObserver(scan).observe(document.body || document.documentElement, { childList: true, subtree: true });

    // ---------- actions ----------

    // jellyfin-web closes its dialogs through dialogHelper.close, which is only reachable through the
    // backdrop handler: a mousedown + click whose target is the dialog container itself.
    function closeSheet(sheet) {
        var close = sheet.querySelector('.btnCloseActionSheet');
        if (close) {
            close.click();
            return;
        }
        var container = sheet.dialogContainer;
        if (container) {
            container.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            container.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        } else if (typeof sheet.close === 'function') {
            sheet.close();
        }
    }

    function toast(message) {
        var el = document.createElement('div');
        el.textContent = message;
        el.style.cssText = 'position:fixed;left:50%;bottom:6em;transform:translateX(-50%);background:#202020;color:#fff;' +
            'padding:.8em 1.4em;border-radius:.3em;z-index:100000;box-shadow:0 2px 8px rgba(0,0,0,.5);';
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 2500);
    }

    function errorText(err) {
        if (err && typeof err.text === 'function') {
            return err.text().then(function (t) {
                return t || (err.status ? 'HTTP ' + err.status : 'Request failed');
            }, function () {
                return 'Request failed';
            });
        }
        return Promise.resolve((err && err.message) || 'Request failed');
    }

    function reportError(err) {
        return errorText(err).then(function (text) {
            window.alert(String(text));
        });
    }

    // The server only stores a session's queue when playback stops, so the live queue is taken from the
    // playback reports the web player sends (they carry NowPlayingQueue on start and on queue changes).
    var playback = null; // { queue: [{ Id, PlaylistItemId }] }

    function capture(info) {
        if (info && Array.isArray(info.NowPlayingQueue) && info.NowPlayingQueue.length) {
            playback = { queue: info.NowPlayingQueue };
        }
    }

    function patchApiClient() {
        var client = api();
        if (!client || client.__folderSorterPatched) {
            return;
        }
        ['reportPlaybackStart', 'reportPlaybackProgress', 'reportPlaybackStopped'].forEach(function (name) {
            var original = client[name];
            if (typeof original !== 'function') {
                return;
            }
            client[name] = function (info) {
                try {
                    capture(info);
                } catch (e) {
                    console.warn('Folder Sorter: could not read playback report', e);
                }
                return original.apply(this, arguments);
            };
        });
        client.__folderSorterPatched = true;
    }

    setInterval(patchApiClient, 1000);
    patchApiClient();

    // Works out what has to happen to this device's playback after some folders were moved or deleted.
    // Returns { kind: 'none' } | { kind: 'stop', sessionId } | { kind: 'play', sessionId, ids }.
    // It runs after the operation: the removed tracks' ids no longer resolve, and the remaining queue
    // (entries after the current track that are still in the library and not in those folders) is replayed.
    function computePlan(items) {
        var removedIds = {};
        var removedAlbums = {};
        items.forEach(function (item) {
            removedIds[item.Id] = true;
            var albumId = item.Type === 'MusicAlbum' ? item.Id : item.AlbumId;
            if (albumId) {
                removedAlbums[albumId] = true;
            }
        });
        var affected = function (id, albumId) {
            return removedIds[id] === true || (!!albumId && removedAlbums[albumId] === true);
        };

        return api().getSessions({ DeviceId: api().deviceId() }).then(function (sessions) {
            var session = sessions && sessions[0];
            if (!session || !session.NowPlayingItem) {
                return { kind: 'none' };
            }

            var now = session.NowPlayingItem;
            if (!affected(now.Id, now.AlbumId)) {
                return { kind: 'none' };
            }

            var queue = (playback && playback.queue) || [];
            var idx = queue.findIndex(function (q) { return q.Id === now.Id; });
            if (idx < 0) {
                return { kind: 'stop', sessionId: session.Id };
            }

            var ids = queue.slice(idx + 1).map(function (q) { return q.Id; });
            if (!ids.length) {
                return { kind: 'stop', sessionId: session.Id };
            }

            return api().getJSON(api().getUrl('Users/' + api().getCurrentUserId() + '/Items', { Ids: ids.join(',') })).then(function (res) {
                var albumByItem = {};
                ((res && res.Items) || []).forEach(function (i) { albumByItem[i.Id] = i.AlbumId; });
                var remaining = ids.filter(function (id) {
                    return Object.prototype.hasOwnProperty.call(albumByItem, id) && !affected(id, albumByItem[id]);
                });
                return remaining.length
                    ? { kind: 'play', sessionId: session.Id, ids: remaining }
                    : { kind: 'stop', sessionId: session.Id };
            });
        });
    }

    function applyPlan(plan) {
        if (plan.kind === 'stop') {
            return api().ajax({ type: 'POST', url: api().getUrl('Sessions/' + plan.sessionId + '/Playing/Stop') });
        }
        if (plan.kind === 'play') {
            return api().ajax({
                type: 'POST',
                url: api().getUrl('Sessions/' + plan.sessionId + '/Playing', { playCommand: 'PlayNow', itemIds: plan.ids.join(',') })
            });
        }
        return Promise.resolve();
    }

    function folderLabel(item) {
        if (item.Path) {
            var parts = String(item.Path).split(/[\\/]/).filter(Boolean);
            var name = parts[parts.length - 1] || item.Name;
            // A song acts on its folder.
            return item.Type === 'Audio' && parts.length > 1 ? parts[parts.length - 2] : name;
        }
        return item.Name;
    }

    // Runs one request per item, one after another, then adjusts playback once and reports the outcome:
    // a toast when everything worked, one alert listing what failed otherwise.
    // Resolves { succeeded: [ids], failed: [ids] }.
    function runBatch(items, request, verb) {
        var succeeded = [];
        var failed = [];
        var chain = Promise.resolve();
        items.forEach(function (item) {
            chain = chain.then(function () {
                return request(item).then(function () {
                    succeeded.push(item);
                }, function (err) {
                    return errorText(err).then(function (text) {
                        failed.push({ item: item, message: text });
                    });
                });
            });
        });

        return chain.then(function () {
            if (!succeeded.length) {
                return null;
            }
            return computePlan(succeeded).then(applyPlan).catch(function (e) {
                console.warn('Folder Sorter: could not adjust playback', e);
            });
        }).then(function () {
            if (!failed.length) {
                toast(items.length === 1 ? verb.one : verb.many.replace('{n}', items.length));
            } else if (items.length === 1) {
                window.alert(failed[0].message);
            } else {
                window.alert(verb.summary.replace('{done}', succeeded.length).replace('{n}', items.length) + '\n\n' +
                    failed.map(function (f) { return '• ' + folderLabel(f.item) + ': ' + f.message; }).join('\n'));
            }
            return {
                succeeded: succeeded.map(function (i) { return i.Id; }),
                failed: failed.map(function (f) { return f.item.Id; })
            };
        });
    }

    function moveItems(items, destination) {
        return runBatch(items, function (item) {
            return api().ajax({
                type: 'POST',
                url: api().getUrl('FolderSorter/Items/' + item.Id + '/Move', { destinationId: destination.Id })
            });
        }, {
            one: 'Moved to ' + destination.Name,
            many: 'Moved {n} folders to ' + destination.Name,
            summary: 'Moved {done} of {n} folders to ' + destination.Name + '. Not moved:'
        });
    }

    function deleteItems(items) {
        return confirmDelete(items).then(function (confirmed) {
            if (!confirmed) {
                return null;
            }
            return runBatch(items, function (item) {
                return api().ajax({ type: 'DELETE', url: api().getUrl('FolderSorter/Items/' + item.Id + '/Folder') });
            }, {
                one: 'Folder deleted',
                many: 'Deleted {n} folders',
                summary: 'Deleted {done} of {n} folders. Not deleted:'
            });
        });
    }

    // ---------- delete confirmation ----------

    // "Don't ask again" lasts for this browser tab (sessionStorage): closing the tab turns confirmation back
    // on, and the menus offer "Ask before deleting" while it is off.
    var SKIP_CONFIRM_KEY = 'foldersorter.skipDeleteConfirm';

    function confirmationSkipped() {
        try {
            return window.sessionStorage.getItem(SKIP_CONFIRM_KEY) === '1';
        } catch (e) {
            return false;
        }
    }

    function setConfirmationSkipped(skip) {
        try {
            if (skip) {
                window.sessionStorage.setItem(SKIP_CONFIRM_KEY, '1');
            } else {
                window.sessionStorage.removeItem(SKIP_CONFIRM_KEY);
            }
        } catch (e) {
            console.warn('Folder Sorter: sessionStorage unavailable', e);
        }
    }

    function folderNames(items) {
        return Promise.all(items.map(function (item) {
            return api().getJSON(api().getUrl('FolderSorter/Items/' + item.Id + '/Folder')).then(function (info) {
                return info.FolderName;
            }, function () {
                return folderLabel(item);
            });
        }));
    }

    function confirmDelete(items) {
        if (confirmationSkipped()) {
            return Promise.resolve(true);
        }
        return folderNames(items).then(function (names) {
            return new Promise(function (resolve) {
                var overlay = document.createElement('div');
                overlay.className = 'foldersorter-confirm';
                overlay.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.6);display:flex;' +
                    'align-items:center;justify-content:center;';
                var title = items.length === 1 ? 'Delete folder?' : 'Delete ' + items.length + ' folders?';
                var shown = names.slice(0, 10);
                var more = names.length - shown.length;
                overlay.innerHTML =
                    '<div role="dialog" aria-modal="true" style="background:#2b2b2b;color:#fff;border-radius:.4em;padding:1.4em 1.6em;' +
                    'max-width:32em;width:calc(100% - 3em);box-shadow:0 8px 32px rgba(0,0,0,.6);">' +
                    '<h2 style="margin:0 0 .6em;font-size:1.3em;"></h2>' +
                    '<p style="margin:0 0 .4em;opacity:.85;">These folders and everything in them will be removed from disk:</p>' +
                    '<ul class="foldersorter-confirm-names" style="margin:0 0 1em;padding-left:1.4em;max-height:14em;overflow:auto;"></ul>' +
                    '<label style="display:flex;align-items:center;gap:.5em;margin-bottom:1.2em;cursor:pointer;">' +
                    '<input type="checkbox" class="foldersorter-confirm-skip"> Don\u2019t ask again in this browser tab</label>' +
                    '<div style="display:flex;justify-content:flex-end;gap:.6em;">' +
                    '<button type="button" class="raised button-cancel emby-button foldersorter-confirm-cancel">Cancel</button>' +
                    '<button type="button" class="raised button-delete emby-button foldersorter-confirm-ok" ' +
                    'style="background:#c62828;color:#fff;">Delete</button></div></div>';
                overlay.querySelector('h2').textContent = title;
                var list = overlay.querySelector('.foldersorter-confirm-names');
                shown.forEach(function (name) {
                    var li = document.createElement('li');
                    li.textContent = name;
                    list.appendChild(li);
                });
                if (more > 0) {
                    var li = document.createElement('li');
                    li.textContent = 'and ' + more + ' more';
                    li.style.opacity = '.7';
                    list.appendChild(li);
                }

                var finish = function (ok) {
                    document.removeEventListener('keydown', onKey, true);
                    if (ok && overlay.querySelector('.foldersorter-confirm-skip').checked) {
                        setConfirmationSkipped(true);
                    }
                    overlay.remove();
                    resolve(ok);
                };
                var onKey = function (e) {
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        finish(false);
                    }
                };
                overlay.querySelector('.foldersorter-confirm-cancel').addEventListener('click', function () { finish(false); });
                overlay.querySelector('.foldersorter-confirm-ok').addEventListener('click', function () { finish(true); });
                overlay.addEventListener('mousedown', function (e) {
                    if (e.target === overlay) {
                        finish(false);
                    }
                });
                document.addEventListener('keydown', onKey, true);
                document.body.appendChild(overlay);
                overlay.querySelector('.foldersorter-confirm-ok').focus();
            });
        });
    }

    function confirmationEntry(onClick) {
        return makeButton('help_outline', 'Ask before deleting folders', function () {
            setConfirmationSkipped(false);
            toast('Delete confirmation is back on');
            onClick();
        });
    }

    function runMove(sheet, item, destination) {
        closeSheet(sheet);
        moveItems([item], destination);
    }

    function runDelete(sheet, item) {
        closeSheet(sheet);
        deleteItems([item]);
    }

    // ---------- public API for other plugins ----------

    // A small popup with the same entries as the item menu, anchored to an element. Other plugins (Folder
    // Browser) use it through window.FolderSorter and simply don't show their buttons when it is missing.
    var openPopup = null;

    function detachPopup() {
        var popup = openPopup;
        if (popup) {
            openPopup = null;
            popup.el.remove();
            document.removeEventListener('mousedown', popup.onOutside, true);
            document.removeEventListener('keydown', popup.onKey, true);
        }
        return popup;
    }

    function closePopup(result) {
        var popup = detachPopup();
        if (popup) {
            popup.resolve(result);
        }
    }

    function eligible(item) {
        return !!item && (item.Type === 'Audio' || item.Type === 'MusicAlbum') && item.CanDelete === true;
    }

    function showMenu(anchor, itemIds) {
        closePopup(null);
        var ids = Array.isArray(itemIds) ? itemIds : [itemIds];
        return Promise.all([
            Promise.all(ids.map(function (id) { return api().getItem(api().getCurrentUserId(), id); })),
            getDestinations()
        ]).then(function (r) {
            var items = r[0].filter(eligible);
            var destinations = r[1] || [];
            if (!items.length) {
                window.alert('Folder Sorter can only move or delete songs and albums you are allowed to delete.');
                return null;
            }
            return new Promise(function (resolve) {
                var el = document.createElement('div');
                el.className = 'foldersorter-popup';
                el.setAttribute('role', 'menu');
                el.style.cssText = 'position:fixed;z-index:100000;min-width:14em;padding:.4em 0;border-radius:.3em;' +
                    'background:#2b2b2b;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.6);';

                if (ids.length > 1) {
                    var header = document.createElement('div');
                    header.style.cssText = 'padding:.4em 1em .5em;opacity:.7;font-size:.9em;';
                    header.textContent = items.length === ids.length
                        ? items.length + ' folders selected'
                        : items.length + ' of ' + ids.length + ' selected folders can be sorted';
                    el.appendChild(header);
                }

                var choose = function (action) {
                    detachPopup();
                    action().then(resolve, function () { resolve(null); });
                };
                destinations.forEach(function (d) {
                    el.appendChild(makeButton('drive_file_move', 'Move to ' + d.Name, function () {
                        choose(function () { return moveItems(items, d); });
                    }));
                });
                el.appendChild(makeButton('folder_delete', items.length === 1 ? 'Delete folder' : 'Delete ' + items.length + ' folders', function () {
                    choose(function () { return deleteItems(items); });
                }));
                if (confirmationSkipped()) {
                    el.appendChild(confirmationEntry(function () { closePopup(null); }));
                }
                el.querySelectorAll('.foldersorter-item').forEach(function (b) {
                    b.setAttribute('role', 'menuitem');
                    b.style.width = '100%';
                });

                document.body.appendChild(el);
                var rect = anchor.getBoundingClientRect();
                var left = Math.min(rect.right - el.offsetWidth, window.innerWidth - el.offsetWidth - 8);
                var top = rect.bottom + 4;
                if (top + el.offsetHeight > window.innerHeight - 8) {
                    top = Math.max(8, rect.top - el.offsetHeight - 4);
                }
                el.style.left = Math.max(8, left) + 'px';
                el.style.top = top + 'px';

                openPopup = {
                    el: el,
                    resolve: resolve,
                    onOutside: function (e) {
                        if (!el.contains(e.target)) {
                            closePopup(null);
                        }
                    },
                    onKey: function (e) {
                        if (e.key === 'Escape') {
                            closePopup(null);
                        }
                    }
                };
                document.addEventListener('mousedown', openPopup.onOutside, true);
                document.addEventListener('keydown', openPopup.onKey, true);
            });
        }).catch(function (err) {
            return reportError(err).then(function () { return null; });
        });
    }

    window.FolderSorter = {
        version: 2,
        // showMenu(anchorElement, itemId | itemIds[]) resolves { succeeded: [ids], failed: [ids] } after a move
        // or delete ran, or null when the menu was dismissed or the delete was cancelled.
        showMenu: showMenu
    };
    document.dispatchEvent(new CustomEvent('foldersorter:ready'));
})();
