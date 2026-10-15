using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;

namespace DojoWallpaper
{
    // Page de l'interface (fenetre generique UiWindow) : fichier dans windows\ui, titre, tailles en DIP.
    public sealed class UiPage
    {
        public UiPage(string key, string file, string title, Size size, Size minSize)
        {
            Key = key;
            File = file;
            Title = title;
            Size = size;
            MinSize = minSize;
        }

        // Nom court (argument --open) ; File = nom du fichier HTML.
        public string Key { get; private set; }
        public string File { get; private set; }
        public string Title { get; private set; }
        // Tailles en DIP (unites independantes du DPI, comme les pixels CSS de la page) : UiLayout.ToPixels les convertit.
        public Size Size { get; private set; }
        public Size MinSize { get; private set; }
    }

    // Pages de l'interface et emplacements des dossiers (install, interface).
    public static class UiLayout
    {
        // DPI de reference (100 %) : 1 DIP = 1 pixel a 96 DPI.
        public const int BaseDpi = 96;

        public static readonly UiPage[] Pages =
        {
            new UiPage("themes", "themes.html", "Thème et fond", new Size(980, 720), new Size(760, 560)),
            new UiPage("gallery", "gallery.html", "Galerie de fonds", new Size(900, 640), new Size(640, 480)),
            new UiPage("wizard", "wizard.html", "Assistant de configuration", new Size(760, 640), new Size(680, 560)),
        };

        // Pixels reels d'une dimension en DIP pour un DPI donne (120 DPI = 125 %). Arrondi au pixel le plus proche
        // (demi vers le haut). DPI nul ou negatif : traite comme 96.
        public static int ToPixels(int dip, int dpi)
        {
            int effective = dpi > 0 ? dpi : BaseDpi;
            return (int)Math.Round(dip * (double)effective / BaseDpi, MidpointRounding.AwayFromZero);
        }

        public static Size ToPixels(Size dip, int dpi)
        {
            return new Size(ToPixels(dip.Width, dpi), ToPixels(dip.Height, dpi));
        }

        // Page par nom court (« themes », « gallery », « wizard »), ou null.
        public static UiPage Find(string key)
        {
            if (string.IsNullOrEmpty(key))
            {
                return null;
            }
            foreach (UiPage page in Pages)
            {
                if (string.Equals(page.Key, key, StringComparison.Ordinal))
                {
                    return page;
                }
            }
            return null;
        }

        // Dossier d'installation, comme setup.js (paths.dojo() = %USERPROFILE%\.config\claude-dojo).
        public static string InstallDir()
        {
            string profile = Environment.GetEnvironmentVariable("USERPROFILE");
            if (string.IsNullOrEmpty(profile))
            {
                profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            }
            return InstallDirFor(profile);
        }

        public static string InstallDirFor(string userProfile)
        {
            return Path.Combine(userProfile, ".config", "claude-dojo");
        }

        public static string SetupScriptFor(string installDir)
        {
            return Path.Combine(installDir, NodeRunner.SetupScript);
        }

        // Dossier windows\ui : a cote de bin\ (installation : windows\bin\DojoWallpaper.exe), ou depuis
        // build\Release\net48\ (developpement). Le premier candidat contenant common.css l'emporte.
        public static string UiDirFrom(string baseDirectory)
        {
            string[] candidates =
            {
                Path.Combine(baseDirectory, "..", "ui"),
                Path.Combine(baseDirectory, "..", "..", "..", "ui"),
            };
            foreach (string candidate in candidates)
            {
                string full = Path.GetFullPath(candidate);
                if (File.Exists(Path.Combine(full, "common.css")))
                {
                    return full;
                }
            }
            return Path.GetFullPath(candidates[0]);
        }

        public static string BackgroundsDirFor(string installDir)
        {
            return Path.Combine(installDir, "backgrounds");
        }

        public static string ThemesDirFor(string installDir)
        {
            return Path.Combine(installDir, "themes");
        }
    }
}
