using System.Security.Claims;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.FolderSorter.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.FolderSorter.Api;

/// <summary>Folder Sorter API.</summary>
[ApiController]
[Route("FolderSorter")]
public class FolderSorterController : ControllerBase
{
    private readonly ILibraryManager _libraryManager;
    private readonly IUserManager _userManager;
    private readonly FolderOperations _operations;

    /// <summary>Initializes a new instance of the <see cref="FolderSorterController"/> class.</summary>
    /// <param name="libraryManager">Library manager.</param>
    /// <param name="userManager">User manager.</param>
    /// <param name="operations">Folder operations.</param>
    public FolderSorterController(ILibraryManager libraryManager, IUserManager userManager, FolderOperations operations)
    {
        _libraryManager = libraryManager;
        _userManager = userManager;
        _operations = operations;
    }

    /// <summary>Gets the injected client script.</summary>
    /// <returns>The script.</returns>
    [HttpGet("client.js")]
    [AllowAnonymous]
    public ActionResult GetClientScript()
    {
        var stream = typeof(Plugin).Assembly.GetManifestResourceStream(typeof(Plugin).Namespace + ".Web.client.js");
        if (stream is null)
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "no-cache";
        return File(stream, "application/javascript");
    }

    /// <summary>Lists destinations (names only).</summary>
    /// <returns>The destinations.</returns>
    [HttpGet("Destinations")]
    [Authorize]
    public ActionResult GetDestinations()
    {
        var destinations = Plugin.Instance?.Configuration.Destinations ?? new();
        return Ok(destinations.Select(d => new { d.Id, d.Name }).ToList());
    }

    /// <summary>Gets the name of the folder that would be acted on.</summary>
    /// <param name="itemId">Item id.</param>
    /// <returns>The folder name.</returns>
    [HttpGet("Items/{itemId:guid}/Folder")]
    [Authorize]
    public ActionResult GetFolder([FromRoute] Guid itemId)
        => Run(itemId, (item, _) => Ok(new { FolderName = _operations.DescribeFolder(item) }));

    /// <summary>Moves the item's folder to a destination.</summary>
    /// <param name="itemId">Item id.</param>
    /// <param name="destinationId">Destination id.</param>
    /// <returns>No content.</returns>
    [HttpPost("Items/{itemId:guid}/Move")]
    [Authorize]
    public ActionResult Move([FromRoute] Guid itemId, [FromQuery] Guid destinationId)
    {
        var destination = Plugin.Instance?.Configuration.Destinations.FirstOrDefault(d => d.Id == destinationId);
        if (destination is null)
        {
            return Text(404, "Unknown destination.");
        }

        return Run(itemId, (item, user) =>
        {
            _operations.Move(item, user, destination);
            return NoContent();
        });
    }

    /// <summary>Deletes the item's folder.</summary>
    /// <param name="itemId">Item id.</param>
    /// <returns>No content.</returns>
    [HttpDelete("Items/{itemId:guid}/Folder")]
    [Authorize]
    public ActionResult DeleteFolder([FromRoute] Guid itemId)
        => Run(itemId, (item, user) =>
        {
            _operations.DeleteFolder(item, user);
            return NoContent();
        });

    private ActionResult Run(Guid itemId, Func<BaseItem, User, ActionResult> action)
    {
        var user = GetUser();
        if (user is null)
        {
            return Unauthorized();
        }

        var item = _libraryManager.GetItemById<BaseItem>(itemId, user);
        if (item is null)
        {
            return Text(404, "Item not found.");
        }

        try
        {
            return action(item, user);
        }
        catch (FolderSorterException ex)
        {
            return Text(ex.StatusCode, ex.Message);
        }
    }

    private static ContentResult Text(int statusCode, string message)
        => new() { StatusCode = statusCode, Content = message, ContentType = "text/plain; charset=utf-8" };

    private User? GetUser()
    {
        var claim = User.FindFirstValue("Jellyfin-UserId");
        return Guid.TryParse(claim, out var id) && id != Guid.Empty ? _userManager.GetUserById(id) : null;
    }
}
