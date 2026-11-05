using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.FolderSorter.Configuration;

/// <summary>Plugin configuration.</summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>Gets or sets the configured destinations.</summary>
    public List<Destination> Destinations { get; set; } = new();
}

/// <summary>A folder that release folders can be moved into.</summary>
public class Destination
{
    /// <summary>Gets or sets the destination id.</summary>
    public Guid Id { get; set; }

    /// <summary>Gets or sets the display name.</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>Gets or sets the item id (string) of the destination library.</summary>
    public string LibraryId { get; set; } = string.Empty;

    /// <summary>Gets or sets the absolute server path of the destination folder.</summary>
    public string Path { get; set; } = string.Empty;
}
