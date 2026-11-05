namespace Jellyfin.Plugin.FolderSorter.Services;

/// <summary>An error that maps to an HTTP status code.</summary>
public class FolderSorterException : Exception
{
    /// <summary>Initializes a new instance of the <see cref="FolderSorterException"/> class.</summary>
    /// <param name="statusCode">HTTP status code.</param>
    /// <param name="message">Message shown to the user.</param>
    public FolderSorterException(int statusCode, string message)
        : base(message)
    {
        StatusCode = statusCode;
    }

    /// <summary>Gets the HTTP status code.</summary>
    public int StatusCode { get; }
}
