using Jellyfin.Plugin.FolderSorter.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.FolderSorter;

/// <summary>The Folder Sorter plugin.</summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    /// <summary>Initializes a new instance of the <see cref="Plugin"/> class.</summary>
    /// <param name="applicationPaths">Application paths.</param>
    /// <param name="xmlSerializer">Xml serializer.</param>
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    /// <summary>Gets the plugin instance.</summary>
    public static Plugin? Instance { get; private set; }

    /// <inheritdoc />
    public override Guid Id => Guid.Parse("b8e5d3a1-6c4f-4b27-9a0e-3f1d7c52e8a4");

    /// <inheritdoc />
    public override string Name => "Folder Sorter";

    /// <inheritdoc />
    public IEnumerable<PluginPageInfo> GetPages()
    {
        yield return new PluginPageInfo
        {
            Name = "foldersorter",
            DisplayName = "Folder Sorter",
            EmbeddedResourcePath = GetType().Namespace + ".Configuration.destinations.html",
            EnableInMainMenu = true,
            MenuSection = "server",
            MenuIcon = "drive_file_move"
        };
    }
}
