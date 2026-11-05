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

    // Works out what has to happen to this device's playback once the folder's items disappear.
    // Returns { kind: 'none' } | { kind: 'stop', sessionId } | { kind: 'play', sessionId, ids }.
    // Moved items get new ids, so queued tracks of the folder can no longer be played; the remaining
    // queue is replaced by the entries after the current track that are not part of the folder.
    function computePlan(item) {
        return api().getSessions({ DeviceId: api().deviceId() }).then(function (sessions) {
            var session = sessions && sessions[0];
            if (!session || !session.NowPlayingItem) {
                return { kind: 'none' };
            }

            var albumId = item.Type === 'MusicAlbum' ? item.Id : item.AlbumId;
            var now = session.NowPlayingItem;
            var affected = function (id, itemAlbumId) {
                return id === item.Id || (albumId && itemAlbumId === albumId);
            };
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

    // Resolves true when the request succeeded, false when it failed (the error is shown to the user).
    function perform(item, request, successMessage) {
        return computePlan(item).catch(function () {
            return { kind: 'none' };
        }).then(function (plan) {
            return request().then(function () {
                return applyPlan(plan).catch(function (e) {
                    console.warn('Folder Sorter: could not adjust playback', e);
                });
            }).then(function () {
                toast(successMessage);
                return true;
            });
        }).catch(function (err) {
            return reportError(err).then(function () { return false; });
        });
    }

    function moveItem(item, destination) {
        return perform(item, function () {
            return api().ajax({
                type: 'POST',
                url: api().getUrl('FolderSorter/Items/' + item.Id + '/Move', { destinationId: destination.Id })
            });
        }, 'Moved to ' + destination.Name);
    }

    // Resolves true when the folder was deleted, false when cancelled or failed.
    function deleteItem(item) {
        return api().getJSON(api().getUrl('FolderSorter/Items/' + item.Id + '/Folder')).then(function (info) {
            if (!window.confirm('Delete folder "' + info.FolderName + '" and everything in it?')) {
                return false;
            }
            return perform(item, function () {
                return api().ajax({ type: 'DELETE', url: api().getUrl('FolderSorter/Items/' + item.Id + '/Folder') });
            }, 'Folder deleted');
        }, function (err) {
            return reportError(err).then(function () { return false; });
        });
    }

    function runMove(sheet, item, destination) {
        closeSheet(sheet);
        moveItem(item, destination);
    }

    function runDelete(sheet, item) {
        closeSheet(sheet);
        deleteItem(item);
    }

    // ---------- public API for other plugins ----------

    // A small popup with the same entries as the item menu, anchored to an element. Other plugins (Folder
    // Browser) use it through window.FolderSorter and simply don't show their button when it is missing.
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

    function showMenu(anchor, itemId) {
        closePopup(null);
        return Promise.all([
            api().getItem(api().getCurrentUserId(), itemId),
            getDestinations()
        ]).then(function (r) {
            var item = r[0];
            var destinations = r[1] || [];
            if (!item || (item.Type !== 'Audio' && item.Type !== 'MusicAlbum') || item.CanDelete !== true) {
                window.alert('Folder Sorter can only move or delete songs and albums you are allowed to delete.');
                return null;
            }
            return new Promise(function (resolve) {
                var el = document.createElement('div');
                el.className = 'foldersorter-popup';
                el.setAttribute('role', 'menu');
                el.style.cssText = 'position:fixed;z-index:100000;min-width:14em;padding:.4em 0;border-radius:.3em;' +
                    'background:#2b2b2b;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.6);';

                var choose = function (action) {
                    detachPopup();
                    action().then(function (ok) { resolve(ok ? 'done' : null); });
                };
                destinations.forEach(function (d) {
                    el.appendChild(makeButton('drive_file_move', 'Move to ' + d.Name, function () {
                        choose(function () { return moveItem(item, d); });
                    }));
                });
                el.appendChild(makeButton('folder_delete', 'Delete folder', function () {
                    choose(function () { return deleteItem(item); });
                }));
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
        version: 1,
        // Resolves 'done' after a successful move or delete, null when dismissed, cancelled or failed.
        showMenu: showMenu
    };
    document.dispatchEvent(new CustomEvent('foldersorter:ready'));
})();
