using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Threading.Tasks;

namespace DojoWallpaper
{
    // Actions natives et commandes hors UI : implementees par la fenetre (UiWindow), simulables en test.
    public interface IBridgeHost
    {
        Task<IDictionary<string, object>> RunSetupAsync(BridgeCall call);
        IDictionary<string, object> PickFile();
        IDictionary<string, object> PickFolder();
        IDictionary<string, object> OpenUrl(string url);
        IDictionary<string, object> CloseWindow();
        IDictionary<string, object> SetTitle(string title);
        IDictionary<string, object> GetEnv();
        IDictionary<string, object> GetAutostart();
        IDictionary<string, object> SetAutostart(bool enabled);
        IDictionary<string, object> ReloadWallpaper();
    }

    // Pont JS <-> C# : routage des messages { id, kind:'cmd' | 'native', ... } et reponses { id, result }.
    // Logique pure : aucune dependance a WinForms ni a WebView2. Ne leve jamais : toute erreur devient { ok:false, error }.
    public sealed class UiBridge
    {
        public const string UiHost = "dojo-ui.local";
        public const string ThemesHost = "dojo-themes.local";
        public const string BackgroundHost = "dojo-bg.local";
        public const int MaxTitleLength = 200;
        public const int MaxUrlLength = 2048;

        // Hotes externes ouvrables (openUrl), en https uniquement.
        public static readonly string[] AllowedUrlHosts =
        {
            "wallhaven.cc", "www.wallhaven.cc", "w.wallhaven.cc", "th.wallhaven.cc",
            "nodejs.org", "www.nodejs.org", "cli.github.com", "github.com", "learn.microsoft.com",
        };

        private readonly IBridgeHost _host;
        private readonly Action<string> _post;

        // post recoit le JSON de la reponse ; il peut etre appele hors du thread UI (la fenetre se charge du marshalling).
        public UiBridge(IBridgeHost host, Action<string> post)
        {
            if (host == null)
            {
                throw new ArgumentNullException("host");
            }
            if (post == null)
            {
                throw new ArgumentNullException("post");
            }
            _host = host;
            _post = post;
        }

        // Vrai pour une URL https://dojo-ui.local/... (pages de l'interface uniquement).
        public static bool IsTrustedUrl(string url)
        {
            Uri uri;
            return !string.IsNullOrEmpty(url)
                && Uri.TryCreate(url, UriKind.Absolute, out uri)
                && uri.Scheme == Uri.UriSchemeHttps
                && string.Equals(uri.Host, UiHost, StringComparison.OrdinalIgnoreCase);
        }

        // URL ouvrable par openUrl : https, sans identifiants, hote de la liste blanche.
        public static Uri ValidateExternalUrl(string url)
        {
            if (string.IsNullOrEmpty(url) || url.Length > MaxUrlLength)
            {
                throw new BridgeRejectedException("URL invalide.");
            }
            Uri uri;
            if (!Uri.TryCreate(url, UriKind.Absolute, out uri))
            {
                throw new BridgeRejectedException("URL invalide.");
            }
            if (uri.Scheme != Uri.UriSchemeHttps)
            {
                throw new BridgeRejectedException("seules les URL https sont ouvertes.");
            }
            if (!string.IsNullOrEmpty(uri.UserInfo))
            {
                throw new BridgeRejectedException("URL avec identifiants refusée.");
            }
            if (Array.IndexOf(AllowedUrlHosts, uri.Host) < 0)
            {
                throw new BridgeRejectedException("hôte non autorisé : " + uri.Host + ".");
            }
            return uri;
        }

        // Traite un message venant de la page 'source'. La tache se termine une fois la reponse postee.
        public async Task HandleAsync(string source, string json)
        {
            IDictionary<string, object> msg = JsonText.ParseObject(json);
            object id = msg == null ? null : Get(msg, "id");
            bool hasId = id is int || id is long;

            if (!IsTrustedUrl(source))
            {
                Post(hasId ? id : null, Fail("source non autorisée."));
                return;
            }
            if (msg == null)
            {
                Post(null, Fail("message invalide."));
                return;
            }
            if (!hasId)
            {
                Post(null, Fail("identifiant de requête manquant."));
                return;
            }

            IDictionary<string, object> result;
            string kind = Get(msg, "kind") as string;
            if (kind == "cmd")
            {
                result = await RunCommandAsync(msg);
            }
            else if (kind == "native")
            {
                result = RunNative(msg);
            }
            else
            {
                result = Fail("type de message inconnu.");
            }
            Post(id, result);
        }

        private async Task<IDictionary<string, object>> RunCommandAsync(IDictionary<string, object> msg)
        {
            try
            {
                string cmd = Get(msg, "cmd") as string;
                IList<string> args = ReadArgs(Get(msg, "args"));
                string stdin = Get(msg, "stdin") as string;
                BridgeCall call = BridgeCommands.Validate(cmd, args, stdin);
                IDictionary<string, object> result = await _host.RunSetupAsync(call);
                return result ?? Fail("réponse vide.");
            }
            catch (BridgeRejectedException ex)
            {
                return Fail(ex.Message);
            }
            catch (Exception ex)
            {
                return Fail("erreur interne : " + ex.Message);
            }
        }

        private IDictionary<string, object> RunNative(IDictionary<string, object> msg)
        {
            string action = Get(msg, "action") as string;
            try
            {
                var payload = Get(msg, "payload") as IDictionary<string, object> ?? new Dictionary<string, object>();
                switch (action)
                {
                    case "pickFile":
                        return _host.PickFile();
                    case "pickFolder":
                        return _host.PickFolder();
                    case "openUrl":
                        Uri uri = ValidateExternalUrl(Get(payload, "url") as string);
                        return _host.OpenUrl(uri.AbsoluteUri);
                    case "close":
                        return _host.CloseWindow();
                    case "setTitle":
                        string title = Get(payload, "title") as string;
                        if (string.IsNullOrWhiteSpace(title) || title.Length > MaxTitleLength)
                        {
                            return Fail("titre invalide (1 à 200 caractères).");
                        }
                        return _host.SetTitle(title);
                    case "getEnv":
                        return _host.GetEnv();
                    case "autostart.get":
                        return _host.GetAutostart();
                    case "autostart.set":
                        object enabled = Get(payload, "enabled");
                        if (!(enabled is bool))
                        {
                            return Fail("valeur booléenne attendue (enabled).");
                        }
                        return _host.SetAutostart((bool)enabled);
                    case "reloadWallpaper":
                        return _host.ReloadWallpaper();
                    default:
                        return Fail("action native inconnue : " + action + ".");
                }
            }
            catch (BridgeRejectedException ex)
            {
                return Fail(ex.Message);
            }
            catch (Exception ex)
            {
                return Fail("erreur interne : " + ex.Message);
            }
        }

        // Arguments JS : chaines, ou entiers (ex. page) convertis en texte. Autres types refuses.
        private static IList<string> ReadArgs(object value)
        {
            var list = new List<string>();
            if (value == null)
            {
                return list;
            }
            var items = value as IList;
            if (items == null || value is string)
            {
                throw new BridgeRejectedException("arguments attendus sous forme de liste.");
            }
            foreach (object item in items)
            {
                if (item is string)
                {
                    list.Add((string)item);
                }
                else if (item is int || item is long)
                {
                    list.Add(Convert.ToString(item, CultureInfo.InvariantCulture));
                }
                else
                {
                    throw new BridgeRejectedException("argument refusé : type non pris en charge.");
                }
            }
            return list;
        }

        private void Post(object id, IDictionary<string, object> result)
        {
            try
            {
                var envelope = new Dictionary<string, object> { { "id", id }, { "result", result } };
                _post(JsonText.Serialize(envelope));
            }
            catch (Exception)
            {
                // Fenetre fermee ou message non postable : rien a faire de plus.
            }
        }

        private static IDictionary<string, object> Fail(string message)
        {
            return new Dictionary<string, object> { { "ok", false }, { "error", message } };
        }

        private static object Get(IDictionary<string, object> dict, string key)
        {
            object value;
            return dict != null && dict.TryGetValue(key, out value) ? value : null;
        }
    }
}
