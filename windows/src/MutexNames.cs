using System;
using System.Text.RegularExpressions;

namespace DojoWallpaper
{
    // Nom du mutex d'instance unique. Sans suffixe : une seule instance pour toute la machine (Global\).
    // DOJO_INSTANCE, si valide, ajoute un suffixe : une instance de demonstration peut tourner a cote de la reelle.
    public static class MutexNames
    {
        public const string InstanceVariable = "DOJO_INSTANCE";
        public const string BaseName = @"Global\DojoWallpaper";

        // \A et \z (et non ^ et $) : $ accepterait un saut de ligne final.
        private static readonly Regex SuffixRe = new Regex(@"\A[A-Za-z0-9_-]{1,32}\z");

        // Lit DOJO_INSTANCE puis applique Resolve.
        public static string FromEnvironment()
        {
            return Resolve(Environment.GetEnvironmentVariable(InstanceVariable));
        }

        // Fonction pure (aucun acces a l'environnement). Absent, vide ou invalide : nom de base.
        // Sinon : Global\DojoWallpaper-<valeur>.
        public static string Resolve(string value)
        {
            if (!IsValidSuffix(value))
            {
                return BaseName;
            }
            return BaseName + "-" + value;
        }

        // Suffixe : 1 a 32 caracteres parmi A-Z a-z 0-9 _ -.
        public static bool IsValidSuffix(string value)
        {
            return value != null && SuffixRe.IsMatch(value);
        }

        // Dossier WebView2 (sous %LOCALAPPDATA%\DojoWallpaper) : "webview2", ou "webview2-<suffixe>" si DOJO_INSTANCE
        // est valide. Sans cela, une instance de demonstration rejoint le processus navigateur de l'instance reelle.
        public static string WebView2Folder(string value)
        {
            return IsValidSuffix(value) ? "webview2-" + value : "webview2";
        }
    }
}
