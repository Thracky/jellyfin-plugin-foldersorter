using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.FolderSorter.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.IO;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.FolderSorter.Services;

/// <summary>Moves or deletes the folder that holds a song or album.</summary>
public class FolderOperations
{
    private readonly ILibraryManager _libraryManager;
    private readonly ILibraryMonitor _libraryMonitor;
    private readonly IFileSystem _fileSystem;
    private readonly IDirectoryService _directoryService;
    private readonly ILogger<FolderOperations> _logger;

    /// <summary>Initializes a new instance of the <see cref="FolderOperations"/> class.</summary>
    /// <param name="libraryManager">Library manager.</param>
    /// <param name="libraryMonitor">Library monitor.</param>
    /// <param name="fileSystem">File system.</param>
    /// <param name="directoryService">Directory service.</param>
    /// <param name="logger">Logger.</param>
    public FolderOperations(
        ILibraryManager libraryManager,
        ILibraryMonitor libraryMonitor,
        IFileSystem fileSystem,
        IDirectoryService directoryService,
        ILogger<FolderOperations> logger)
    {
        _libraryManager = libraryManager;
        _libraryMonitor = libraryMonitor;
        _fileSystem = fileSystem;
        _directoryService = directoryService;
        _logger = logger;
    }

    /// <summary>Gets the name of the folder that would be acted on.</summary>
    /// <param name="item">The song or album.</param>
    /// <returns>The folder name.</returns>
    public string DescribeFolder(BaseItem item)
    {
        var (folder, _) = ResolveFolder(item);
        return Path.GetFileName(TrimSeparators(folder));
    }

    /// <summary>Moves the item's folder into the destination.</summary>
    /// <param name="item">The song or album.</param>
    /// <param name="user">The requesting user.</param>
    /// <param name="dest">The destination.</param>
    public void Move(BaseItem item, User user, Destination dest)
    {
        if (!item.CanDelete(user))
        {
            throw new FolderSorterException(403, "You do not have permission to remove this item from its library.");
        }

        var (folder, album) = ResolveFolder(item);
        var libraries = _libraryManager.GetVirtualFolders();

        var destLibrary = libraries.FirstOrDefault(v => string.Equals(v.ItemId, dest.LibraryId, StringComparison.OrdinalIgnoreCase))
            ?? throw new FolderSorterException(404, "Destination library no longer exists.");

        if (!Directory.Exists(dest.Path))
        {
            throw new FolderSorterException(400, "Destination folder does not exist.");
        }

        if (!destLibrary.Locations.Any(l => _fileSystem.AreEqual(l, dest.Path) || _fileSystem.ContainsSubPath(l, dest.Path)))
        {
            throw new FolderSorterException(400, "Destination is not inside its library.");
        }

        var sourceParent = Path.GetDirectoryName(TrimSeparators(folder))!;
        var folderName = Path.GetFileName(TrimSeparators(folder));
        var target = Path.Combine(dest.Path, folderName);

        if (_fileSystem.AreEqual(sourceParent, dest.Path))
        {
            throw new FolderSorterException(400, "Already in destination.");
        }

        if (_fileSystem.AreEqual(folder, dest.Path) || _fileSystem.ContainsSubPath(folder, dest.Path))
        {
            throw new FolderSorterException(400, "Destination is inside the folder being moved.");
        }

        if (Directory.Exists(target) || File.Exists(target))
        {
            throw new FolderSorterException(409, $"A folder named \"{folderName}\" already exists in the destination.");
        }

        var sourceLocations = LocationsContaining(libraries, folder);

        _libraryMonitor.ReportFileSystemChangeBeginning(folder);
        _libraryMonitor.ReportFileSystemChangeBeginning(target);
        try
        {
            try
            {
                try
                {
                    Directory.Move(folder, target);
                }
                catch (IOException) when (Directory.Exists(folder) && !Directory.Exists(target))
                {
                    CopyAcrossVolumes(folder, target);
                }
            }
            catch (UnauthorizedAccessException)
            {
                throw new FolderSorterException(403, $"The Jellyfin server user cannot write to {dest.Path} or {sourceParent}.");
            }
            catch (IOException ex)
            {
                throw new FolderSorterException(500, ex.Message);
            }

            RemoveEmptyParents(sourceParent, sourceLocations);
        }
        finally
        {
            _libraryMonitor.ReportFileSystemChangeComplete(folder, false);
            _libraryMonitor.ReportFileSystemChangeComplete(target, false);
        }

        ForgetItem(album ?? item);
        _logger.LogInformation("Moved folder {Source} to {Target}", folder, target);
        Refresh(folder, target, sourceParent, dest.Path);
    }

    /// <summary>Deletes the album folder that holds the item.</summary>
    /// <param name="item">The song or album.</param>
    /// <param name="user">The requesting user.</param>
    public void DeleteFolder(BaseItem item, User user)
    {
        if (!item.CanDelete(user))
        {
            throw new FolderSorterException(403, "You do not have permission to delete this item.");
        }

        var (folder, album) = ResolveFolder(item);
        if (album is null)
        {
            throw new FolderSorterException(400, "This song is not inside an album folder.");
        }

        var sourceParent = Path.GetDirectoryName(TrimSeparators(folder))!;
        var sourceLocations = LocationsContaining(_libraryManager.GetVirtualFolders(), folder);

        _libraryMonitor.ReportFileSystemChangeBeginning(folder);
        try
        {
            try
            {
                _libraryManager.DeleteItem(album, new DeleteOptions { DeleteFileLocation = true }, true);

                if (Directory.Exists(folder))
                {
                    Directory.Delete(folder, true);
                }
            }
            catch (UnauthorizedAccessException)
            {
                throw new FolderSorterException(403, $"The Jellyfin server user cannot write to {sourceParent}.");
            }
            catch (IOException ex)
            {
                throw new FolderSorterException(500, ex.Message);
            }

            RemoveEmptyParents(sourceParent, sourceLocations);
        }
        finally
        {
            _libraryMonitor.ReportFileSystemChangeComplete(folder, false);
        }

        _logger.LogInformation("Deleted folder {Folder}", folder);
        Refresh(folder, null, sourceParent, null);
    }

    private static string TrimSeparators(string path)
        => path.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

    private static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (var entry in Directory.EnumerateFileSystemEntries(source))
        {
            var name = Path.GetFileName(entry);
            var destEntry = Path.Combine(destination, name);
            if (Directory.Exists(entry))
            {
                CopyDirectory(entry, destEntry);
            }
            else
            {
                File.Copy(entry, destEntry, false);
            }
        }

        Directory.SetLastWriteTimeUtc(destination, Directory.GetLastWriteTimeUtc(source));
    }

    private static (long Files, long Bytes) Measure(string path)
    {
        long files = 0;
        long bytes = 0;
        foreach (var file in new DirectoryInfo(path).EnumerateFiles("*", SearchOption.AllDirectories))
        {
            files++;
            bytes += file.Length;
        }

        return (files, bytes);
    }

    private void CopyAcrossVolumes(string folder, string target)
    {
        try
        {
            CopyDirectory(folder, target);
            if (Measure(folder) != Measure(target))
            {
                throw new IOException("Copied tree does not match the source.");
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogError(ex, "Cross-volume copy of {Source} to {Target} failed", folder, target);
            try
            {
                if (Directory.Exists(target))
                {
                    Directory.Delete(target, true);
                }
            }
            catch (Exception cleanupEx) when (cleanupEx is IOException or UnauthorizedAccessException)
            {
                _logger.LogWarning(cleanupEx, "Could not remove partial copy {Target}", target);
            }

            if (ex is UnauthorizedAccessException)
            {
                throw new FolderSorterException(403, $"The Jellyfin server user cannot write to {Path.GetDirectoryName(target)}.");
            }

            throw new FolderSorterException(500, "Cross-volume copy failed; source left untouched.");
        }

        // The verified copy is complete: if removing the source fails, keep both rather than risk losing data.
        try
        {
            Directory.Delete(folder, true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogError(ex, "Copied {Source} to {Target} but could not remove the source", folder, target);
            throw new FolderSorterException(500, $"Copied to the destination but could not remove the source folder ({ex.Message}). Both copies exist.");
        }
    }

    private List<string> LocationsContaining(IEnumerable<MediaBrowser.Model.Entities.VirtualFolderInfo> libraries, string folder)
        => libraries.SelectMany(v => v.Locations).Where(l => _fileSystem.ContainsSubPath(l, folder)).ToList();

    private (string Folder, MusicAlbum? Album) ResolveFolder(BaseItem item)
    {
        if (item is not (MusicAlbum or Audio))
        {
            throw new FolderSorterException(400, "Only songs and albums are supported.");
        }

        if (!item.IsFileProtocol || string.IsNullOrEmpty(item.Path))
        {
            throw new FolderSorterException(400, "Only items on the server's file system are supported.");
        }

        string folder;
        MusicAlbum? album;
        if (item is MusicAlbum musicAlbum)
        {
            album = musicAlbum;
            folder = musicAlbum.Path;
        }
        else
        {
            var audio = (Audio)item;
            var candidate = audio.AlbumEntity;
            if (candidate is not null
                && !string.IsNullOrEmpty(candidate.Path)
                && Directory.Exists(candidate.Path)
                && _fileSystem.ContainsSubPath(candidate.Path, audio.Path))
            {
                album = candidate;
                folder = candidate.Path;
            }
            else
            {
                album = null;
                folder = Path.GetDirectoryName(audio.Path)!;
            }
        }

        var inLibrarySubfolder = _libraryManager.GetVirtualFolders()
            .SelectMany(v => v.Locations)
            .Any(l => _fileSystem.ContainsSubPath(l, folder));
        if (!inLibrarySubfolder)
        {
            throw new FolderSorterException(400, "Item is not in a subfolder of a library.");
        }

        return (folder, album);
    }

    private void RemoveEmptyParents(string? directory, List<string> libraryLocations)
    {
        try
        {
            while (!string.IsNullOrEmpty(directory)
                   && libraryLocations.Any(l => _fileSystem.ContainsSubPath(l, directory))
                   && !Directory.EnumerateFileSystemEntries(directory).Any())
            {
                ForgetItem(_libraryManager.FindByPath(directory, true));
                Directory.Delete(directory);
                directory = Path.GetDirectoryName(directory);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning(ex, "Could not remove empty folder {Path}", directory);
        }
    }

    // The moved/removed path no longer exists; drop its library item right away instead of waiting for a
    // refresh (queued refreshes of one item are coalesced, so rapid successive operations could otherwise
    // leave stale entries). Files are untouched.
    private void ForgetItem(BaseItem? stale)
    {
        if (stale is null)
        {
            return;
        }

        try
        {
            _libraryManager.DeleteItem(stale, new DeleteOptions { DeleteFileLocation = false }, true);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not remove stale library item for {Path}", stale.Path);
        }
    }

    private void Refresh(string folder, string? target, string sourceParent, string? destinationPath)
    {
        foreach (var path in new[] { folder, target, sourceParent, destinationPath })
        {
            if (!string.IsNullOrEmpty(path))
            {
                _directoryService.Invalidate(path);
            }
        }

        RefreshNearest(sourceParent, false);
        if (destinationPath is not null)
        {
            RefreshNearest(destinationPath, true);
        }
    }

    // Same algorithm as the server's FileRefresher.GetAffectedBaseItem + ChangedExternally. A library whose
    // root was empty at its last scan has no folder item for that root yet, so nothing can be refreshed
    // selectively; for the destination a library scan is queued to pick up the first arrival.
    private void RefreshNearest(string path, bool scanIfNoItem)
    {
        try
        {
            BaseItem? item = null;
            var current = path;
            while (item is null && !string.IsNullOrEmpty(current))
            {
                item = _libraryManager.FindByPath(current, null);
                current = Path.GetDirectoryName(current) ?? string.Empty;
            }

            while (item is not null && !Directory.Exists(item.Path) && !File.Exists(item.Path))
            {
                item = item.GetOwner() ?? item.GetParent();
            }

            if (item is not null and not AggregateFolder)
            {
                item.ChangedExternally();
            }
            else if (scanIfNoItem)
            {
                _libraryManager.QueueLibraryScan();
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not queue refresh for {Path}", path);
        }
    }
}
