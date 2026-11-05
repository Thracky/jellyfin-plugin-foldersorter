using System.Reflection;
using System.Runtime.Loader;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.FolderSorter.Services;

/// <summary>Registers the index.html transformation with the File Transformation plugin.</summary>
public class FileTransformationRegistrar : IHostedService
{
    private const int Attempts = 10;
    private static readonly TimeSpan Delay = TimeSpan.FromSeconds(3);

    private readonly ILogger<FileTransformationRegistrar> _logger;
    private CancellationTokenSource? _cts;

    /// <summary>Initializes a new instance of the <see cref="FileTransformationRegistrar"/> class.</summary>
    /// <param name="logger">Logger.</param>
    public FileTransformationRegistrar(ILogger<FileTransformationRegistrar> logger)
    {
        _logger = logger;
    }

    /// <inheritdoc />
    public Task StartAsync(CancellationToken cancellationToken)
    {
        _cts = new CancellationTokenSource();
        _ = Task.Run(() => RegisterLoopAsync(_cts.Token), CancellationToken.None);
        return Task.CompletedTask;
    }

    /// <inheritdoc />
    public Task StopAsync(CancellationToken cancellationToken)
    {
        _cts?.Cancel();
        return Task.CompletedTask;
    }

    private async Task RegisterLoopAsync(CancellationToken token)
    {
        try
        {
            for (var i = 0; i < Attempts; i++)
            {
                try
                {
                    if (TryRegister())
                    {
                        _logger.LogInformation("Registered the Folder Sorter index.html transformation with File Transformation.");
                        return;
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogDebug(ex, "File Transformation registration attempt {Attempt} failed", i + 1);
                }

                await Task.Delay(Delay, token).ConfigureAwait(false);
            }

            _logger.LogWarning("File Transformation plugin not found; Folder Sorter menu entries are disabled. Install File Transformation.");
        }
        catch (OperationCanceledException)
        {
        }
    }

    private static bool TryRegister()
    {
        var assembly = AssemblyLoadContext.All
            .SelectMany(c => c.Assemblies)
            .FirstOrDefault(a => a.GetName().Name == "Jellyfin.Plugin.FileTransformation");
        var method = assembly?.GetType("Jellyfin.Plugin.FileTransformation.PluginInterface")?
            .GetMethod("RegisterTransformation", BindingFlags.Public | BindingFlags.Static);
        if (method is null)
        {
            return false;
        }

        // Build the payload with FT's own JObject type to avoid cross-load-context type mismatches.
        var payloadType = method.GetParameters()[0].ParameterType;
        var parse = payloadType.GetMethod("Parse", BindingFlags.Public | BindingFlags.Static, new[] { typeof(string) });
        if (parse is null)
        {
            return false;
        }

        var patcher = typeof(IndexHtmlPatcher);
        var json = System.Text.Json.JsonSerializer.Serialize(new Dictionary<string, string>
        {
            ["id"] = "7c2f9a40-1d3b-4e58-8a6c-0b9e4d5f1a23",
            ["fileNamePattern"] = "index\\.html",
            ["callbackAssembly"] = patcher.Assembly.FullName!,
            ["callbackClass"] = patcher.FullName!,
            ["callbackMethod"] = nameof(IndexHtmlPatcher.PatchIndexHtml)
        });

        method.Invoke(null, new[] { parse.Invoke(null, new object[] { json }) });
        return true;
    }
}
