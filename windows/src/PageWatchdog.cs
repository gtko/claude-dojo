using System;

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

        private readonly Func<long> clock;
        private long lastBeat;
        private long lastReload;
        private bool reloaded;
        private int recreations;
        private long lastRecreate;

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
    }
}
