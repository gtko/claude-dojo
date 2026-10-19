using System;
using System.Text.RegularExpressions;

namespace DojoWallpaper
{
    // Decisions du chien de garde de la page du fond (logique pure, horloge injectee : testable sans WebView2).
    // Thread UI uniquement.
    internal sealed class PageWatchdog
    {
        // Silence maximal entre deux battements de la page avant de la sonder.
        public const long SilenceMs = 20000;
        // Anti-rebond : au plus un rechargement automatique par intervalle de cette duree.
        public const long CooldownMs = 10000;
        // Recreations consecutives : ecart minimal de RecreateBaseMs apres la 1re, double a chaque suivante, plafonne.
        public const long RecreateBaseMs = 20000;
        public const long RecreateMaxMs = 300000;
        // Messages de la page (window.chrome.webview.postMessage) : battement et erreur JS.
        public const string AliveMessage = "dojo:alive";
        public const string ErrorPrefix = "dojo:error:";
        public const int ErrorMaxChars = 300;
        // Sonde du script de la page : "true" = script entierement execute (battement arme), "false" = script arrete.
        public const string ReadyProbe = "window.__dojoReady === true";
        // Rechargements pour script arrete : au-dela de ScriptFreeReloads consecutifs, au plus un par ScriptReloadGapMs.
        public const int ScriptFreeReloads = 3;
        public const long ScriptReloadGapMs = 60000;

        private static readonly Regex LineBreaks = new Regex(@"\s*[\r\n]+\s*");
        // Query string d'une URL (jetons possibles) : masquee, comme DojoLog.Redact pour les URL de navigation.
        private static readonly Regex UrlQuery = new Regex("(https?://[^\\s?#'\"<>]*)\\?[^\\s'\"<>]*");

        private readonly Func<long> clock;
        private long lastBeat;
        private long lastReload;
        private bool reloaded;
        private int recreations;
        private long lastRecreate;
        private int scriptReloads;
        private long lastScriptReload;

        // clock : temps monotone, en millisecondes.
        public PageWatchdog(Func<long> clock)
        {
            if (clock == null)
            {
                throw new ArgumentNullException("clock");
            }
            this.clock = clock;
            lastBeat = clock();
        }

        // Nombre de recreations consecutives sans NavigationCompleted reussi.
        public int Recreations
        {
            get { return recreations; }
        }

        // Remet l'horloge a zero : battement recu, navigation lancee ou reussie, reprise d'une page suspendue.
        public void Reset()
        {
            lastBeat = clock();
        }

        // Vrai si aucun battement depuis SilenceMs.
        public bool IsSilent()
        {
            return clock() - lastBeat >= SilenceMs;
        }

        // Decision : la page doit-elle etre sondee ? Chargee, pas en pause, et muette depuis SilenceMs.
        public bool SilenceDue(bool pageLoaded, bool paused)
        {
            return pageLoaded && !paused && IsSilent();
        }

        // Vrai si un rechargement automatique est permis maintenant. L'autorisation est consommee : l'appelant recharge.
        public bool TryReload()
        {
            long now = clock();
            if (reloaded && now - lastReload < CooldownMs)
            {
                return false;
            }
            reloaded = true;
            lastReload = now;
            return true;
        }

        // Ecart minimal avant la recreation suivante : 20 s apres la 1re, 40 s apres la 2e, 80 s... plafonne.
        public long RecreateGapMs()
        {
            long gap = RecreateBaseMs;
            for (int i = 1; i < recreations && gap < RecreateMaxMs; i++)
            {
                gap *= 2;
            }
            return Math.Min(gap, RecreateMaxMs);
        }

        // Vrai si une recreation du controle est permise maintenant ; la 1re est immediate. Consomme l'autorisation.
        public bool TryRecreate()
        {
            long now = clock();
            if (recreations > 0 && now - lastRecreate < RecreateGapMs())
            {
                return false;
            }
            recreations++;
            lastRecreate = now;
            return true;
        }

        // Navigation reussie : la page repond, le backoff des recreations repart de zero.
        public void ResetRecreateBackoff()
        {
            recreations = 0;
        }

        // Resultat de la sonde de script (Verdict).
        public enum ProbeVerdict
        {
            // Pas de reponse dans le delai : page muette (rechargement, anti-rebond).
            Silent,
            // Reponse : page vivante (silence remis a zero).
            Alive,
            // Page du dojo qui s'est annoncee, script arrete : rechargement (backoff TryScriptReload).
            ScriptStopped
        }

        // Verdict de la sonde. answered : reponse dans le delai ; json : son resultat ; dojoPage : la page s'est annoncee
        // (battement ou erreur dojo:) pendant cette navigation. Sans cela (URL personnalisee, autre page), un "false"
        // ne prouve rien : la page est jugee vivante, comme avant la sonde de script.
        public static ProbeVerdict Verdict(bool answered, string json, bool dojoPage)
        {
            if (!answered)
            {
                return ProbeVerdict.Silent;
            }
            if (dojoPage && string.Equals(json, "false", StringComparison.Ordinal))
            {
                return ProbeVerdict.ScriptStopped;
            }
            return ProbeVerdict.Alive;
        }

        // Rechargement pour script arrete : anti-rebond de CooldownMs ; apres ScriptFreeReloads rechargements consecutifs
        // (sans battement), au plus un par ScriptReloadGapMs. Consomme l'autorisation : l'appelant recharge.
        public bool TryScriptReload()
        {
            long now = clock();
            if (scriptReloads >= ScriptFreeReloads && now - lastScriptReload < ScriptReloadGapMs)
            {
                return false;
            }
            if (!TryReload())
            {
                return false;
            }
            scriptReloads++;
            lastScriptReload = now;
            return true;
        }

        // Battement recu : la page tourne, les rechargements pour script arrete repartent de zero.
        public void ResetScriptBackoff()
        {
            scriptReloads = 0;
        }

        // Texte d'un message "dojo:error:..." : retours a la ligne remplaces, query des URL masquee, tronque.
        // Null si le message n'est pas une erreur de la page.
        public static string PageError(string message)
        {
            if (message == null || !message.StartsWith(ErrorPrefix, StringComparison.Ordinal))
            {
                return null;
            }
            string text = LineBreaks.Replace(message.Substring(ErrorPrefix.Length), " ").Trim();
            text = UrlQuery.Replace(text, "$1?...");
            return text.Length > ErrorMaxChars ? text.Substring(0, ErrorMaxChars) : text;
        }
    }
}
