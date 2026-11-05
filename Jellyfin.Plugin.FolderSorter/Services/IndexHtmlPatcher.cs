namespace Jellyfin.Plugin.FolderSorter.Services;

/// <summary>Request body File Transformation passes to the callback.</summary>
public class PatchRequest
{
    /// <summary>Gets or sets the file contents.</summary>
    public string? Contents { get; set; }
}

/// <summary>Injects the client script into index.html.</summary>
public static class IndexHtmlPatcher
{
    // Relative to <base url>/web/index.html, so it also works when the server has a Base URL set
    // (for example behind a reverse proxy at /jellyfin).
    private const string ScriptTag = "<script defer src=\"../FolderSorter/client.js\"></script>";

    /// <summary>Callback invoked by File Transformation.</summary>
    /// <param name="request">The request.</param>
    /// <returns>The patched contents.</returns>
    public static string PatchIndexHtml(PatchRequest request)
    {
        var contents = request.Contents ?? string.Empty;
        if (contents.Contains("/FolderSorter/client.js", StringComparison.Ordinal))
        {
            return contents;
        }

        var idx = contents.LastIndexOf("</body>", StringComparison.Ordinal);
        return idx < 0 ? contents : contents.Insert(idx, ScriptTag);
    }
}
